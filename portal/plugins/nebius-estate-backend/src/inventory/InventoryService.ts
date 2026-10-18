import { readFileSync } from 'fs';
import { resolve } from 'path';
import { LoggerService } from '@backstage/backend-plugin-api';
import { CapabilityState, CapabilityStatus, ConnectorStatus, findOrphanCandidates, fmtUtc, GpuTelemetryView, HealthStats, inventoryErrorLine, lastImportNote, ObservedResource, wholeMinutesSince } from '@internal/nebius-domain';
import { EstateConfig } from '../lib/config';
import { FetchFn, HostLimiter, HttpClient, inBackgroundSync, MAX_TELEMETRY_RESPONSE_BYTES, redact } from '../lib/http';
import { CALCULATOR_PATH, NebiusCalculator } from '../commercial/calculator';
import { worst } from './contract';
import { KubernetesConnector, nodeHttpsFetch } from './kubernetes';
import { AGENT_SOURCE, mergeGpus, MONITORING_PATHS, NebiusMonitoringConnector } from './monitoring';
import { caFingerprint, clusterStateNote, DiscoveredCluster, mk8sOrigin } from './mk8s';
import { CATALOG } from './nebius-catalog';
import { CapacitySnapshot, emptyCapacity, EnvTokenProvider, hintFor, NEBIUS_AUTH, NebiusInventoryConnector, NebiusInventoryResult, ServiceAccountTokenProvider, TokenProvider } from './nebius';
import { PrometheusConnector } from './prometheus';
import { CACHED, connectorStateFromHealth, HealthStore, RunRow } from '../health/HealthStore';
import { BillingExportPuller } from '../billing/exportPull';
import { EstateSnapshot, KubeCluster } from './types';
import { SyncExtension } from './extension';
import { FAST_SYNC_LISTS, FastSync, MANUAL_SYNC_COOLDOWN_MS, transitionalResources } from './fastSync';
import { LateRunDeps, LateRunGuard, tcpReachable } from './lateRun';

/** What the connectors of one deployment cover: scope labels only, no credentials. */
interface ConnectorSetup {
  /** Configured Nebius projects; undefined when the inventory connector is not configured. */
  nebiusProjects?: string[];
  syncIntervalMinutes: number;
  kubernetes: { name: string; namespaces?: string[] }[];
  /** Telemetry scope (the Prometheus host); undefined when not configured. */
  prometheus?: string;
  monitoring?: boolean;
  pricing?: boolean;
  /** Export bucket pull configured (variable names in config). */
  billingExport?: boolean;
  /** MK8s clusters of the configured projects are discovered and connected automatically. */
  mk8sDiscovery?: boolean;
}

/** Shown while no Kubernetes cluster is configured or discovered: neutral, not a gap. */
export function kubernetesPlaceholder(discovery: boolean): ConnectorStatus {
  return {
    id: 'kubernetes', title: 'Kubernetes workloads (optional)', state: 'optional', scope: '—', permissions: discovery ? 'the portal’s Nebius identity (group nebius:viewer on the cluster)' : 'read-only ClusterRole on a configured cluster',
    services: ['namespaces', 'deployments', 'statefulsets', 'jobs', 'pods', 'events', 'nodes'], staleAfterMinutes: 0,
    missingCoverage: [
      discovery
        ? 'Needs a Managed Kubernetes cluster: none is RUNNING in the configured projects. A cluster is found and connected automatically once it exists; GPU telemetry already comes from Nebius Monitoring.'
        : 'Needs a Managed Kubernetes cluster (nebiusEstate.kubernetes.clusters); GPU telemetry already comes from Nebius Monitoring.',
    ],
    setup: 'docs/portal/nebius-setup.md#kubernetes',
  };
}

/** The connectors this portal runs, as they stand before their first sync: `starting` (first sync pending), never `stale`. */
export function connectorDefinitions(s: ConnectorSetup): ConnectorStatus[] {
  return [
    {
      id: 'nebius-inventory', title: 'Nebius inventory (REST API)', state: s.nebiusProjects ? 'starting' : 'not-configured',
      scope: s.nebiusProjects ? `${s.nebiusProjects.length} project${s.nebiusProjects.length === 1 ? '' : 's'}` : '—',
      projects: s.nebiusProjects?.map(id => ({ id })), permissions: 'viewer on each listed project', services: ['iam', 'compute', 'mk8s', 'vpc', 'storage'],
      // Filled from the capability states after each sync (what this identity could not read).
      staleAfterMinutes: s.syncIntervalMinutes * 3, missingCoverage: [], setup: 'docs/portal/nebius-setup.md',
    },
    ...s.kubernetes.map(k => ({
      id: `kubernetes:${k.name}`, title: `Kubernetes — ${k.name}`, state: 'starting' as const,
      scope: k.namespaces?.length ? `namespaces: ${k.namespaces.join(', ')}` : 'all namespaces', permissions: 'read-only ClusterRole',
      services: ['namespaces', 'deployments', 'statefulsets', 'jobs', 'pods', 'events', 'nodes'], staleAfterMinutes: 30,
      missingCoverage: ['Slurm queue and accounting'], setup: 'docs/portal/nebius-setup.md#kubernetes',
    })),
    // Optional connectors: they need a Managed Kubernetes cluster this deployment may not run.
    ...(s.kubernetes.length ? [] : [kubernetesPlaceholder(Boolean(s.mk8sDiscovery && s.nebiusProjects))]),
    {
      // Unset is complete, not a gap: Nebius Monitoring already supplies GPU telemetry.
      id: 'prometheus', title: 'External Prometheus', state: s.prometheus ? 'starting' : 'not-needed',
      scope: s.prometheus ?? '—', permissions: 'network reach to the configured endpoint', services: ['DCGM_FI_DEV_GPU_UTIL'], staleAfterMinutes: 15,
      missingCoverage: s.prometheus
        ? ['GPUs without dcgm-exporter (standalone VMs)']
        : ['GPU telemetry already comes from Nebius Monitoring (official endpoint, all listed projects). Set this only for a Prometheus you run outside Nebius.'],
      setup: 'docs/portal/nebius-setup.md#telemetry',
    },
    {
      id: 'nebius-monitoring', title: 'GPU telemetry (Nebius Monitoring)', state: s.nebiusProjects && s.monitoring ? 'starting' : 'not-configured',
      scope: s.nebiusProjects && s.monitoring ? `${s.nebiusProjects.length} project${s.nebiusProjects.length === 1 ? '' : 's'}` : '—', projects: s.monitoring ? s.nebiusProjects?.map(id => ({ id })) : undefined,
      permissions: 'viewer on each listed project', services: ['DCGM GPU utilisation, temperature, power, memory (VMs)'], staleAfterMinutes: s.syncIntervalMinutes * 3,
      missingCoverage: ['GPUs inside Kubernetes pods are attributed to their node VM only'], setup: 'docs/portal/nebius-setup.md#telemetry',
    },
    {
      id: 'nebius-pricing', title: 'Live list prices (Nebius billing calculator)', state: s.nebiusProjects && s.pricing ? 'starting' : 'not-configured',
      scope: s.pricing ? 'list prices; contract prices when the billing group is readable' : '—', permissions: 'viewer on a listed project (contract prices: resource.billinggroup.get)',
      services: ['billing.v1 Calculator/EstimateBatch'], staleAfterMinutes: 0, missingCoverage: ['usage-based SKUs (Object Storage) are not priced per hour'], setup: 'docs/portal/billing-and-pricing.md#live-list-prices',
    },
    {
      id: 'billing-object-storage', title: 'Billing export pull (Object Storage)', state: s.billingExport ? 'starting' : 'not-configured', scope: '—',
      permissions: 'read access to the export bucket (an access key of a service account allowed to read it)', services: ['FOCUS 1.2 CSV (.csv, .csv.gz)'], staleAfterMinutes: s.syncIntervalMinutes * 3,
      missingCoverage: s.billingExport ? [] : ['Not configured: imports come from manual CSV uploads only'], setup: 'docs/portal/billing-and-pricing.md#billing-export-pull',
    },
  ];
}

/**
 * Holds the latest snapshot of every connector and its status. A failed sync
 * keeps the previous data and marks it stale; it never blanks the page or
 * substitutes zeros. A connector that is not configured stays
 * `not-configured` and is never called.
 */
export class InventoryService {
  private snap: EstateSnapshot = { resources: [], coverage: [], kube: [], statuses: [], capabilities: [], capacity: emptyCapacity() };
  /** One limiter per host, shared by every client of that host. */
  private readonly limiters = new Map<string, HostLimiter>();
  private calc?: NebiusCalculator;
  private readonly statuses = new Map<string, ConnectorStatus>();
  private running?: Promise<void>;
  private inventorySyncs = 0;

  constructor(private readonly cfg: EstateConfig, private readonly logger: LoggerService) {}

  /** The clock every TTL, freshness and estimate computation uses. */
  now(): Date {
    return new Date();
  }

  snapshot(): EstateSnapshot {
    const now = this.now().getTime();
    // Connectors list projects by id; names come from the latest inventory, the same for every connector.
    const projectNames = new Map(this.snap.resources.filter(r => r.type === 'project').map(r => [r.providerId, r.name]));
    const fast = this.fast?.status();
    const statuses = [...this.statuses.values()].map(st => {
      const s0 = st.projects ? { ...st, projects: st.projects.map(p => ({ id: p.id, name: projectNames.get(p.id) ?? p.name })) } : st;
      const inventoryNotes = s0.id === 'nebius-inventory' ? [...(fast?.capped ? [this.cappedNote(fast.capped)] : []), ...(this.deferredNote ? [this.deferredNote] : [])] : [];
      const s = inventoryNotes.length ? { ...s0, notes: [...(s0.notes ?? []), ...inventoryNotes] } : s0;
      // A connector that is not set up, optional or not needed has no current health: older runs (from when it
      // was configured) would only read as failures.
      const health = ['not-configured', 'optional', 'not-needed'].includes(s.state) ? undefined : this.health.connectors.get(s.id);
      // Answers now, but under 90 % of its runs succeeded in 24 h: "degraded", not "ok".
      const withHealth = health ? { ...s, health: { ...health, ...this.nextRun(s.id, fast) }, state: connectorStateFromHealth(s.state, health) } : s;
      if (!s.lastSuccess) return withHealth;
      const freshnessMinutes = wholeMinutesSince(s.lastSuccess, new Date(now)) ?? 0;
      const stale = s.state === 'ok' && s.staleAfterMinutes > 0 && freshnessMinutes > s.staleAfterMinutes;
      return { ...withHealth, freshnessMinutes, state: stale ? 'stale' : withHealth.state };
    });
    const capabilities = this.snap.capabilities.map(c => {
      // As for connectors: a capability not set up now (no cluster for node groups) has no current health.
      const health = c.state === 'not-configured' ? undefined : this.health.capabilities.get(c.id);
      return health ? { ...c, health: { ...health, nextRunAt: this.nextRunAt } } : c;
    });
    return { ...this.snap, resources: linkNodeGroups(this.snap.resources, this.snap.kube), statuses, capabilities };
  }

  /* ------------------------------------------------------------- health */

  private healthStore?: HealthStore;
  private health = { connectors: new Map<string, HealthStats>(), capabilities: new Map<string, HealthStats>() };
  private readonly started = new Map<string, number>();
  private readonly finished = new Map<string, number>();
  private nextRunAt?: string;
  private firstSync?: Promise<void>;

  private exportPuller?: BillingExportPuller;
  private exportFetch?: FetchFn;

  /** Enables the billing export pull (the puller imports through the commercial store). */
  useBillingExport(puller: BillingExportPuller, fetchFn?: FetchFn) {
    this.exportPuller = puller;
    this.exportFetch = fetchFn;
  }

  private async syncBillingExport(attempt: string, only?: string) {
    const x = this.cfg.billing.export;
    if (!x || !this.exportPuller || (only && only !== 'billing-object-storage')) return;
    this.mark('billing-object-storage', { lastAttempt: attempt });
    const env = process.env;
    const bucket = env[x.bucketEnv];
    const region = env[x.regionEnv];
    const missing = [x.bucketEnv, x.regionEnv, x.accessKeyIdEnv, x.secretAccessKeyEnv].filter(name => !env[name]);
    const base = { id: 'billing.export.objects', title: 'Billing export files (Object Storage, ListObjectsV2 + GetObject)', service: 'storage', connector: 'billing-object-storage' as const, scope: 'tenant' as const, method: 'GET' as const };
    if (missing.length || !bucket || !region || !/^[a-z]{2}-[a-z]+\d$/.test(region)) {
      const error = missing.length ? `needs ${missing.length} environment variable${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}` : `${x.regionEnv} is not a region (e.g. eu-west2)`;
      // Missing settings are "not set up" (optional), not a failing sync: no red row, no failure streak.
      this.mark('billing-object-storage', missing.length ? { state: 'not-configured', error } : { state: 'error', error });
      this.snap.capabilities = this.mergeCapabilities([{ ...base, path: '/<bucket>?list-type=2', state: 'not-configured', lastAttempt: attempt, hint: error }]);
      return;
    }
    const endpoint = x.endpoint ?? `https://storage.${region}.nebius.cloud`;
    const r = await this.exportPuller.sync(
      { bucket, region, prefix: (x.prefixEnv && env[x.prefixEnv]) || '', endpoint, accessKeyId: env[x.accessKeyIdEnv]!, secretAccessKey: env[x.secretAccessKeyEnv]!, maxBytes: this.cfg.billing.maxImportBytes },
      { fetch: this.exportFetch, limiter: this.limiter(endpoint), timeoutMs: this.cfg.nebius?.timeoutMs ?? 15_000 },
    );
    const state = r.listError ? r.listError.state : r.failed.length ? 'schema-drift' : 'ok';
    const empty = !r.listError && r.listed === 0;
    const hint = r.listError
      ? hintFor(r.listError.state, `read access to the bucket for the access key in ${x.accessKeyIdEnv}`)
      : empty
        ? `No export files yet: enable Billing → Export → Periodic export to ${bucket} in the Nebius console.`
        : r.failed.length
          ? `${r.failed.length} file(s) could not be imported (each is retried when it changes).`
          : undefined;
    this.snap.capabilities = this.mergeCapabilities([
      {
        ...base, path: `/${bucket}?list-type=2`, state, items: r.listed, latencyMs: r.latencyMs, lastAttempt: attempt,
        lastSuccess: r.listError ? undefined : attempt, lastError: r.listError?.message ?? r.failed[0]?.error, hint,
        drift: r.failed.map(f => `${f.key}: ${f.error}`).slice(0, 10),
      },
    ]);
    this.mark('billing-object-storage', {
      scope: `${bucket} (${region})`,
      state: r.listError ? (r.listError.state === 'permission-denied' ? 'permission-denied' : 'error') : 'ok',
      lastSuccess: r.listError ? this.statuses.get('billing-object-storage')?.lastSuccess : attempt,
      error: r.listError?.message ?? (r.failed.length ? `${r.failed.length} file(s) failed: ${r.failed[0].key}: ${r.failed[0].error}` : undefined),
      // An import is information, not a gap (#5): a note naming the file and month, never the key's id folders (#6);
      // the newest import comes from the database, so a sync with nothing new, or a restart, still names it.
      missingCoverage: empty ? [hint!] : [],
      ...(r.imported.length || r.lastImport ? { notes: [lastImportNote(r.imported.length ? r.imported : [r.lastImport!])!] } : {}),
    });
  }

  private readonly extensions: SyncExtension[] = [];

  /** Adds connectors that run on this sync loop (see SyncExtension); call before start(). */
  useExtension(x: SyncExtension) {
    this.extensions.push(x);
  }

  private async syncExtension(x: SyncExtension, attempt: string, only?: string) {
    const ids = x.definitions().map(d => d.id).filter(id => !only || only === id);
    if (!ids.length) return;
    for (const id of ids) this.mark(id, { lastAttempt: attempt });
    try {
      const r = await x.sync(attempt, only);
      for (const { id, durationMs, ...patch } of r.statuses) {
        this.mark(id, { state: 'ok', ...patch });
        // Each connector's own run time, so two connectors of one extension never share one latency (G1.7).
        const t0 = this.started.get(id);
        if (durationMs !== undefined && t0 !== undefined) this.finished.set(id, t0 + durationMs);
      }
      this.snap.capabilities = this.mergeCapabilities(r.capabilities);
      // A connector the extension ran but returned nothing for did not finish.
      const returned = new Set(r.statuses.map(st => st.id));
      for (const id of ids.filter(i => !returned.has(i) && this.statuses.get(i)?.running)) this.mark(id, { state: 'error', error: 'The sync returned no result for this connector.' });
    } catch (e) {
      const error = redact((e as Error).message);
      for (const id of ids) this.mark(id, { state: 'error', error });
    }
  }

  /** Records every run in the portal database and derives health from it. */
  useHealthStore(store: HealthStore) {
    this.healthStore = store;
  }

  /**
   * The scheduler's cadence, for "next run" (the first scheduled run follows `initialDelayMs`), and the late-run
   * guard of runScheduled (probe, clock and sleep overridable for tests).
   */
  setSchedule(intervalMs: number, initialDelayMs: number, lateRun: Partial<Omit<LateRunDeps, 'intervalMs'>> = {}) {
    this.scheduleMs = intervalMs;
    this.nextRunAt = new Date(Date.now() + initialDelayMs).toISOString();
    const n = this.cfg.nebius;
    if (n?.projects.length) {
      const api = n.apiEndpoint;
      this.lateRun = new LateRunGuard({ intervalMs, probe: () => tcpReachable(api), ...lateRun });
    }
    if (!this.fast && n?.projects.length && n.fastSyncSeconds > 0) {
      this.fast = new FastSync({
        intervalMs: n.fastSyncSeconds * 1000, max: n.fastSyncMax, cooldownMs: MANUAL_SYNC_COOLDOWN_MS, logger: this.logger,
        run: () => this.syncAll(undefined, { fast: true }),
        lastAttemptAt: () => {
          const at = this.statuses.get('nebius-inventory')?.lastAttempt;
          return at ? Date.parse(at) : undefined;
        },
      });
    }
  }

  private scheduleMs?: number;

  /** Lifecycle-aware fast re-sync (fastSync.ts); armed by setSchedule, i.e. only where a scheduled task runs. */
  private fast?: FastSync;

  /** Next run of one connector: a pending fast re-sync of the connectors it runs (inventory, discovered clusters), and why. */
  private nextRun(id: string, fast = this.fast?.status()): { nextRunAt?: string; nextRunReason?: string } {
    if (!fast?.reason || (id !== 'nebius-inventory' && !id.startsWith('mk8s:'))) return { nextRunAt: this.nextRunAt };
    const sooner = fast.dueAt && (!this.nextRunAt || fast.dueAt < this.nextRunAt);
    return { nextRunAt: sooner ? fast.dueAt : this.nextRunAt, nextRunReason: fast.reason };
  }

  private cappedNote(c: { after: number; reason: string }): string {
    return `Fast re-sync paused after ${c.after} syncs in a row while ${c.reason}; back to the normal cadence (every ${Math.round((this.scheduleMs ?? 0) / 60_000)} min) until nothing is changing state.`;
  }

  /** Disarms the fast re-sync timer only; syncs still run (scheduled, "Sync now"). */
  stopFastResync() {
    this.fast?.stop();
  }

  /** Fired by stop(): ends the running sync's calls and refuses new syncs (plugin shutdown). */
  private readonly stopping = new AbortController();

  /**
   * Plugin shutdown: stops the fast re-sync timer, ends a running sync (its calls are aborted and its back-off waits
   * cut short, so it does not retry on for its 30 s connect budget) and waits for it, so nothing writes to the
   * database after the backend has closed it. A run cut short this way is not recorded as a failure.
   */
  async stop(): Promise<void> {
    this.stopFastResync();
    this.stopping.abort();
    await this.running?.catch(() => undefined);
  }

  /** Called by the scheduled task at the start of each run. */
  scheduledRunStarted() {
    if (this.scheduleMs) this.nextRunAt = new Date(Date.now() + this.scheduleMs).toISOString();
  }

  private lateRun?: LateRunGuard;
  /** Set while the last scheduled run was deferred (F1.45); shown on the inventory connector. */
  private deferredNote?: string;

  /**
   * The scheduled task: a run that starts more than twice its interval late (the host slept) waits for the API,
   * and is deferred when it stays unreachable (LateRunGuard), so a wake-up never records a sync of failed calls.
   * Resolves whether it synced.
   */
  async runScheduled(): Promise<boolean> {
    this.scheduledRunStarted();
    const check = await this.lateRun?.check();
    if (check && !check.run) {
      this.deferredNote = check.reason;
      this.logger.warn(`nebius-estate: ${check.reason}`);
      return false;
    }
    this.deferredNote = undefined;
    if (check?.late) this.logger.info(`nebius-estate: scheduled sync ${Math.round(check.lateByMs / 60_000)} min late${check.reason ? `; ${check.reason}` : ''}`);
    await this.syncAll();
    return !this.stopped;
  }

  /** True once stop() was called (plugin shutdown): no sync runs and nothing more is written. */
  get stopped(): boolean {
    return this.stopping.signal.aborted;
  }

  private nebiusRun?: Promise<void>;

  /**
   * Resolves when the Nebius inventory part of the running sync has finished (at once when none runs):
   * for an extension that needs this sync's projects (the audit reader needs their regions). It never
   * waits on extensions, so an extension may await it.
   */
  inventorySettled(): Promise<void> {
    return this.nebiusRun ?? Promise.resolve();
  }

  /** Resolves when the first sync after start() has finished. */
  ready(): Promise<void> {
    return this.firstSync ?? Promise.resolve();
  }

  isRunning(): { since: string } | undefined {
    return this.runningSince ? { since: this.runningSince } : undefined;
  }

  private runningSince?: string;
  /** Capabilities whose last answer came from a cache (the calculator caches per spec and project). */
  private cachedAnswers = new Set<string>();
  private lastProbe?: { key: string; at: number };

  private async recordRuns(attempt: string) {
    const rows: RunRow[] = [];
    for (const st of this.statuses.values()) {
      if (st.lastAttempt !== attempt) continue;
      const t0 = this.started.get(st.id);
      const t1 = this.finished.get(st.id) ?? performance.now();
      // A connector whose calls did not all answer ("degraded") failed this run, as an error does; refusals answered.
      const ok = st.state === 'ok' || st.state === 'permission-denied';
      rows.push({ kind: 'connector', subject: st.id, at: attempt, durationMs: t0 === undefined ? 0 : t1 - t0, ok, errorClass: st.state === 'ok' ? undefined : st.state === 'permission-denied' ? 'partial' : st.state, items: st.id === 'nebius-inventory' ? this.snap.resources.filter(x => x.source.connector === 'nebius-inventory').length : undefined });
    }
    for (const c of this.snap.capabilities) {
      if (!c.lastAttempt || c.lastAttempt < attempt) continue;
      // The cluster agent's series answer 404 until the agent writes them: waiting, not a failure.
      // A cached answer made no call: a success, but no latency figure (healthOf leaves it out of the percentiles).
      const cached = c.state === 'ok' && (this.cachedAnswers.has(c.id) || c.latencyMs === undefined);
      const errorClass = cached ? CACHED : c.state === 'ok' ? undefined : c.id === 'monitoring.cluster-gpu' && c.state === 'not-found' ? 'waiting' : c.state;
      rows.push({ kind: 'capability', subject: c.id, at: c.lastAttempt, durationMs: c.latencyMs ?? 0, ok: c.state === 'ok' || c.state === 'schema-drift', errorClass, items: c.items });
    }
    if (!this.healthStore) return;
    try {
      await this.healthStore.record(rows);
      const now = new Date();
      const [connectors, capabilities] = await Promise.all([this.healthStore.stats('connector', now), this.healthStore.stats('capability', now)]);
      this.health = { connectors, capabilities };
    } catch (e) {
      this.logger.warn(`nebius-estate: could not record sync runs: ${redact((e as Error).message)}`);
    }
  }

  async start(): Promise<void> {
    const projects = this.cfg.nebius?.projects.map(p => p.id) ?? [];
    const definitions = connectorDefinitions({
      nebiusProjects: projects.length ? projects : undefined,
      syncIntervalMinutes: this.cfg.nebius?.syncIntervalMinutes ?? 15,
      kubernetes: this.cfg.kubernetes,
      prometheus: this.cfg.prometheus && new URL(this.cfg.prometheus.url).host,
      monitoring: this.cfg.nebius?.monitoring.enabled,
      pricing: this.cfg.nebius?.pricing.enabled,
      billingExport: Boolean(this.cfg.billing.export),
      mk8sDiscovery: this.cfg.nebius?.mk8s.discover,
    });
    for (const d of definitions) this.statuses.set(d.id, d);
    for (const d of this.extensions.flatMap(x => x.definitions())) this.statuses.set(d.id, d);
    if (!projects.length) this.logger.info('nebius-estate: no Nebius projects configured; the inventory connector is not configured (docs/portal/nebius-setup.md)');
    // The first sync runs in the background: plugin start-up never waits on the cloud.
    this.firstSync = this.syncAll().catch(e => this.logger.warn(`nebius-estate: first sync failed: ${redact((e as Error).message)}`));
  }

  /** Kept across syncs so a service-account token is reused until it nears expiry. */
  private tokens?: TokenProvider;

  private tokenProvider(): TokenProvider | undefined {
    this.tokens ??= this.createTokenProvider();
    return this.tokens;
  }

  /**
   * A read-only service account when its variables are set (the private key
   * from a PEM file, or inline), else a short-lived IAM token from the
   * environment. Credentials are read here, on the backend, and nowhere else.
   */
  private createTokenProvider(): TokenProvider | undefined {
    const auth = this.cfg.nebius?.auth;
    if (!auth) return undefined;
    const env = process.env;
    const sa = auth.serviceAccount;
    if (sa && env[sa.idEnv] && env[sa.publicKeyIdEnv]) {
      const file = sa.privateKeyFileEnv ? env[sa.privateKeyFileEnv] : undefined;
      // A relative key path (secrets/portal-viewer.pem in the repository .env) is relative to the repository root.
      const pem = file ? readFileSync(resolve(this.cfg.repoRoot, file), 'utf8') : sa.privateKeyEnv ? env[sa.privateKeyEnv] : undefined;
      if (!pem) throw new Error(`service account ${sa.idEnv} is set but no private key is (${[sa.privateKeyFileEnv, sa.privateKeyEnv].filter(Boolean).join(' or ')})`);
      const http = new HttpClient({ allowedOrigins: [NEBIUS_AUTH], timeoutMs: this.cfg.nebius!.timeoutMs, allowPostPaths: ['/oauth2/token/exchange'], limiter: this.limiter(NEBIUS_AUTH) });
      return new ServiceAccountTokenProvider({ serviceAccountId: env[sa.idEnv]!, publicKeyId: env[sa.publicKeyIdEnv]!, privateKeyPem: pem }, http);
    }
    if (auth.tokenEnv && env[auth.tokenEnv]) return new EnvTokenProvider(auth.tokenEnv);
    return undefined;
  }

  private limiter(origin: string): HostLimiter {
    const key = new URL(origin).origin;
    let l = this.limiters.get(key);
    if (!l) {
      l = new HostLimiter(Math.max(1, this.cfg.nebius?.maxConcurrency ?? 12), this.cfg.nebius?.minRequestIntervalMs ?? 20);
      this.limiters.set(key, l);
    }
    return l;
  }

  /** Live list prices; undefined until credentials and pricing are configured. */
  calculator(): NebiusCalculator | undefined {
    const n = this.cfg.nebius;
    if (!n?.pricing.enabled || !n.projects.length) return undefined;
    if (!this.calc) {
      const tokens = this.tokenProvider();
      if (!tokens) return undefined;
      const http = new HttpClient({
        allowedOrigins: [n.apiEndpoint], timeoutMs: n.timeoutMs, authorization: async () => `Bearer ${await tokens.token()}`,
        allowPostPaths: [CALCULATOR_PATH], limiter: this.limiter(n.apiEndpoint),
      });
      this.calc = new NebiusCalculator(http, { currency: n.pricing.currency, ttlMs: n.pricing.cacheMinutes * 60_000, base: n.apiEndpoint });
    }
    return this.calc;
  }

  /**
   * A read-only client for another Nebius read endpoint (Monitoring, Logs) with the portal's identity
   * and that host's limiter; undefined until projects and credentials are configured. GET only.
   */
  nebiusClient(origin: string, opts: { maxResponseBytes?: number } = {}): HttpClient | undefined {
    const n = this.cfg.nebius;
    const tokens = n?.projects.length ? this.tokenProvider() : undefined;
    if (!n || !tokens) return undefined;
    return new HttpClient({ allowedOrigins: [origin], timeoutMs: n.timeoutMs, authorization: async () => `Bearer ${await tokens.token()}`, limiter: this.limiter(origin), maxResponseBytes: opts.maxResponseBytes });
  }

  private inventoryErrors: NebiusInventoryResult['errors'] = [];

  /** The tenant the last sync read (from a project's parent), kept for a sync whose project reads all fail (F1.32). */
  private lastTenantId?: string;

  /** Each project's name and region as last read by id, kept for a sync whose read of it fails (F1.37). */
  private readonly lastProjects = new Map<string, { name: string; region?: string }>();

  /** The tenant: configured, else the one the inventory read. Undefined until a project read has succeeded. */
  tenantId(): string | undefined {
    return this.cfg.nebius?.tenantId ?? this.lastTenantId;
  }

  private readonly afterSyncHooks: ((attempt: string) => Promise<CapabilityStatus[] | void>)[] = [];

  /**
   * Runs after every sync (start-up, scheduled, "Sync now") on the fresh snapshot, before the run is
   * recorded: the alert engine. Capabilities it returns are merged like any connector's.
   */
  afterSync(hook: (attempt: string) => Promise<CapabilityStatus[] | void>) {
    this.afterSyncHooks.push(hook);
  }

  private readonly afterFastSyncHooks: (() => Promise<void>)[] = [];

  /** Cheap steps that also run after a fast sync (inventory only, no Monitoring or other slow reads). */
  afterFastSync(hook: () => Promise<void>) {
    this.afterFastSyncHooks.push(hook);
  }

  private async runAfterFastSync() {
    for (const hook of this.afterFastSyncHooks) {
      try {
        await hook();
      } catch (e) {
        this.logger.warn(`nebius-estate: after-fast-sync step failed: ${redact((e as Error).message)}`);
      }
    }
  }

  private async runAfterSync(attempt: string) {
    for (const hook of this.afterSyncHooks) {
      try {
        const caps = await hook(attempt);
        if (caps?.length) this.snap.capabilities = this.mergeCapabilities(caps);
      } catch (e) {
        this.logger.warn(`nebius-estate: after-sync step failed: ${redact((e as Error).message)}`);
      }
    }
  }

  /** Default project for pricing (the calculator needs a parent; the project fixes the region). */
  pricingProject(preferRegion?: string): string | undefined {
    const projects = this.snap.resources.filter(r => r.type === 'project');
    return (preferRegion ? projects.find(p => p.region === preferRegion)?.providerId : undefined) ?? projects[0]?.providerId ?? this.cfg.nebius?.projects[0]?.id;
  }

  private mark(id: string, patch: Partial<ConnectorStatus>) {
    const prev = this.statuses.get(id);
    if (!prev) return;
    let timing: Partial<ConnectorStatus> = {};
    if (patch.lastAttempt) {
      this.started.set(id, performance.now());
      this.finished.delete(id);
      timing = { running: true, runningSince: patch.lastAttempt };
    } else if (patch.state) {
      this.finished.set(id, performance.now());
      timing = { running: false, runningSince: undefined };
    }
    this.statuses.set(id, { ...prev, ...patch, ...timing });
  }

  /**
   * One sync at a time: a call while another runs (scheduled or "Sync now")
   * waits for that run instead of starting a second wave of outbound calls.
   */
  async syncAll(only?: string, opts: { fast?: boolean } = {}): Promise<void> {
    if (this.stopping.signal.aborted) return;
    if (!this.running) {
      // A sync waits out a network coming back (~30 s connect budget); a request handler's calls do not.
      this.running = inBackgroundSync(() => this.runSync(only, opts.fast === true && only === undefined), this.stopping.signal).finally(() => {
        this.running = undefined;
      });
    }
    await this.running;
  }

  /**
   * fast: the fast tier only (FAST_SYNC_LISTS and the discovered clusters' Kubernetes APIs), while something
   * is changing state; no slow-tier list, Monitoring, pricing, extension or alert evaluation.
   */
  private async runSync(only?: string, fast = false): Promise<void> {
    const attempt = new Date().toISOString();
    this.runningSince = attempt;
    try {
      if (fast) {
        await this.syncNebius(attempt, undefined, true);
        if (!this.stopping.signal.aborted) await this.runAfterFastSync();
      } else {
        // Different hosts sync in parallel; each host's limiter bounds its own load.
        const nebius = this.syncNebius(attempt, only);
        this.nebiusRun = nebius.then(() => undefined, () => undefined);
        await Promise.all([nebius, this.syncKubernetes(attempt, only), this.syncPrometheus(attempt, only), this.syncBillingExport(attempt, only), ...this.extensions.map(x => this.syncExtension(x, attempt, only))]);
        // Alerts are not evaluated on a run cut short by shutdown (its reads were aborted, not failed).
        if (!this.stopping.signal.aborted) await this.runAfterSync(attempt);
      }
    } finally {
      this.runningSince = undefined;
      // A sync that read the inventory, scheduled or "Sync now", ends a deferral (F1.45).
      if (!only || only === 'nebius-inventory') this.deferredNote = undefined;
      // A run cut short by shutdown says nothing about the connectors, and the store may be closing.
      if (!this.stopping.signal.aborted) {
        await this.recordRuns(attempt);
        // Every sync that read the inventory decides whether a fast re-sync follows (and re-arms it from now).
        if (!only || only === 'nebius-inventory') this.fast?.settle(transitionalResources(this.snap.resources), fast);
      }
    }
  }

  private async syncNebius(attempt: string, only?: string, fast = false) {
    const n = this.cfg.nebius;
    const monitoring = !fast && n?.projects.length && n.monitoring.enabled && (!only || only === 'nebius-monitoring') ? this.syncMonitoring(attempt) : Promise.resolve();
    if (n?.projects.length && (!only || only === 'nebius-inventory')) {
      this.mark('nebius-inventory', { lastAttempt: attempt });
      try {
        const tokens = this.tokenProvider();
        if (!tokens) throw new Error('no Nebius credentials in the environment (NEBIUS_SA_ID, NEBIUS_SA_PUBLIC_KEY_ID and NEBIUS_SA_PRIVATE_KEY_FILE, or NEBIUS_IAM_TOKEN; docs/portal/nebius-setup.md)');
        const http = new HttpClient({ allowedOrigins: [n.apiEndpoint], timeoutMs: n.timeoutMs, authorization: async () => `Bearer ${await tokens.token()}`, limiter: this.limiter(n.apiEndpoint) });
        // Tiered: core lists every sync; slow lists on full syncs (start-up, "Sync now", every fullSyncEvery-th);
        // a fast re-sync reads only the lists whose state is changing and does not count towards fullSyncEvery.
        const full = !fast && (this.inventorySyncs === 0 || only !== undefined || this.inventorySyncs % n.fullSyncEvery === 0);
        if (!fast) this.inventorySyncs++;
        const skip = fast
          ? new Set([...CATALOG.filter(d => !FAST_SYNC_LISTS.has(d.id)).map(d => d.id), 'iam.projects.list'])
          : full
            ? undefined
            : new Set([...CATALOG.filter(d => d.tier === 'slow').map(d => d.id), 'iam.projects.list']);
        const result = await new NebiusInventoryConnector(http, { tenantId: n.tenantId, lastKnownTenantId: this.lastTenantId, lastKnownProjects: this.lastProjects, projects: n.projects, maxConcurrency: n.maxConcurrency, apiBase: n.apiEndpoint, skip, discoverProjects: n.discoverProjects }).sync();
        if (result.tenantId) this.lastTenantId = result.tenantId;
        for (const r of result.resources) if (r.type === 'project' && r.status !== 'unknown') this.lastProjects.set(r.providerId, { name: r.name, region: r.region });
        this.mergeInventory(result, attempt);
        if (!fast) this.snap.inventoryReadAt = result.observedAt ?? attempt;
        // A core sync does not read the slow-tier lists: their last errors still stand (as their data does).
        const carried = skip ? this.inventoryErrors.filter(e => skip.has(e.service)) : [];
        const errors = [...result.errors, ...carried];
        this.inventoryErrors = errors;
        if (n.mk8s.discover) this.updateDiscovery(result, attempt);
        // Orphan rules count consecutive normal syncs; a fast re-sync does not shorten that wait.
        if (!fast) this.countOrphanStreaks();
        const state = inventoryState(result, errors, carried);
        // "Calls" on the card are lists, as its per-state counts ("Calls at the last sync") are: one number, one name.
        const lists = this.snap.capabilities.filter(c => c.connector === 'nebius-inventory' && c.state !== 'not-configured');
        this.mark('nebius-inventory', {
          projects: result.projects,
          missingCoverage: this.snap.capabilities
            // Attributed by the connector that makes the call (monitoring and pricing calls have connectors of their own).
            .filter(c => c.connector === 'nebius-inventory' && c.state !== 'ok' && c.state !== 'not-configured')
            .map(c => `${c.title} (${c.state.replace(/-/g, ' ')})`),
          // No answer to some calls is "degraded", to none "error" (F1.31: the live sync with 26 of 36 calls failed read "ok").
          // Refusals are answers: a fact of the identity's grants ("partial"), not a failed run.
          state,
          // A degraded or failed run keeps the last success: the last sync where every call answered.
          lastSuccess: state === 'degraded' || state === 'error' ? this.statuses.get('nebius-inventory')?.lastSuccess : attempt,
          calls: { total: lists.length, failed: lists.filter(c => c.state === 'unreachable').length },
          // The call's title, not its catalog id; the page shows the project's name (plainError with `projects`, W1F.N3).
          error: errors.length
            ? stableErrors(errors, state !== 'permission-denied')
                .slice(0, 5)
                .map(e => inventoryErrorLine(e, this.snap.capabilities.find(c => c.id === e.service)?.title))
                .join('; ')
            : undefined,
          // The message keeps five; "+N more" counts them all.
          errorCount: errors.length || undefined,
        });
      } catch (e) {
        const message = redact((e as Error).message);
        this.logger.warn(`nebius-estate: inventory sync failed: ${message}`);
        this.mark('nebius-inventory', { state: 'error', error: message });
      }
    }

    // After the inventory: the pricing probe (needs the platform list), the discovered clusters and the
    // cluster agent's metrics (need the cluster list); they run in parallel, on different hosts.
    await Promise.all([
      !fast && n?.projects.length && n.pricing.enabled && (!only || only === 'nebius-pricing') ? this.probePricing(attempt) : undefined,
      n?.projects.length && n.mk8s.discover && (!only || only === 'nebius-inventory' || only.startsWith('mk8s:')) ? this.syncDiscoveredClusters(attempt, only) : undefined,
      monitoring.then(() => (!fast && n?.projects.length && n.monitoring.enabled && (!only || only === 'nebius-monitoring') ? this.syncAgentMetrics(attempt) : undefined)),
    ]);
  }

  private async syncKubernetes(attempt: string, only?: string) {
    for (const k of this.cfg.kubernetes) {
      const id = `kubernetes:${k.name}`;
      if (only && only !== id) continue;
      this.mark(id, { lastAttempt: attempt });
      const token = process.env[k.tokenEnv];
      if (!token) {
        this.mark(id, { state: 'error', error: `environment variable ${k.tokenEnv} is not set` });
        continue;
      }
      try {
        const ca = k.caFile ? readFileSync(k.caFile) : undefined;
        const http = new HttpClient({ allowedOrigins: [k.url], timeoutMs: 15_000, fetch: nodeHttpsFetch(ca), authorization: async () => `Bearer ${token}` });
        const cluster = await new KubernetesConnector(k, http).sync();
        this.applyKube(id, cluster, c => c.name === k.name, attempt);
      } catch (e) {
        // e.g. an unreadable caFile: this cluster fails, the other connectors still sync.
        this.mark(id, { state: 'error', error: redact((e as Error).message) });
      }
    }

  }

  private async syncPrometheus(attempt: string, only?: string) {
    const p = this.cfg.prometheus;
    if (p && (!only || only === 'prometheus')) {
      this.mark('prometheus', { lastAttempt: attempt });
      try {
        const token = p.tokenEnv ? process.env[p.tokenEnv] : undefined;
        const http = new HttpClient({ allowedOrigins: [p.url], timeoutMs: p.timeoutMs, authorization: async () => (token ? `Bearer ${token}` : undefined) });
        this.snap.telemetry = await new PrometheusConnector(p.url, http).sync();
        this.mark('prometheus', { state: 'ok', lastSuccess: attempt, error: undefined });
      } catch (e) {
        this.mark('prometheus', { state: 'error', error: redact((e as Error).message) });
      }
    }
  }

  /**
   * Replaces the Nebius part of the snapshot. Lists that failed this time keep
   * their previous items, marked stale, instead of disappearing or turning into zeros.
   */
  private mergeInventory(result: NebiusInventoryResult, attempt: string) {
    const failed = new Set(result.failed.map(f => `${f.capability}|${f.parent}`));
    const skipped = new Set(result.skipped);
    const parentOf = (r: ObservedResource) => (r.type === 'mk8s-node-group' ? r.refs.find(x => x.relation === 'parent')?.target : r.projectId) ?? '';
    const fresh = new Set(result.resources.map(r => r.uid));
    const stale = this.snap.resources
      .filter(r => r.source.connector === 'nebius-inventory' && r.source.capability && failed.has(`${r.source.capability}|${parentOf(r)}`) && !fresh.has(r.uid))
      .map(r => (r.coverageNotes.some(x => x.startsWith('Stale:')) ? r : { ...r, coverageNotes: [...r.coverageNotes, `Stale: the last sync could not list ${r.source.capability}; showing the observation of ${r.observedAt}.`] }));
    // Slow-tier lists not read this time keep their previous items as they were.
    const carried = this.snap.resources.filter(r => r.source.connector === 'nebius-inventory' && r.source.capability && skipped.has(r.source.capability) && !fresh.has(r.uid));
    const others = this.snap.resources.filter(r => r.source.connector !== 'nebius-inventory');
    const prev = this.snap.capacity;
    const keep = <T extends { projectId?: string }>(capability: string, next: T[], before: T[]) =>
      skipped.has(capability)
        ? before
        : [...next, ...before.filter(x => failed.has(`${capability}|${x.projectId ?? ''}`) || (x.projectId === undefined && result.failed.some(f => f.capability === capability)))];
    const keepAll = <T>(capability: string, next: T[], before: T[]) => (skipped.has(capability) || result.failed.some(f => f.capability === capability) ? before : next);
    const capacity: CapacitySnapshot = {
      quotas: [
        ...keep('quotas.allowances', result.capacity.quotas.filter(q => q.scope === 'project'), prev.quotas.filter(q => q.scope === 'project')),
        ...keepAll('quotas.allowances.tenant', result.capacity.quotas.filter(q => q.scope === 'tenant'), prev.quotas.filter(q => q.scope === 'tenant')),
      ],
      capacityAllowances: keep('capacity.allowances', result.capacity.capacityAllowances, prev.capacityAllowances),
      platforms: keepAll('compute.platforms', result.capacity.platforms, prev.platforms),
      maintenances: keep('maintenance.maintenances', result.capacity.maintenances, prev.maintenances),
      capacityBlockGroups: keepAll('capacity.block-groups', result.capacity.capacityBlockGroups, prev.capacityBlockGroups),
      resourceAdvice: keepAll('capacity.resource-advice', result.capacity.resourceAdvice, prev.resourceAdvice),
    };
    // A list not read this time keeps its last failure in the coverage too, as its data and capability do (W1F.S7:
    // a core sync dropped the refused VPC lists from "Partial inventory coverage").
    const order = (f: string) => CATALOG.findIndex(d => d.id === f.replace(/ \(.*\)$/, ''));
    const before = new Map(this.snap.coverage.filter(c => c.connector === 'nebius-inventory' && c.project).map(c => [c.project!.id, c]));
    const coverage = result.coverage.map(c => {
      const kept = (c.project ? before.get(c.project.id)?.failed ?? [] : []).filter(f => skipped.has(f.replace(/ \(.*\)$/, '')) && !(c.failed ?? []).includes(f));
      if (!kept.length) return c;
      const failedNow = [...(c.failed ?? []), ...kept].sort((a, b) => order(a) - order(b));
      const hidden = new Set(kept.map(f => f.replace(/ \(.*\)$/, '')));
      return { ...c, services: c.services.filter(sv => !hidden.has(sv)), partial: true, failed: failedNow, note: `${failedNow.join(', ')} unavailable` };
    });
    this.snap = {
      ...this.snap,
      resources: [...others, ...result.resources, ...stale, ...carried],
      coverage,
      observedAt: attempt,
      capacity,
      // A capability not read this time keeps its last state, items and last success, as its data does.
      capabilities: this.mergeCapabilities(result.capabilities.filter(c => !skipped.has(c.id))),
      unconfiguredProjects: skipped.has('iam.projects.list') ? this.snap.unconfiguredProjects : result.unconfiguredProjects,
    };
  }

  /** Keeps the last success of a capability that failed this time, and says its data is stale. */
  private mergeCapabilities(next: CapabilityStatus[]): CapabilityStatus[] {
    const before = new Map(this.snap.capabilities.map(c => [c.id, c]));
    const merged = new Map(this.snap.capabilities.map(c => [c.id, c]));
    for (const c of next) {
      const prev = before.get(c.id);
      const failed = c.state !== 'ok' && c.state !== 'schema-drift' && c.state !== 'not-configured';
      merged.set(c.id, failed && prev?.lastSuccess ? { ...c, lastSuccess: prev.lastSuccess, stale: true } : c);
    }
    return [...merged.values()];
  }

  private async syncMonitoring(attempt: string) {
    const n = this.cfg.nebius!;
    this.mark('nebius-monitoring', { lastAttempt: attempt });
    const tokens = this.tokenProvider();
    if (!tokens) {
      this.mark('nebius-monitoring', { state: 'error', error: 'no Nebius credentials in the environment (docs/portal/nebius-setup.md)' });
      return;
    }
    const http = new HttpClient({ allowedOrigins: [n.monitoring.endpoint], timeoutMs: n.timeoutMs, authorization: async () => `Bearer ${await tokens.token()}`, limiter: this.limiter(n.monitoring.endpoint), maxResponseBytes: MAX_TELEMETRY_RESPONSE_BYTES });
    const r = await new NebiusMonitoringConnector(http, { projects: n.projects.map(p => p.id), maxConcurrency: n.maxConcurrency, base: n.monitoring.endpoint }).sync();
    const state = worst(r.outcomes.map(o => o.state));
    const failedProjects = new Set(r.outcomes.filter(o => o.state !== 'ok').map(o => o.project));
    const keptGpus = (this.snap.monitoring?.gpus ?? []).filter(g => g.projectId && failedProjects.has(g.projectId));
    this.vmGpus = [...r.gpus, ...keptGpus];
    this.snap.monitoring = { gpus: mergeGpus(this.vmGpus, this.agentGpus), observedAt: r.observedAt };
    const names = new Map(this.snap.resources.filter(x => x.type === 'project').map(x => [x.providerId, x.name]));
    const failedOne = r.outcomes.find(o => o.state !== 'ok');
    const capability: CapabilityStatus = {
      id: 'monitoring.gpu', title: 'GPU metrics for VMs (Nebius Monitoring, PromQL)', service: 'monitoring', connector: 'nebius-monitoring', scope: 'project',
      path: '/projects/{project}/service-provider/prometheus/api/v1/query', method: 'GET', state, items: r.gpus.length,
      latencyMs: Math.max(0, ...r.outcomes.map(o => o.latencyMs)), lastAttempt: attempt, lastSuccess: r.outcomes.some(o => o.state === 'ok') ? attempt : undefined,
      lastError: failedOne?.error, hint: hintFor(state, 'a `viewer` access permit on the project for the portal’s group (docs/credentials.md)'), verified: '2026-10-11',
      perProject: new Set(r.outcomes.map(o => o.state)).size > 1 ? r.outcomes.map(o => ({ id: o.project, name: names.get(o.project), state: o.state, items: o.series, error: o.error })) : undefined,
    };
    this.snap.capabilities = this.mergeCapabilities([capability]);
    this.mark('nebius-monitoring', {
      state: state === 'ok' ? 'ok' : state === 'permission-denied' ? 'permission-denied' : 'error',
      lastSuccess: capability.lastSuccess ?? this.statuses.get('nebius-monitoring')?.lastSuccess,
      error: failedOne ? `${names.get(failedOne.project) ?? failedOne.project}: ${failedOne.error}` : undefined,
      projects: n.projects.map(p => ({ id: p.id, name: names.get(p.id) })),
    });
  }

  /** One priced VM (the first preset the platforms list offers) shows whether live prices work for this identity. */
  private async probePricing(attempt: string) {
    const calc = this.calculator();
    this.mark('nebius-pricing', { lastAttempt: attempt });
    const platform = this.snap.capacity.platforms.find(p => p.presets.length);
    const project = this.pricingProject();
    if (!calc || !platform || !project) {
      this.mark('nebius-pricing', { state: calc ? (this.statuses.get('nebius-pricing')?.lastSuccess ? 'stale' : 'starting') : 'error', error: calc ? 'No platform list yet to price a probe VM.' : 'no Nebius credentials in the environment (docs/portal/nebius-setup.md)' });
      return;
    }
    const line = { key: 'probe', description: `${platform.name} · ${platform.presets[0].name}`, count: 1, spec: { '@type': 'type.googleapis.com/nebius.compute.v1.CreateInstanceRequest', metadata: { parentId: project, name: 'estimate' }, spec: { resources: { platform: platform.name, preset: platform.presets[0].name }, bootDisk: { attachMode: 'READ_WRITE' } } } };
    const started = Date.now();
    // The calculator answers the same spec from its cache for cacheMinutes: such a probe made no call.
    const probeKey = JSON.stringify([line.description, project]);
    const cached = !!this.lastProbe && this.lastProbe.key === probeKey && started - this.lastProbe.at < this.cfg.nebius!.pricing.cacheMinutes * 60_000;
    if (!cached) this.lastProbe = { key: probeKey, at: started };
    for (const id of ['billing.calculator', 'billing.calculator.contract']) {
      if (cached) this.cachedAnswers.add(id);
      else this.cachedAnswers.delete(id);
    }
    let estimate;
    try {
      estimate = await calc.estimate([line], project, [], this.cfg.nebius!.pricing.tryContractPrice);
    } catch {
      /* recorded in calc.status */
    }
    const st = calc.status;
    const capability: CapabilityStatus = {
      id: 'billing.calculator', title: 'Live list prices (billing calculator)', service: 'billing', connector: 'nebius-pricing', scope: 'project', path: CALCULATOR_PATH, method: 'POST',
      state: st.state, items: estimate?.lines.length, latencyMs: Date.now() - started, lastAttempt: attempt, lastSuccess: st.lastSuccess, lastError: st.lastError,
      hint: hintFor(st.state, 'a `viewer` access permit on the project for the portal’s group (docs/credentials.md)'), verified: '2026-10-11',
    };
    const contract: CapabilityStatus = {
      id: 'billing.calculator.contract', title: 'Contract prices (billing calculator, OFFER_TYPE_CONTRACT_PRICE)', service: 'billing', connector: 'nebius-pricing', scope: 'tenant', path: CALCULATOR_PATH, method: 'POST',
      state: !this.cfg.nebius!.pricing.tryContractPrice ? 'not-configured' : st.contractState ?? (estimate?.offer === 'contract' ? 'ok' : st.state), lastAttempt: attempt,
      // Same evidence as the list-price call: when it answered, how many lines, how long (the probe is one batch).
      ...(estimate?.offer === 'contract' ? { lastSuccess: st.lastSuccess ?? attempt, items: estimate.lines.length, latencyMs: capability.latencyMs } : {}),
      hint: st.contractState === 'permission-denied' ? 'Refused for this identity: grant resource.billinggroup.get on the billing group (docs/credentials.md). List prices are used meanwhile.' : undefined,
    };
    this.snap.capabilities = this.mergeCapabilities([capability, contract]);
    this.mark('nebius-pricing', { state: st.state === 'ok' ? 'ok' : st.state === 'permission-denied' ? 'permission-denied' : 'error', lastSuccess: st.lastSuccess, error: st.lastError });
  }

  /** A rule must hold on consecutive syncs: a disk caught mid-provisioning is not reported. */
  private countOrphanStreaks() {
    const prev = this.snap.orphanStreaks ?? {};
    const next: Record<string, number> = {};
    for (const o of findOrphanCandidates(linkNodeGroups(this.snap.resources, this.snap.kube), this.now())) next[o.uid] = (prev[o.uid] ?? 0) + 1;
    this.snap = { ...this.snap, orphanStreaks: next };
  }

  /* ------------------------------------------------- MK8s clusters, self-healing */

  /** Discovered MK8s clusters by id: the latest API view, the endpoint and CA last used, and missed syncs. */
  private readonly mk8s = new Map<string, { cluster: DiscoveredCluster; origin?: string; ca?: string; missing: number; lastSeen: string }>();
  private kubeFetch: (caPem: string) => FetchFn = caPem => nodeHttpsFetch(Buffer.from(caPem));

  /** Tests: replaces the TLS client of discovered clusters (it receives the CA from the API). */
  useKubeFetch(factory: (caPem: string) => FetchFn) {
    this.kubeFetch = factory;
  }

  /** A Soperator (Slurm) cluster: its nip-stack label, or its name. */
  private isSoperatorCluster(id: string, name: string): boolean {
    const r = this.snap.resources.find(x => x.providerId === id);
    return (r?.labels['nip-stack'] ?? r?.labels['nip-env']) === 'soperator' || /soperator|slurm/i.test(name);
  }

  /** Adds new clusters, refreshes known ones, and counts a cluster missing only where its project's list answered. */
  private updateDiscovery(result: NebiusInventoryResult, attempt: string) {
    const seen = new Set<string>();
    for (const c of result.mk8sClusters) {
      seen.add(c.id);
      const prev = this.mk8s.get(c.id);
      this.mk8s.set(c.id, { origin: prev?.origin, ca: prev?.ca, cluster: c, missing: 0, lastSeen: attempt });
    }
    const listed = new Set(result.mk8sListedProjects);
    for (const [id, e] of this.mk8s) if (!seen.has(id) && listed.has(e.cluster.projectId)) e.missing++;
    // The placeholder stands only while there is no cluster at all.
    if (this.mk8s.size) this.statuses.delete('kubernetes');
    else if (!this.cfg.kubernetes.length && !this.statuses.has('kubernetes')) this.statuses.set('kubernetes', kubernetesPlaceholder(true));
  }

  private async syncDiscoveredClusters(attempt: string, only?: string) {
    const n = this.cfg.nebius!;
    await Promise.all(
      [...this.mk8s.entries()].map(async ([id, e]) => {
        const sid = `mk8s:${id}`;
        if (only?.startsWith('mk8s:') && only !== sid) return;
        const c = e.cluster;
        if (!this.statuses.has(sid)) {
          this.statuses.set(sid, {
            id: sid, title: `Kubernetes — ${c.name} (MK8s, discovered)`, state: 'starting', scope: `cluster ${c.name}${c.region ? ` · ${c.region}` : ''}`,
            projects: [{ id: c.projectId }], permissions: 'the portal’s Nebius identity (group nebius:viewer on the cluster)',
            services: ['namespaces', 'deployments', 'statefulsets', 'jobs', 'pods', 'events', 'nodes'], staleAfterMinutes: n.syncIntervalMinutes * 3,
            // Slurm state matters for a Soperator cluster only; an inference or training cluster has none to miss.
            missingCoverage: this.isSoperatorCluster(id, c.name) ? ['Slurm queue and accounting (sinfo / squeue / sacct on the login node)'] : [],
            setup: 'docs/portal/nebius-setup.md#kubernetes',
          });
        }
        const capBase = {
          id: `k8s.cluster:${id}`, title: `Kubernetes API — ${c.name}`, service: 'mk8s', connector: sid as `mk8s:${string}`, scope: 'cluster' as const,
          path: '/api/v1/{nodes,namespaces,pods,persistentvolumeclaims,events}, /apis/apps/v1/…, /apis/batch/v1/jobs', method: 'GET' as const,
        };
        const capability = (state: CapabilityState, extra: Partial<CapabilityStatus> = {}) => {
          this.snap.capabilities = this.mergeCapabilities([{ ...capBase, state, lastAttempt: attempt, ...extra }]);
        };
        this.mark(sid, { lastAttempt: attempt });

        if (e.missing > 0) {
          if (e.missing >= n.mk8s.forgetAfterSyncs) {
            this.mk8s.delete(id);
            this.statuses.delete(sid);
            this.snap.kube = this.snap.kube.filter(k => k.mk8sClusterId !== id);
            this.snap.capabilities = this.snap.capabilities.filter(x => x.id !== capBase.id);
            this.logger.info(`nebius-estate: MK8s cluster ${c.name} (${id}) no longer exists; dropped after ${e.missing} syncs`);
            if (!this.mk8s.size && !this.cfg.kubernetes.length) this.statuses.set('kubernetes', kubernetesPlaceholder(true));
            return;
          }
          // A deleted cluster is retired at once: not an error (nothing to fix, no ConnectorFailing), named and dated.
          const project = this.snap.resources.find(r => r.type === 'project' && r.providerId === c.projectId)?.name ?? c.projectId;
          const left = n.mk8s.forgetAfterSyncs - e.missing;
          const note = `Retired: cluster ${c.name} no longer exists in project ${project} (last seen ${fmtUtc(e.lastSeen)}); its last data is kept, marked stale, for ${left} more sync${left === 1 ? '' : 's'}.`;
          this.snap.kube = this.snap.kube.map(k => (k.mk8sClusterId === id ? { ...k, stale: true, error: undefined } : k));
          this.mark(sid, { state: 'disabled', error: undefined, notes: [note] });
          capability('not-configured', { hint: note, lastError: undefined });
          return;
        }

        if (c.state !== 'RUNNING') {
          const note = clusterStateNote(c.state);
          this.snap.kube = this.snap.kube.map(k => (k.mk8sClusterId === id ? { ...k, stale: true } : k));
          this.mark(sid, { state: 'waiting', error: undefined, notes: [note] });
          capability('not-configured', { hint: note });
          return;
        }

        // Endpoint and CA come from the MK8s API on every sync: a recreated or rotated cluster just reconnects.
        const test = n.mk8s.testEndpoint;
        const endpoint = n.mk8s.endpoint === 'private' ? c.privateEndpoint : c.publicEndpoint;
        const target = test ? { origin: new URL(test).origin } : mk8sOrigin(endpoint, c.region);
        if ('refused' in target) {
          const error = `${n.mk8s.endpoint} endpoint refused: ${target.refused}`;
          this.mark(sid, { state: 'error', error });
          capability('rejected', { lastError: error });
          return;
        }
        if (!test && !c.caPem) {
          const error = 'the MK8s API reported no cluster CA certificate; not connecting without one';
          this.mark(sid, { state: 'error', error });
          capability('schema-drift', { lastError: error });
          return;
        }
        const fp = caFingerprint(c.caPem);
        const notes: string[] = [];
        if (e.origin && e.origin !== target.origin) notes.push(`Reconnected: the control-plane endpoint changed to ${target.origin}.`);
        if (e.ca && fp && e.ca !== fp) notes.push('Reconnected: the cluster CA certificate changed (pinned to the new one).');
        e.origin = target.origin;
        e.ca = fp;
        const tokens = this.tokenProvider();
        if (!tokens) {
          this.mark(sid, { state: 'error', error: 'no Nebius credentials in the environment (docs/portal/nebius-setup.md)' });
          return;
        }
        const started = Date.now();
        try {
          const http = new HttpClient({
            allowedOrigins: [target.origin], timeoutMs: n.timeoutMs, fetch: test ? undefined : this.kubeFetch(c.caPem!),
            authorization: async () => `Bearer ${await tokens.token()}`, limiter: this.limiter(target.origin),
          });
          const base = test ? `${test}/k8s/${encodeURIComponent(id)}` : target.origin;
          const cluster = await new KubernetesConnector({ name: c.name, url: base, mk8sClusterId: id }, http).sync();
          const state = this.applyKube(sid, cluster, k => k.mk8sClusterId === id, attempt, notes);
          capability(state, {
            items: cluster.error ? undefined : cluster.workloads.length, latencyMs: Date.now() - started, lastSuccess: cluster.error ? undefined : attempt, lastError: cluster.error,
            hint: state === 'permission-denied' ? 'Refused for this identity: the portal’s Nebius identity is the Kubernetes user (group nebius:viewer); it needs get/list on nodes, namespaces, workloads, pods, PVCs and events.' : undefined,
          });
        } catch (err) {
          const error = redact((err as Error).message);
          this.mark(sid, { state: 'error', error, notes });
          capability('unreachable', { lastError: error });
        }
      }),
    );
  }

  /** Records one cluster's result: fresh data replaces the old; a failure keeps the last good data, marked stale. */
  private applyKube(statusId: string, cluster: KubeCluster, same: (k: KubeCluster) => boolean, attempt: string, notes?: string[]): CapabilityState {
    const prev = this.snap.kube.find(same);
    if (cluster.error) {
      const state: CapabilityState = /\b40[13]\b/.test(cluster.error) ? 'permission-denied' : /\b404\b/.test(cluster.error) ? 'not-found' : 'unreachable';
      this.mark(statusId, { state: state === 'permission-denied' ? 'permission-denied' : 'error', error: cluster.error, notes });
      if (prev) this.snap.kube = this.snap.kube.map(k => (same(k) ? { ...prev, stale: true, error: cluster.error } : k));
      else this.snap.kube = [...this.snap.kube, cluster];
      return state;
    }
    this.snap.kube = [...this.snap.kube.filter(k => !same(k)), cluster];
    this.mark(statusId, { state: 'ok', lastSuccess: attempt, error: undefined, notes: notes?.length ? notes : undefined });
    return 'ok';
  }

  private vmGpus: GpuTelemetryView[] = [];
  private agentGpus: GpuTelemetryView[] = [];

  /**
   * Cluster metrics without port-forwards: the observability agent on an MK8s cluster pushes to the
   * project's own Monitoring (`/projects/<p>/prometheus`). Until it writes, the API answers 404
   * "project/bucket not found": shown as waiting for the agent, never as zero GPUs.
   */
  private async syncAgentMetrics(attempt: string) {
    const n = this.cfg.nebius!;
    const projects = [...new Set([...this.mk8s.values()].filter(e => !e.missing).map(e => e.cluster.projectId))];
    const base = {
      id: 'monitoring.cluster-gpu', title: 'GPU metrics from clusters (observability agent → Nebius Monitoring)', service: 'monitoring', connector: 'nebius-monitoring' as const,
      scope: 'project' as const, path: '/projects/{project}/prometheus/api/v1/query', method: 'GET' as const,
    };
    const tokens = this.tokenProvider();
    if (!projects.length || !tokens) {
      this.agentGpus = [];
      this.snap.capabilities = this.mergeCapabilities([{ ...base, state: 'not-configured', lastAttempt: attempt, hint: !projects.length ? 'No MK8s cluster in the configured projects; read when one exists.' : 'No Nebius credentials in the environment.' }]);
      return;
    }
    const http = new HttpClient({ allowedOrigins: [n.monitoring.endpoint], timeoutMs: n.timeoutMs, authorization: async () => `Bearer ${await tokens.token()}`, limiter: this.limiter(n.monitoring.endpoint), maxResponseBytes: MAX_TELEMETRY_RESPONSE_BYTES });
    const r = await new NebiusMonitoringConnector(http, { projects, maxConcurrency: n.maxConcurrency, base: n.monitoring.endpoint, path: MONITORING_PATHS.agent, source: AGENT_SOURCE }).sync();
    const failed = new Set(r.outcomes.filter(o => o.state !== 'ok').map(o => o.project));
    this.agentGpus = [...r.gpus, ...this.agentGpus.filter(g => g.projectId && failed.has(g.projectId) && r.outcomes.find(o => o.project === g.projectId)?.state !== 'not-found')];
    this.snap.monitoring = { gpus: mergeGpus(this.vmGpus, this.agentGpus), observedAt: this.snap.monitoring?.observedAt ?? r.observedAt };
    const state = worst(r.outcomes.map(o => o.state));
    const names = new Map(this.snap.resources.filter(x => x.type === 'project').map(x => [x.providerId, x.name]));
    const waiting = r.outcomes.filter(o => o.state === 'not-found').map(o => names.get(o.project) ?? o.project);
    this.snap.capabilities = this.mergeCapabilities([
      {
        ...base, state, items: r.gpus.length, latencyMs: Math.max(0, ...r.outcomes.map(o => o.latencyMs)), lastAttempt: attempt,
        lastSuccess: r.outcomes.some(o => o.state === 'ok') ? attempt : undefined, lastError: r.outcomes.find(o => o.state !== 'ok')?.error,
        hint: waiting.length
          ? `Waiting for the observability agent: nothing has been written to Monitoring of ${waiting.join(', ')} yet (404 "project/bucket not found"). It appears once the agent on the cluster pushes metrics.`
          : hintFor(state, 'a `viewer` access permit on the project for the portal’s group (docs/credentials.md)'),
        perProject: r.outcomes.length > 1 ? r.outcomes.map(o => ({ id: o.project, name: names.get(o.project), state: o.state, items: o.series, error: o.error })) : undefined,
      },
    ]);
  }
}

/** instance → node group edges from Kubernetes nodes whose labels name their MK8s node group. */
export function linkNodeGroups(resources: ObservedResource[], kube: KubeCluster[]): ObservedResource[] {
  const groupOf = new Map<string, string>();
  for (const c of kube) for (const node of c.nodes) if (node.instanceId && node.nodeGroupId) groupOf.set(node.instanceId, node.nodeGroupId);
  if (!groupOf.size) return resources;
  const groups = new Set(resources.filter(r => r.type === 'mk8s-node-group').map(r => r.providerId));
  return resources.map(r => {
    const g = r.type === 'compute-instance' ? groupOf.get(r.providerId) : undefined;
    if (!g || !groups.has(g) || r.refs.some(x => x.relation === 'member-of' && x.target === g)) return r;
    return { ...r, refs: [...r.refs, { relation: 'member-of' as const, target: g }] };
  });
}

/**
 * The connector's error line in a stable order (lists finish in any order when other connectors share the
 * sync): refusals first (unanswered calls first when there are some), then by project and catalog order, so the
 * same failures always read the same.
 */
function stableErrors<T extends { project: string; service: string; status?: number }>(errors: T[], failuresFirst = false): T[] {
  // Refusals first, unless calls went unanswered: then those lead (they are why the connector is degraded).
  const refused = (e: T) => (e.status === 401 || e.status === 403 ? 0 : 1) * (failuresFirst ? -1 : 1);
  const order = (e: T) => {
    const i = CATALOG.findIndex(d => d.id === e.service);
    return i < 0 ? CATALOG.length : i;
  };
  return [...errors].sort((a, b) => refused(a) - refused(b) || a.project.localeCompare(b.project) || order(a) - order(b) || a.service.localeCompare(b.service));
}

/**
 * The inventory connector's state after a sync: no answer to any call is an error, to some "degraded"; refusals are
 * "permission-denied". `carried`: errors of lists this sync did not read (slow tier on a core sync), which still
 * stand: one that went unanswered keeps the connector degraded until a sync reads that list again (W1F.N2).
 */
export function inventoryState(
  result: Pick<NebiusInventoryResult, 'calls' | 'permissionDenied'>,
  errors: NebiusInventoryResult['errors'],
  carried: NebiusInventoryResult['errors'] = [],
): ConnectorStatus['state'] {
  if (result.calls.total > 0 && result.calls.failed === result.calls.total) return 'error';
  if (result.calls.failed > 0 || carried.some(e => e.status !== 401 && e.status !== 403)) return 'degraded';
  return result.permissionDenied || errors.some(e => e.status === 401 || e.status === 403) ? 'permission-denied' : 'ok';
}
