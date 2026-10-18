import { DiscoveredCluster, discoveredCluster } from './mk8s';
import { createSign } from 'crypto';
import {
  CapabilityState,
  CapabilityStatus,
  CapacityAllowanceView,
  CapacityBlockGroupView,
  CoverageEntry,
  MaintenanceView,
  ObservedResource,
  PlatformView,
  QuotaAllowanceView,
  ResourceAdviceView,
  ResourceRef,
} from '@internal/nebius-domain';
import { HttpClient, HttpError, mapLimit, redact } from '../lib/http';
import { API_CONTRACTS } from './apiContracts';
import { checkItems, classify, listItems, worst } from './contract';
import { CapabilityDef, CATALOG, DISCOVERY, NODE_GROUPS } from './nebius-catalog';
import { Ctx, Json, mapNodeGroup, mapState, markDefaultPools, pick } from './nebius-mappers';

/**
 * Read-only Nebius inventory over the documented REST gateway
 * (https://docs.nebius.com/rest-api/index): one host, gRPC-transcoded paths,
 * `parentId` + `pageSize` + `pageToken` → `{ items, nextPageToken }`. Every
 * call is a GET from the catalog (nebius-catalog.ts); each one's outcome is a
 * capability status, so a refused, missing or drifted list is reported on its
 * own and never hides the others.
 */

import { NEBIUS_API, NEBIUS_AUTH } from './endpoints';

export { NEBIUS_API, NEBIUS_AUTH, NEBIUS_MONITORING } from './endpoints';
export * from './nebius-mappers';
/** Safe default page size; some lists refuse ≥ 500 (capacity allowances) or > 50 (NVL groups). */
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

/* ------------------------------------------------------------------ tokens */

export interface TokenProvider {
  token(): Promise<string>;
}

/** A short-lived IAM token supplied through an environment variable. */
export class EnvTokenProvider implements TokenProvider {
  constructor(private readonly envName: string, private readonly env = process.env) {}
  async token(): Promise<string> {
    const t = this.env[this.envName];
    if (!t) throw new Error(`environment variable ${this.envName} is not set`);
    return t;
  }
}

/**
 * Service-account token exchange (https://docs.nebius.com/iam/wif#how-it-works):
 * an RS256 JWT (kid = authorized key id, iss = sub = service account id,
 * 5 min expiry) exchanged for an access token at sts.nebius.com/oauth2/token/exchange. The
 * token is cached until 5 minutes before it expires, and concurrent callers share one exchange
 * (single flight); keys never leave memory.
 */
export class ServiceAccountTokenProvider implements TokenProvider {
  private cached?: { token: string; until: number };

  constructor(
    private readonly creds: { serviceAccountId: string; publicKeyId: string; privateKeyPem: string },
    private readonly http: HttpClient,
    private readonly now = () => Date.now(),
  ) {}

  signJwt(): string {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const iat = Math.floor(this.now() / 1000);
    const head = b64({ alg: 'RS256', typ: 'JWT', kid: this.creds.publicKeyId });
    const body = b64({ iss: this.creds.serviceAccountId, sub: this.creds.serviceAccountId, iat, exp: iat + 300 });
    const signer = createSign('RSA-SHA256');
    signer.update(`${head}.${body}`);
    return `${head}.${body}.${signer.sign(this.creds.privateKeyPem).toString('base64url')}`;
  }

  /** The exchange in flight: every call that needs a token meanwhile waits for it (one exchange per expiry). */
  private pending?: Promise<string>;

  async token(): Promise<string> {
    if (this.cached && this.cached.until > this.now()) return this.cached.token;
    this.pending ??= this.exchange().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async exchange(): Promise<string> {
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: this.signJwt(),
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    });
    const res = await this.http.request<{ access_token: string; expires_in: number }>(`${NEBIUS_AUTH}/oauth2/token/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    this.cached = { token: res.access_token, until: this.now() + Math.max(60, res.expires_in - 300) * 1000 };
    return res.access_token;
  }
}

/* --------------------------------------------------------------- connector */

/** Capacity and planning data that is not an estate resource. */
export interface CapacitySnapshot {
  quotas: QuotaAllowanceView[];
  capacityAllowances: CapacityAllowanceView[];
  platforms: PlatformView[];
  capacityBlockGroups: CapacityBlockGroupView[];
  resourceAdvice: ResourceAdviceView[];
  maintenances: MaintenanceView[];
}

export const emptyCapacity = (): CapacitySnapshot => ({ quotas: [], capacityAllowances: [], platforms: [], capacityBlockGroups: [], resourceAdvice: [], maintenances: [] });

export interface NebiusInventoryResult {
  resources: ObservedResource[];
  /** Configured projects with the names read from the API. */
  projects: { id: string; name: string }[];
  coverage: CoverageEntry[];
  errors: { project: string; service: string; status?: number; message: string }[];
  permissionDenied: boolean;
  capabilities: CapabilityStatus[];
  capacity: CapacitySnapshot;
  /** capability × parent pairs that failed this time (their last good data may be kept, marked stale). */
  failed: { capability: string; parent: string }[];
  /** Capabilities not read this time (slow tier): their previous data stands unchanged. */
  skipped: string[];
  /** Projects in the tenant that are not configured (only with discoverProjects). */
  unconfiguredProjects: { id: string; name?: string; region?: string }[];
  /** MK8s clusters with their endpoints and CA (for automatic connection); not part of any response. */
  mk8sClusters: DiscoveredCluster[];
  /** Projects whose cluster list answered this time (a cluster missing there no longer exists). */
  mk8sListedProjects: string[];
  tenantId?: string;
  /** When this sync started reading (the observedAt of every item it read). */
  observedAt?: string;
  /** Calls made this time, and how many got no answer (network, timeout, 429/5xx after retries): refusals are answers. */
  calls: { total: number; failed: number };
}

interface Outcome {
  parent: string;
  state: CapabilityState;
  items: number;
  latencyMs: number;
  error?: string;
  drift: string[];
}

const n = (v: unknown): number | null => {
  const x = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(x) ? null : x;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export class NebiusInventoryConnector {
  constructor(
    private readonly http: HttpClient,
    private readonly opts: {
      tenantId?: string;
      /** The tenant a previous sync derived from a project read: used when no project can be read this time. */
      lastKnownTenantId?: string;
      /** Name and region of each project as a previous sync read them: kept when reading it fails this time (F1.37). */
      lastKnownProjects?: ReadonlyMap<string, { name: string; region?: string }>;
      projects: { id: string; name?: string; regions?: string[] }[];
      maxConcurrency: number;
      now?: () => Date;
      /** Defaults to NEBIUS_API; the config allows another value only on a loopback-only backend. */
      apiBase?: string;
      /** Catalog subset (tests, verify:live); default: every entry. */
      catalog?: CapabilityDef[];
      /** Capabilities not read this time (slow tier between full syncs): their previous result stands. */
      skip?: ReadonlySet<string>;
      /** List the tenant's projects (needs tenant-level `viewer`) to show projects that are not configured. */
      discoverProjects?: boolean;
    },
  ) {}

  private get api(): string {
    return this.opts.apiBase ?? NEBIUS_API;
  }

  /** One list, all pages, items checked against the documented contract. */
  private async list(def: CapabilityDef, parentId: string): Promise<{ items: Json[]; truncated: boolean; drift: string[] }> {
    const items: Json[] = [];
    const drift = new Set<string>();
    const paged = API_CONTRACTS[def.path]?.paged ?? true;
    let token: string | undefined;
    let sendPageSize = paged;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ parentId });
      if (sendPageSize) q.set('pageSize', String(def.pageSize ?? PAGE_SIZE));
      if (token) q.set('pageToken', token);
      let body: Json;
      try {
        body = await this.http.request<Json>(`${this.api}${def.path}?${q.toString()}`);
      } catch (e) {
        // A list that refuses our page size: retry once with the service default, and say so.
        if (sendPageSize && e instanceof HttpError && e.status === 400 && /page.?size/i.test(e.message)) {
          sendPageSize = false;
          drift.add(`refused pageSize ${def.pageSize ?? PAGE_SIZE}; read with the service's default page size`);
          q.delete('pageSize');
          body = await this.http.request<Json>(`${this.api}${def.path}?${q.toString()}`);
        } else {
          throw e;
        }
      }
      const raw = listItems(def.path, body);
      const checked = checkItems(def.path, raw.items);
      raw.drift.concat(checked.drift).forEach(d => drift.add(d));
      items.push(...checked.valid);
      token = paged ? str(body?.nextPageToken) : undefined;
      if (!token) return { items, truncated: false, drift: [...drift] };
    }
    return { items, truncated: true, drift: [...drift] };
  }

  /** Runs one capability against one parent and records the outcome; never throws. */
  private async attempt(def: CapabilityDef, parent: string, onItems: (items: Json[]) => void, outcomes: Map<string, Outcome[]>): Promise<boolean> {
    const started = Date.now();
    const record = (o: Omit<Outcome, 'parent' | 'latencyMs'>) => {
      const list = outcomes.get(def.id) ?? [];
      list.push({ parent, latencyMs: Date.now() - started, ...o });
      outcomes.set(def.id, list);
    };
    try {
      const { items, truncated, drift } = await this.list(def, parent);
      onItems(items);
      const notes = truncated ? [...drift, `pagination stopped after ${MAX_PAGES} pages; results truncated`] : drift;
      record({ state: notes.length ? 'schema-drift' : 'ok', items: items.length, drift: notes });
      return true;
    } catch (e) {
      const c = classify(e);
      record({ state: c.state, items: 0, drift: [], error: redact((e as Error).message) });
      return false;
    }
  }

  async sync(): Promise<NebiusInventoryResult> {
    const observedAt = (this.opts.now?.() ?? new Date()).toISOString();
    const resources: ObservedResource[] = [];
    const mk8sClusters: DiscoveredCluster[] = [];
    const mk8sListedProjects: string[] = [];
    const errors: NebiusInventoryResult['errors'] = [];
    const coverage: CoverageEntry[] = [];
    const capacity = emptyCapacity();
    const outcomes = new Map<string, Outcome[]>();
    const skip = this.opts.skip ?? new Set<string>();
    const catalog = (this.opts.catalog ?? CATALOG).filter(d => !skip.has(d.id));

    // Each configured project is read by id (GET /iam/v2/projects/{id}: project-level viewer suffices;
    // listing the tenant's projects needs tenant-level access, which this connector never asks for).
    // Its name and region come from the API; the region then labels every resource listed in it,
    // since regional resources such as networks carry no region of their own.
    const projects = await mapLimit(this.opts.projects, this.opts.maxConcurrency, async p => {
      const fallbackRegion = p.regions?.length === 1 ? p.regions[0] : undefined;
      const started = Date.now();
      try {
        const item = await this.http.request<Json>(`${this.api}/iam/v2/projects/${encodeURIComponent(p.id)}`);
        const md = item.metadata ?? {};
        outcomes.set('iam.projects', [...(outcomes.get('iam.projects') ?? []), { parent: p.id, state: 'ok', items: 1, latencyMs: Date.now() - started, drift: [] }]);
        return {
          id: p.id,
          name: str(md.name) ?? p.name ?? p.id,
          region: (pick(md, 'region') ?? pick(item.spec, 'region', 'defaultRegion', 'default_region') ?? fallbackRegion) as string | undefined,
          tenantId: (pick(md, 'parentId', 'parent_id') as string | undefined) ?? this.opts.tenantId ?? this.opts.lastKnownTenantId,
          state: pick(item.status, 'projectState', 'project_state', 'state'),
          createdAt: pick(md, 'createdAt', 'created_at') as string | undefined,
          read: true,
          known: false,
        };
      } catch (e) {
        const message = redact((e as Error).message);
        errors.push({ project: p.id, service: 'iam.projects', status: e instanceof HttpError ? e.status : undefined, message });
        outcomes.set('iam.projects', [...(outcomes.get('iam.projects') ?? []), { parent: p.id, state: classify(e).state, items: 0, latencyMs: Date.now() - started, drift: [], error: message }]);
        const known = this.opts.lastKnownProjects?.get(p.id);
        return { id: p.id, name: known?.name ?? p.name ?? p.id, region: known?.region ?? fallbackRegion, tenantId: this.opts.tenantId ?? this.opts.lastKnownTenantId, state: undefined, createdAt: undefined, read: false, known: Boolean(known) };
      }
    });
    const byProject = new Map(projects.map(p => [p.id, p]));
    for (const p of projects) {
      resources.push({
        uid: `nebius:${p.id}`, providerId: p.id, type: 'project', name: p.name, tenantId: p.tenantId, projectId: p.id, region: p.region,
        labels: {}, status: p.read ? mapState(p.state ?? 'ACTIVE') : 'unknown', statusDetail: p.state ? String(p.state) : undefined, createdAt: p.createdAt,
        refs: [], spec: {}, source: { connector: 'nebius-inventory', kind: 'nebius-api', endpoint: this.api, capability: 'iam.projects' },
        observedAt,
        coverageNotes: p.read ? [] : [p.known ? 'Reading the project by id failed (see Integrations); name and region are from the last successful read.' : 'Project from configuration; reading it by id failed (see Integrations). The last successful read is kept in memory only: after a backend restart the name and region return with the first successful read.'],
      });
    }
    const ctxFor = (id: string, capability: string): Ctx => ({ projectId: id, tenantId: byProject.get(id)?.tenantId, observedAt, endpoint: this.api, region: byProject.get(id)?.region, capability });
    // Configured, else the parent of a project read this time, else the one a previous sync read (a failed project
    // read must not lose the tenant: every tenant-level list depends on it).
    const tenantId = this.opts.tenantId ?? projects.find(p => p.read && p.tenantId)?.tenantId ?? this.opts.lastKnownTenantId;

    // Platforms are the same for every project of a region: read once per region.
    const firstInRegion = new Set([...new Map(projects.map(p => [p.region ?? p.id, p.id])).values()]);
    // Every list runs concurrently within the per-host limiter: project lists, tenant lists, and each
    // project's node groups as soon as its clusters are known (no stage waits for another).
    const jobs = this.opts.projects.flatMap(p => catalog.filter(d => d.scope === 'project' && (d.kind !== 'platforms' || firstInRegion.has(p.id))).map(def => ({ p, def })));
    const projectLists = mapLimit(jobs, this.opts.maxConcurrency, async ({ p, def }) => {
      const ctx = ctxFor(p.id, def.id);
      let listed: Json[] = [];
      const ok = await this.attempt(def, p.id, items => {
        listed = items;
        this.collect(def, items, ctx, resources, capacity);
      }, outcomes);
      const o = outcomes.get(def.id)!.find(x => x.parent === p.id)!;
      // Refusals and outages are errors; a 404 or 400 is a capability fact, reported on its own.
      if (!ok && (o.state === 'permission-denied' || o.state === 'unreachable')) {
        errors.push({ project: p.id, service: def.id, status: o.state === 'permission-denied' ? 403 : undefined, message: o.error ?? o.state });
      }
      if (def.id === 'mk8s.clusters' && ok) {
        mk8sListedProjects.push(p.id);
        for (const c of listed) {
          const d = discoveredCluster(c, p.id, byProject.get(p.id)?.region);
          if (d) mk8sClusters.push(d);
        }
      }
      if (def.id === 'mk8s.clusters' && catalog.includes(NODE_GROUPS)) {
        const ngCtx = ctxFor(p.id, NODE_GROUPS.id);
        await mapLimit(listed, this.opts.maxConcurrency, async c => {
          const clusterId = String(c.metadata.id);
          const okNg = await this.attempt(NODE_GROUPS, clusterId, items => resources.push(...items.map(i => mapNodeGroup(i, ngCtx, clusterId))), outcomes);
          if (!okNg) errors.push({ project: p.id, service: NODE_GROUPS.id, message: outcomes.get(NODE_GROUPS.id)!.find(x => x.parent === clusterId)!.error ?? 'failed' });
        });
      }
    });
    // Tenant-scoped lists: refused until a tenant-level read role is granted; then they just work.
    const tenantLists = tenantId
      ? Promise.all(catalog.filter(d => d.scope === 'tenant').map(def => this.attempt(def, tenantId, items => this.collect(def, items, { projectId: '', tenantId, observedAt, endpoint: this.api, capability: def.id }, resources, capacity), outcomes)))
      : Promise.resolve();
    // Opt-in: the tenant's projects, only to hint at ones not in scope (scope stays the configured list).
    const discovery: Promise<{ id: string; name?: string; region?: string }[]> =
      this.opts.discoverProjects && tenantId && !skip.has('iam.projects.list')
        ? (async () => {
            let found: Json[] = [];
            await this.attempt(DISCOVERY, tenantId, items => (found = items), outcomes);
            const configured = new Set(projects.map(p => p.id));
            return found.filter(i => !configured.has(String(i.metadata.id))).map(i => ({ id: String(i.metadata.id), name: str(i.metadata.name), region: str(pick(i.metadata, 'region')) ?? str(pick(i.spec, 'region')) }));
          })()
        : Promise.resolve([]);
    const [, , unconfiguredProjects] = await Promise.all([projectLists, tenantLists, discovery]);

    markDefaultPools(resources);
    // Instance-side attachment refs become disk/filesystem → instance edges.
    const byId = new Map(resources.map(r => [r.providerId, r]));
    for (const r of resources) {
      const attach = ((r as any)._attachRefs ?? []) as ResourceRef[];
      delete (r as any)._attachRefs;
      for (const a of attach) {
        const target = byId.get(a.target);
        if (!target) continue;
        if (!target.refs.some(x => x.target === r.providerId)) target.refs.push({ relation: a.relation, target: r.providerId });
      }
    }

    // Coverage per project: what was listed, and what failed in a way that hides resources.
    const resourceDefs = catalog.filter(d => d.kind === 'resources');
    const skippedResources = (this.opts.catalog ?? CATALOG).filter(d => skip.has(d.id) && d.kind === 'resources').map(d => d.id);
    for (const p of projects) {
      // Skipped lists stand as last read; they count as covered.
      const services: string[] = p.read ? ['iam.projects', ...skippedResources] : [];
      const failed: string[] = [];
      for (const def of resourceDefs) {
        const os = (outcomes.get(def.id) ?? []).filter(o => (def.scope === 'cluster' ? resources.some(r => r.providerId === o.parent && r.projectId === p.id) : o.parent === p.id));
        for (const o of os) {
          if (o.state === 'ok' || o.state === 'schema-drift') services.push(def.id);
          else if (o.state === 'permission-denied' || o.state === 'unreachable') failed.push(`${def.id}${o.state === 'permission-denied' ? ' (403)' : ' (unreachable)'}`);
        }
      }
      coverage.push({
        connector: 'nebius-inventory',
        project: { id: p.id, name: p.name },
        services: [...new Set(services)].sort(),
        partial: failed.length > 0 || !p.read,
        note: failed.length ? `${failed.join(', ')} unavailable` : !p.read ? 'iam.projects unavailable' : undefined,
        ...(failed.length ? { failed } : {}),
      });
    }

    const capabilities = this.statuses(catalog, outcomes, tenantId, observedAt, byProject);
    const failedPairs = [...outcomes.entries()].flatMap(([capability, os]) => os.filter(o => o.state !== 'ok' && o.state !== 'schema-drift').map(o => ({ capability, parent: o.parent })));
    const permissionDenied = [...outcomes.entries()].some(([id, os]) => {
      const def = catalog.find(d => d.id === id);
      return (id === 'iam.projects' || (def?.kind === 'resources' && def.scope !== 'tenant')) && os.some(o => o.state === 'permission-denied');
    });
    const all = [...outcomes.values()].flat();
    const calls = { total: all.length, failed: all.filter(o => o.state === 'unreachable').length };
    return { resources, coverage, errors, projects: projects.map(p => ({ id: p.id, name: p.name })), permissionDenied, capabilities, capacity, failed: failedPairs, tenantId, skipped: [...skip], unconfiguredProjects, mk8sClusters, mk8sListedProjects, calls, observedAt };
  }

  /** Puts one list's items where they belong: estate resources or capacity data. */
  private collect(def: CapabilityDef, items: Json[], ctx: Ctx, resources: ObservedResource[], capacity: CapacitySnapshot) {
    switch (def.kind) {
      case 'resources':
        if (def.map) resources.push(...items.map(i => def.map!(i, ctx)));
        return;
      case 'quotas':
        capacity.quotas.push(...items.map(i => mapQuotaAllowance(i, ctx.projectId)));
        return;
      case 'capacity-allowances':
        capacity.capacityAllowances.push(
          ...items.map(i => ({
            projectId: ctx.projectId, name: String(i.metadata.name ?? i.metadata.id), capacityBlockGroupId: str(pick(i.spec, 'capacityBlockGroupId', 'capacity_block_group_id')),
            limit: n(pick(i.spec, 'limit')), usage: n(pick(i.status, 'usage')), usagePercent: percentOf(n(pick(i.status, 'usage')), n(pick(i.spec, 'limit')), n(pick(i.status, 'usagePercentage', 'usage_percentage'))), unit: str(pick(i.status, 'unit')), state: str(pick(i.status, 'state')),
          })),
        );
        return;
      case 'platforms':
        for (const i of items) {
          const name = String(i.metadata.name ?? i.metadata.id);
          const existing = capacity.platforms.find(p => p.name === name);
          if (existing) {
            if (!existing.projects.includes(ctx.projectId)) existing.projects.push(ctx.projectId);
            if (ctx.region && !existing.regions.includes(ctx.region)) existing.regions.push(ctx.region);
            continue;
          }
          capacity.platforms.push({
            name, humanName: str(pick(i.spec, 'humanReadableName', 'human_readable_name')), gpuMemoryGibibytes: n(pick(i.spec, 'gpuMemoryGibibytes', 'gpu_memory_gibibytes')) ?? undefined,
            presets: ((pick(i.spec, 'presets') ?? []) as Json[]).map(p => ({
              name: String(p.name ?? ''), gpus: n(pick(p.resources, 'gpuCount', 'gpu_count')) ?? 0, vcpus: n(pick(p.resources, 'vcpuCount', 'vcpu_count')) ?? 0, memoryGibibytes: n(pick(p.resources, 'memoryGibibytes', 'memory_gibibytes')) ?? 0,
            })),
            projects: [ctx.projectId],
            regions: ctx.region ? [ctx.region] : [],
          });
        }
        return;
      case 'maintenances':
        capacity.maintenances.push(
          ...items.map(i => ({
            id: String(i.metadata.id), name: String(i.metadata.name ?? i.metadata.id), projectId: ctx.projectId, state: str(pick(i.status, 'state')),
            scheduledAt: str(pick(i.spec, 'scheduledAt', 'scheduled_at')), startedAt: str(pick(i.status, 'startedAt', 'started_at')), finishedAt: str(pick(i.status, 'finishedAt', 'finished_at')),
            affected: ((pick(i.status, 'affectedResources', 'affected_resources') ?? []) as Json[]).map(a => String(a.id ?? '')).filter(Boolean),
          })),
        );
        return;
      case 'capacity-block-groups':
        capacity.capacityBlockGroups.push(
          ...items.map(i => {
            const aff = pick(pick(i.status, 'resourceAffinity', 'resource_affinity'), 'computeV1', 'compute_v1');
            return {
              id: String(i.metadata.id), name: String(i.metadata.name ?? i.metadata.id), region: str(pick(i.status, 'region')), service: str(pick(i.status, 'service')),
              platform: str(pick(aff, 'platform')), fabric: str(pick(aff, 'fabric')), limit: n(pick(i.status, 'currentLimit', 'current_limit')), usage: n(pick(i.status, 'usage')),
              state: str(pick(i.status, 'state')), nextChangeAt: str(pick(i.status, 'nextChangeAt', 'next_change_at')),
            };
          }),
        );
        return;
      case 'resource-advice':
        capacity.resourceAdvice.push(
          ...items.map(i => {
            const ci = pick(i.spec, 'computeInstance', 'compute_instance');
            const enumText = (v: unknown, prefix: string) => str(v)?.replace(prefix, '').toLowerCase().replace(/_/g, '-');
            // proto3 JSON omits zeros: within a reported availability, an absent available or limit is 0
            // (e.g. `reserved` at LIMIT_REACHED in a tenant with no reservation is 0 of 0).
            const avail = (a: Json | undefined) =>
              a
                ? {
                    level: enumText(pick(a, 'availabilityLevel', 'availability_level'), 'AVAILABILITY_LEVEL_'),
                    available: n(pick(a, 'available')) ?? 0,
                    limit: n(pick(a, 'limit')) ?? 0,
                    dataState: enumText(pick(a, 'dataState', 'data_state'), 'DATA_STATE_'),
                    effectiveAt: str(pick(a, 'effectiveAt', 'effective_at')),
                  }
                : undefined;
            const preset = pick(ci, 'preset');
            return {
              region: str(pick(i.spec, 'region')), fabric: str(pick(i.spec, 'fabric')), platform: str(pick(ci, 'platform')), preset: str(pick(preset, 'name')),
              gpus: n(pick(pick(preset, 'resources'), 'gpuCount', 'gpu_count')) ?? undefined,
              onDemand: avail(pick(i.status, 'onDemand', 'on_demand')), preemptible: avail(pick(i.status, 'preemptible')), reserved: avail(pick(i.status, 'reserved')),
            };
          }),
        );
        return;
      case 'pricing-policies':
      default:
        return; // probed for the capability status only
    }
  }

  private statuses(catalog: CapabilityDef[], outcomes: Map<string, Outcome[]>, tenantId: string | undefined, at: string, byProject: Map<string, { name: string }>): CapabilityStatus[] {
    const defs: { id: string; title: string; service: string; path: string; scope: 'project' | 'tenant' | 'cluster'; grant: string; verified?: string }[] = [
      { id: 'iam.projects', title: 'Projects (read by id)', service: 'iam', path: '/iam/v2/projects/{id}', scope: 'project', grant: 'a `viewer` access permit on the project for the portal’s group (docs/credentials.md)', verified: '2026-10-11' },
      // Skipped this time (slow tier): not reported, so the service keeps its last state, items and last success.
      ...(this.opts.discoverProjects && !this.opts.skip?.has(DISCOVERY.id) ? [DISCOVERY] : []),
      ...catalog,
    ];
    return defs.map(def => {
      const os = outcomes.get(def.id) ?? [];
      const base = { id: def.id, title: def.title, service: def.service, connector: 'nebius-inventory' as const, scope: def.scope, path: def.path, method: 'GET' as const, verified: def.verified };
      if (!os.length) {
        return { ...base, state: 'not-configured' as const, hint: def.scope === 'tenant' && !tenantId ? 'No tenant id: set NEBIUS_TENANT_ID (nebius.tenantId), or a project read must succeed first; this is not a missing role.' : def.scope === 'cluster' ? 'No Managed Kubernetes cluster in the listed projects.' : undefined };
      }
      const state = worst(os.map(o => o.state));
      const failedOne = os.find(o => o.state !== 'ok');
      const states = new Set(os.map(o => o.state));
      return {
        ...base,
        state,
        items: os.reduce((a, o) => a + o.items, 0),
        latencyMs: Math.max(...os.map(o => o.latencyMs)),
        lastAttempt: at,
        lastSuccess: os.some(o => o.state === 'ok' || o.state === 'schema-drift') ? at : undefined,
        lastError: failedOne?.error,
        hint: hintFor(state, def.grant),
        drift: [...new Set(os.flatMap(o => o.drift))],
        perProject: states.size > 1 && def.scope !== 'tenant' ? os.map(o => ({ id: o.parent, name: byProject.get(o.parent)?.name, state: o.state, items: o.items, error: o.error })) : undefined,
      };
    });
  }
}

/**
 * `status.usage_percentage` of quota and capacity allowances is a 0–1 fraction (live 2026-10-11: 1 of 8 is 0.125,
 * 1 of 50 is 0.02). The portal's `usagePercent` is a percentage (0–100), rounded to two decimals.
 */
export function apiPercent(fraction: number | null): number | null {
  return fraction === null ? null : Math.round(fraction * 10_000) / 100;
}

/**
 * Usage as a percentage: usage / limit when both are reported (exact; the API rounds its fraction to two decimals,
 * 2 of 32 reads 0.06), else the API's fraction as a percentage; null when neither is known.
 */
export function percentOf(usage: number | null, limit: number | null, fraction: number | null): number | null {
  if (usage !== null && limit !== null && limit > 0) return Math.round((10_000 * usage) / limit) / 100;
  return apiPercent(fraction);
}

/** The epoch timestamp the quota API gives placeholder entries (no allocation was ever created). */
const EPOCH = /^1970-01-01T00:00:00(\.0+)?Z$/;

/**
 * One quota allowance (`projectId` '' for a tenant list). Verified live 2026-10-11:
 * - tenant: proto3 JSON omits zeros, so an absent spec.limit is 0 (an apply failed with QuotaFailure limit "0");
 * - project placeholder: no metadata.id, created_at at the epoch, no spec.limit, no status.state. No project
 *   allocation is set; the project draws on the tenant quota (a preemptible L40S node ran under such entries).
 *   Never read as limit 0;
 * - project allocation (an id or a state, or a limit): a real cap; an absent limit is 0.
 * An absent status.usage is 0.
 */
export function mapQuotaAllowance(i: Json, projectId: string): QuotaAllowanceView {
  const usageState = str(pick(i.status, 'usageState', 'usage_state'))?.replace('USAGE_STATE_', '');
  const rawLimit = n(pick(i.spec, 'limit'));
  const state = str(pick(i.status, 'state'));
  const createdAt = str(pick(i.metadata, 'createdAt', 'created_at'));
  const realId = Boolean(i.metadata?.id) && !i.metadata?.idFromKey;
  const placeholder = Boolean(projectId) && !realId && !state && rawLimit === null && (!createdAt || EPOCH.test(createdAt));
  const limit = placeholder ? null : rawLimit ?? 0;
  const rawUsage = n(pick(i.status, 'usage'));
  const usage = rawUsage ?? 0;
  return {
    scope: projectId ? 'project' : 'tenant',
    projectId, name: String(i.metadata?.name ?? i.metadata?.id), region: str(pick(i.spec, 'region')), service: str(pick(i.status, 'service')),
    description: str(pick(i.status, 'description')),
    allocation: placeholder ? 'inherits-tenant' : 'set',
    limit, usage,
    usagePercent: limit ? percentOf(rawUsage, limit, n(pick(i.status, 'usagePercentage', 'usage_percentage'))) ?? 0 : null,
    unit: str(pick(i.status, 'unit')), state,
    usageState: usageState?.toLowerCase().replace(/_/g, '-'),
  };
}

export function hintFor(state: CapabilityState, grant: string): string | undefined {
  switch (state) {
    case 'permission-denied':
      return `Refused for this identity: grant ${grant}.`;
    case 'not-found':
      return 'Not found (404): the service may not be offered in this region, or the path changed (check the capability matrix).';
    case 'rejected':
      return 'Rejected (400): the API does not accept this parent for the list. Nothing to grant; see the capability matrix.';
    case 'unreachable':
      return 'No answer after bounded retries (timeout, network, 429 or 5xx). The last good data is kept and marked stale.';
    case 'schema-drift':
      return 'The response no longer matches the documented contract: readable items are used; review the drift list and the mapping.';
    default:
      return undefined;
  }
}
