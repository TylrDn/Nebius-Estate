import { Config } from '@backstage/config';
import { Budget, budgetSchema } from '@internal/nebius-domain';
import { NEBIUS_API, NEBIUS_AUDIT, NEBIUS_LOGGING, NEBIUS_MONITORING } from '../inventory/endpoints';

/**
 * Typed view of the `nebiusEstate` configuration block (portal/app-config*.yaml,
 * schema in config.d.ts). Read once at start-up. There is one runtime: real
 * read-only connectors; nothing is simulated.
 *
 * It fails closed. It refuses to start without access roles; with the guest
 * sign-in provider, a `user:development/*` role or a non-default API endpoint
 * unless the backend listens on loopback only (app-config.local.yaml); and,
 * when the backend is reachable from other hosts, without an explicit project
 * list.
 */

export interface AccessRole {
  name: string;
  /** Entity refs matched against the caller's user ref and ownership refs. */
  principals: string[];
  /** Permission names (nebius.*) or '*' for all nebius permissions. */
  permissions: string[];
  /** Projects this role may see; '*' for all configured projects. */
  projects: string[];
}

export interface NebiusAuthConfig {
  /** Name of an environment variable holding a short-lived IAM access token. */
  tokenEnv?: string;
  /**
   * Names of the environment variables of a read-only service account. The
   * private key comes from a PEM file (privateKeyFileEnv) or inline (privateKeyEnv).
   */
  serviceAccount?: { idEnv: string; publicKeyIdEnv: string; privateKeyFileEnv?: string; privateKeyEnv?: string };
}

export interface KubernetesClusterConfig {
  name: string;
  url: string;
  tokenEnv: string;
  caFile?: string;
  /** Provider id of the MK8s cluster this API server belongs to (explicit mapping). */
  mk8sClusterId?: string;
  dashboardUrl?: string;
  namespaces?: string[];
}

export interface EstateConfig {
  repoRoot: string;
  /** The backend listens on loopback only: a single-operator local run. */
  localOnly: boolean;
  /** Plugin start-up waits for the first sync (scripted checks and tests); default false. */
  waitForFirstSync: boolean;
  roles: AccessRole[];
  nebius?: {
    tenantId?: string;
    /** From `projects` and the comma-separated variable named by `projectIdsEnv`; may be empty (connector not configured). */
    projects: { id: string; name?: string; regions?: string[] }[];
    /** https://api.nebius.cloud unless overridden on a loopback-only backend (the e2e stub). */
    apiEndpoint: string;
    /** Nebius Monitoring PromQL read API (GPU metrics for VMs); on by default. */
    monitoring: { enabled: boolean; endpoint: string };
    /** Nebius Observability Logs, Loki-compatible read API; on by default. */
    logging: { enabled: boolean; endpoint: string };
    /** Nebius Audit Logs read API (tenant audit events); on by default, answers once the tenant grants auditlogs.audit-event-viewer. */
    audit: { enabled: boolean; endpoint: string };
    /** Live list prices from the billing calculator. */
    pricing: { enabled: boolean; currency: string; cacheMinutes: number; tryContractPrice: boolean };
    auth: NebiusAuthConfig;
    syncIntervalMinutes: number;
    timeoutMs: number;
    maxConcurrency: number;
    /** Minimum spacing between request starts per host (rate limit). */
    minRequestIntervalMs: number;
    /** Every Nth scheduled sync reads the slow-tier lists too (1 = always). */
    fullSyncEvery: number;
    /** Seconds between fast re-syncs while something is changing state (0 = off). */
    fastSyncSeconds: number;
    /** Fast re-syncs in a row before the normal cadence applies again. */
    fastSyncMax: number;
    /** List the tenant's projects (tenant-level viewer) to hint at unconfigured ones; scope is unchanged. */
    discoverProjects: boolean;
    /**
     * Managed Kubernetes clusters of the configured projects, found and connected automatically:
     * endpoint and CA from the MK8s API, the portal's own Nebius token as the bearer token.
     */
    mk8s: {
      discover: boolean;
      /** Which control-plane endpoint to use: public (default) or private (backend inside the VPC). */
      endpoint: 'public' | 'private';
      /** A cluster missing from this many consecutive syncs is dropped (its data is kept as stale until then). */
      forgetAfterSyncs: number;
      /** e2e stub only: loopback base that stands in for every discovered endpoint, on a loopback-only backend. */
      testEndpoint?: string;
    };
  };
  kubernetes: KubernetesClusterConfig[];
  prometheus?: { url: string; tokenEnv?: string; timeoutMs: number };
  billing: {
    maxImportBytes: number;
    /** Pull FOCUS files from the export bucket: names of the environment variables, never values. */
    export?: { bucketEnv: string; regionEnv: string; prefixEnv?: string; accessKeyIdEnv: string; secretAccessKeyEnv: string; endpoint?: string };
  };
  /** Rate book for run-rate and provisioning estimates; otherwise the first by id. */
  commercial: { defaultRateBook?: string };
  budgets: Budget[];
}

export class EstateConfigError extends Error {
  constructor(message: string) {
    super(`nebiusEstate configuration: ${message}`);
    this.name = 'EstateConfigError';
  }
}

function httpsUrl(value: string, key: string, allowHttpLocalhost = false): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new EstateConfigError(`${key} is not a URL`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(allowHttpLocalhost && local && u.protocol === 'http:')) {
    throw new EstateConfigError(`${key} must use https`);
  }
  if (u.username || u.password) throw new EstateConfigError(`${key} must not embed credentials`);
  return u.toString().replace(/\/$/, '');
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
function envName(v: string | undefined, key: string): string | undefined {
  if (v === undefined) return undefined;
  if (!ENV_NAME.test(v)) throw new EstateConfigError(`${key} must be an environment variable name`);
  return v;
}

const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
const PROJECT_ID = /^project-[a-z0-9]+$/;

export function readEstateConfig(root: Config, env: NodeJS.ProcessEnv = process.env): EstateConfig {
  const c = root.getOptionalConfig('nebiusEstate');
  if (c?.has('mode')) throw new EstateConfigError('there is no mode setting any more (no demo mode): remove nebiusEstate.mode');
  const localOnly = LOOPBACK.includes(root.getOptionalString('backend.listen.host') ?? '');

  const roles: AccessRole[] = (c?.getOptionalConfigArray('access.roles') ?? []).map(r => ({
    name: r.getString('name'),
    principals: r.getStringArray('principals'),
    permissions: r.getStringArray('permissions'),
    projects: r.getOptionalStringArray('projects') ?? ['*'],
  }));

  const n = c?.getOptionalConfig('nebius');
  const projectId = (id: string) => {
    if (!PROJECT_ID.test(id)) throw new EstateConfigError(`project id ${id} is not a Nebius project id`);
    return id;
  };
  const nebius = n
    ? {
        tenantId: n.getOptionalString('tenantId'),
        projects: dedupeProjects([
          ...(n.getOptionalConfigArray('projects') ?? []).map(p => ({ id: projectId(p.getString('id')), name: p.getOptionalString('name'), regions: p.getOptionalStringArray('regions') })),
          ...(env[envName(n.getOptionalString('projectIdsEnv'), 'nebius.projectIdsEnv') ?? ''] ?? '')
            .split(',')
            .map(x => x.trim())
            .filter(Boolean)
            .map(id => ({ id: projectId(id) })),
        ]),
        apiEndpoint: n.getOptionalString('apiEndpoint') ?? NEBIUS_API,
        monitoring: {
          enabled: n.getOptionalBoolean('monitoring.enabled') ?? true,
          endpoint: n.getOptionalString('monitoring.endpoint') ?? NEBIUS_MONITORING,
        },
        logging: {
          enabled: n.getOptionalBoolean('logging.enabled') ?? true,
          endpoint: n.getOptionalString('logging.endpoint') ?? NEBIUS_LOGGING,
        },
        audit: {
          enabled: n.getOptionalBoolean('audit.enabled') ?? true,
          endpoint: n.getOptionalString('audit.endpoint') ?? NEBIUS_AUDIT,
        },
        pricing: {
          enabled: n.getOptionalBoolean('pricing.enabled') ?? true,
          currency: (() => {
            const code = (n.getOptionalString('pricing.currency') ?? 'usd').toLowerCase();
            if (!/^[a-z]{3}$/.test(code)) throw new EstateConfigError('nebius.pricing.currency must be a three-letter currency code');
            return code;
          })(),
          cacheMinutes: Math.min(24 * 60, Math.max(1, n.getOptionalNumber('pricing.cacheMinutes') ?? 30)),
          tryContractPrice: n.getOptionalBoolean('pricing.tryContractPrice') ?? true,
        },
        auth: {
          tokenEnv: envName(n.getOptionalString('auth.tokenEnv'), 'nebius.auth.tokenEnv'),
          serviceAccount: n.getOptionalConfig('auth.serviceAccount')
            ? {
                idEnv: envName(n.getString('auth.serviceAccount.idEnv'), 'idEnv')!,
                publicKeyIdEnv: envName(n.getString('auth.serviceAccount.publicKeyIdEnv'), 'publicKeyIdEnv')!,
                privateKeyFileEnv: envName(n.getOptionalString('auth.serviceAccount.privateKeyFileEnv'), 'privateKeyFileEnv'),
                privateKeyEnv: envName(n.getOptionalString('auth.serviceAccount.privateKeyEnv'), 'privateKeyEnv'),
              }
            : undefined,
        },
        syncIntervalMinutes: Math.max(5, n.getOptionalNumber('syncIntervalMinutes') ?? 15),
        timeoutMs: Math.min(60_000, n.getOptionalNumber('timeoutMs') ?? 15_000),
        maxConcurrency: Math.min(16, Math.max(1, n.getOptionalNumber('maxConcurrency') ?? 12)),
        minRequestIntervalMs: Math.min(5000, Math.max(0, n.getOptionalNumber('minRequestIntervalMs') ?? 20)),
        fullSyncEvery: Math.min(96, Math.max(1, Math.round(n.getOptionalNumber('fullSyncEvery') ?? 4))),
        fastSyncSeconds: ((v: number) => (v <= 0 ? 0 : Math.min(900, Math.max(60, Math.round(v)))))(n.getOptionalNumber('fastSyncSeconds') ?? 120),
        fastSyncMax: Math.min(200, Math.max(1, Math.round(n.getOptionalNumber('fastSyncMax') ?? 30))),
        discoverProjects: n.getOptionalBoolean('discoverProjects') ?? false,
        mk8s: {
          discover: n.getOptionalBoolean('mk8s.discover') ?? true,
          endpoint: ((): 'public' | 'private' => {
            const e = n.getOptionalString('mk8s.endpoint') ?? 'public';
            if (e !== 'public' && e !== 'private') throw new EstateConfigError('nebius.mk8s.endpoint must be public or private');
            return e;
          })(),
          forgetAfterSyncs: Math.min(100, Math.max(1, Math.round(n.getOptionalNumber('mk8s.forgetAfterSyncs') ?? 3))),
          testEndpoint: n.getOptionalString('mk8s.testEndpoint'),
        },
      }
    : undefined;

  const kubernetes = (c?.getOptionalConfigArray('kubernetes.clusters') ?? []).map(k => ({
    name: k.getString('name'),
    url: httpsUrl(k.getString('url'), `kubernetes.clusters[${k.getString('name')}].url`),
    tokenEnv: envName(k.getString('tokenEnv'), 'tokenEnv')!,
    caFile: k.getOptionalString('caFile'),
    mk8sClusterId: k.getOptionalString('mk8sClusterId'),
    dashboardUrl: k.getOptionalString('dashboardUrl') && httpsUrl(k.getString('dashboardUrl'), `kubernetes.clusters[${k.getString('name')}].dashboardUrl`),
    namespaces: k.getOptionalStringArray('namespaces'),
  }));

  const p = c?.getOptionalConfig('prometheus');
  const prometheus = p
    ? {
        // Prometheus is reached by port-forward in this repository (docs/security.md), so http on localhost is allowed.
        url: httpsUrl(p.getString('url'), 'prometheus.url', true),
        tokenEnv: envName(p.getOptionalString('tokenEnv'), 'prometheus.tokenEnv'),
        timeoutMs: Math.min(30_000, p.getOptionalNumber('timeoutMs') ?? 10_000),
      }
    : undefined;

  // Deprecated (config.d.ts): still read and validated, shown read-only on Budgets & credits.
  const budgets = (c?.getOptionalConfigArray('budgets') ?? []).map(b => {
    const parsed = budgetSchema.safeParse({
      id: b.getString('id'),
      scope: { project: b.getOptionalString('project') },
      amount: b.getString('amount'),
      currency: b.getString('currency'),
      period: b.getString('period'),
      source: b.getString('source'),
    });
    if (!parsed.success) throw new EstateConfigError(`budget ${b.getString('id')}: ${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    return parsed.data;
  });

  const cfg: EstateConfig = {
    repoRoot: c?.getOptionalString('repoRoot') ?? '../../..',
    localOnly,
    waitForFirstSync: c?.getOptionalBoolean('waitForFirstSync') ?? false,
    roles,
    nebius,
    kubernetes,
    prometheus,
    billing: {
      maxImportBytes: Math.min(200 * 1024 * 1024, c?.getOptionalNumber('billing.maxImportBytes') ?? 25 * 1024 * 1024),
      export: c?.getOptionalConfig('billing.export')
        ? {
            bucketEnv: envName(c.getString('billing.export.bucketEnv'), 'billing.export.bucketEnv')!,
            regionEnv: envName(c.getString('billing.export.regionEnv'), 'billing.export.regionEnv')!,
            prefixEnv: envName(c.getOptionalString('billing.export.prefixEnv'), 'billing.export.prefixEnv'),
            accessKeyIdEnv: envName(c.getString('billing.export.accessKeyIdEnv'), 'billing.export.accessKeyIdEnv')!,
            secretAccessKeyEnv: envName(c.getString('billing.export.secretAccessKeyEnv'), 'billing.export.secretAccessKeyEnv')!,
            endpoint: c.getOptionalString('billing.export.endpoint'),
          }
        : undefined,
    },
    commercial: { defaultRateBook: c?.getOptionalString('commercial.defaultRateBook') },
    budgets,
  };

  assertSafe(cfg, root);
  return cfg;
}

/** First mention wins, so a `projects` entry (with name and regions) beats the same id from the variable. */
function dedupeProjects<T extends { id: string }>(ps: T[]): T[] {
  const seen = new Set<string>();
  return ps.filter(p => !seen.has(p.id) && Boolean(seen.add(p.id)));
}

/**
 * The settings that point the backend at a test endpoint (the e2e stub) instead of Nebius, in a fixed order; empty
 * in a live run. The app shows a "Test data — not your tenant" banner whenever any is set (F1.29).
 */
export function testEndpointKeys(cfg: EstateConfig): string[] {
  const n = cfg.nebius;
  const keys: [string, boolean][] = [
    ['nebius.apiEndpoint', Boolean(n && n.apiEndpoint !== NEBIUS_API)],
    ['nebius.monitoring.endpoint', Boolean(n && n.monitoring.endpoint !== NEBIUS_MONITORING)],
    ['nebius.logging.endpoint', Boolean(n && n.logging.endpoint !== NEBIUS_LOGGING)],
    ['nebius.audit.endpoint', Boolean(n && n.audit.endpoint !== NEBIUS_AUDIT)],
    ['nebius.mk8s.testEndpoint', n?.mk8s.testEndpoint !== undefined],
    ['billing.export.endpoint', Boolean(cfg.billing.export?.endpoint)],
  ];
  return keys.filter(([, set]) => set).map(([k]) => k);
}

/** A documented Nebius endpoint, or a loopback one on a loopback-only backend (the e2e stub). */
function testEndpoint(cfg: EstateConfig, value: string, documented: string, key: string): string {
  if (value === documented) return value;
  const u = httpsUrl(value, key, true);
  if (!cfg.localOnly || !LOOPBACK.includes(new URL(u).hostname.replace(/^\[|\]$/g, ''))) {
    throw new EstateConfigError(`${key} may differ from ${documented} only for a loopback endpoint on a loopback-only backend (tests)`);
  }
  return u;
}

/** Fails closed: see the module comment. */
function assertSafe(cfg: EstateConfig, root: Config): void {
  const where = 'unless backend.listen.host is a loopback address (app-config.local.yaml)';
  if (!cfg.roles.length) {
    throw new EstateConfigError('nebiusEstate.access.roles is required (fail closed)');
  }
  if (root.has('auth.providers.guest') && !cfg.localOnly) {
    throw new EstateConfigError(`the guest sign-in provider is refused ${where}; configure a real sign-in provider (docs/portal/security.md)`);
  }
  if (cfg.roles.some(r => r.principals.some(p => p.startsWith('user:development/'))) && !cfg.localOnly) {
    throw new EstateConfigError(`roles granted to the development guest identity are refused ${where}`);
  }
  if (cfg.billing.export?.endpoint) {
    const u = httpsUrl(cfg.billing.export.endpoint, 'billing.export.endpoint', true);
    if (!cfg.localOnly || !LOOPBACK.includes(new URL(u).hostname.replace(/^\[|\]$/g, ''))) {
      throw new EstateConfigError('billing.export.endpoint is for a loopback test endpoint on a loopback-only backend; production derives it from the bucket region');
    }
    cfg.billing.export.endpoint = u;
  }
  if (cfg.nebius) {
    cfg.nebius.apiEndpoint = testEndpoint(cfg, cfg.nebius.apiEndpoint, NEBIUS_API, 'nebius.apiEndpoint');
    cfg.nebius.monitoring.endpoint = testEndpoint(cfg, cfg.nebius.monitoring.endpoint, NEBIUS_MONITORING, 'nebius.monitoring.endpoint');
    cfg.nebius.logging.endpoint = testEndpoint(cfg, cfg.nebius.logging.endpoint, NEBIUS_LOGGING, 'nebius.logging.endpoint');
    cfg.nebius.audit.endpoint = testEndpoint(cfg, cfg.nebius.audit.endpoint, NEBIUS_AUDIT, 'nebius.audit.endpoint');
    if (cfg.nebius.mk8s.testEndpoint !== undefined) {
      const u = httpsUrl(cfg.nebius.mk8s.testEndpoint, 'nebius.mk8s.testEndpoint', true);
      if (!cfg.localOnly || !LOOPBACK.includes(new URL(u).hostname.replace(/^\[|\]$/g, ''))) {
        throw new EstateConfigError('nebius.mk8s.testEndpoint is for a loopback test endpoint on a loopback-only backend; production uses the endpoints the MK8s API reports');
      }
      cfg.nebius.mk8s.testEndpoint = u.replace(/\/$/, '');
    }
  }
  if (!cfg.localOnly && !cfg.nebius?.projects.length) {
    throw new EstateConfigError('nebiusEstate.nebius.projects (or projectIdsEnv) is required when the backend is reachable from other hosts (explicit project scope)');
  }
}
