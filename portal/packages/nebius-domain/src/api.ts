import { z } from 'zod';
import type { CostReport, ExportCadence, ExportHealth, IngestSummary } from './billing';
import type { Money } from './money';
import type { AllowanceFinding, AvailabilityCheck, QuotaCheckLine, QuotaRequirement } from './capacity';
import type { CapabilityRow } from './coverage';
import type { HistoryPoint } from './history';
import type { RateBook, RunRateResult, Scenario } from './pricing';
import type { ChangePreview, PolicyIssue, RecipeDefinition } from './provisioning';
import type { Attribution, ObservedResource, ResourceGraph, TtlState } from './resources';
import type { RecipeView, RunProfile, StagePolicy } from './repo';
import type { RunLevel } from './proof';

/**
 * Backend HTTP contracts (JSON), shared by the backend plugin and the
 * frontend. The backend validates every request body and query with zod.
 */

/**
 * The global project / region / stage filter: URL parameters in the app and
 * query parameters on every filtered backend route.
 */
export const globalFilterSchema = z.object({
  // Messages in words: they reach the page (a 400 from a form), never the raw pattern (F1.17).
  project: z.string().regex(/^project-[a-z0-9]+$/, 'not a project id (project- and lower-case letters or digits)').optional(),
  region: z.string().regex(/^[a-z]{2}-[a-z]+\d$/, 'not a Nebius region id such as eu-north1').optional(),
  stage: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'not a stage name (lower-case letters, digits and dashes)').optional(),
});
export type GlobalFilter = z.infer<typeof globalFilterSchema>;

/**
 * One independently sourced number. `value` is null when the source is
 * absent; the UI then shows "Unavailable" with `unavailableReason`, never 0.
 */
export interface SourcedMetric<T = number> {
  value: T | null;
  unit?: string;
  source: string;
  observedAt?: string;
  unavailableReason?: string;
  note?: string;
  /**
   * With value null: the source answered and there is nothing to measure ("No GPUs running"). Shown as this text with
   * `unavailableReason` as the detail, never as "Unavailable" with a setup prompt.
   */
  empty?: string;
}

/** One recorded run of a connector or capability. */
export interface SyncRun {
  at: string;
  ok: boolean;
  durationMs: number;
  /** CapabilityState for capabilities; 'error' / 'permission-denied' for connectors. */
  errorClass?: string;
  httpStatus?: number;
  items?: number;
}

/**
 * Health derived from recorded runs (kept 7 days in the portal database).
 * Rates and percentiles are over the last 24 h; null when there was no run.
 */
export interface HealthStats {
  runs24h: number;
  successRate24h: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  lastDurationMs?: number;
  consecutiveFailures: number;
  /** Failed runs in the last 24 h (not-configured and waiting runs are not failures). */
  failures24h?: number;
  /** The newest failed run, whenever it was (within retention). */
  lastFailureAt?: string;
  nextRunAt?: string;
  /** Why the next run comes sooner than the configured cadence, e.g. "a cluster is provisioning" (fast re-sync). */
  nextRunReason?: string;
  /** Newest first, at most 20. */
  recentRuns: SyncRun[];
}

export interface ConnectorStatus {
  id: string;
  title: string;
  /**
   * optional: needs infrastructure this deployment may not run (e.g. a Kubernetes cluster); not a misconfiguration.
   * not-needed: an alternative source already covers it (e.g. an external Prometheus while Nebius Monitoring supplies GPU telemetry); complete, not a gap.
   * starting: configured, first sync not finished yet (after a restart); not stale, nothing failed.
   * waiting: the target exists but is not ready (a cluster still PROVISIONING); connected automatically later.
   * degraded: some calls of the last sync got no answer (`calls`), or under 90 % of its runs succeeded in the last 24 h.
   */
  state: 'ok' | 'stale' | 'error' | 'permission-denied' | 'not-configured' | 'optional' | 'waiting' | 'disabled' | 'starting' | 'not-needed' | 'degraded';
  /** Short scope summary, e.g. "9 projects" or "all namespaces". */
  scope: string;
  /** The projects behind the summary (names from the API when known), for connectors scoped by project. */
  projects?: { id: string; name?: string }[];
  permissions: string;
  services: string[];
  lastAttempt?: string;
  lastSuccess?: string;
  freshnessMinutes?: number;
  staleAfterMinutes: number;
  error?: string;
  /**
   * Calls (one per API list, as "Calls at the last sync" counts them) of the last sync, and how many got no answer
   * (network, timeout, 429/5xx after retries; refusals answered).
   */
  calls?: { total: number; failed: number };
  /** How many errors `error` stands for; it keeps the first few, "; "-separated. */
  errorCount?: number;
  missingCoverage: string[];
  /** Facts about the last sync worth knowing (e.g. "reconnected: the cluster CA changed"). */
  notes?: string[];
  setup: string;
  /** A sync of this connector is running now (a manual sync is refused with 409 meanwhile). */
  running?: boolean;
  runningSince?: string;
  health?: HealthStats;
}

/** One GPU's latest telemetry, with the source of every number. */
export interface GpuTelemetryView {
  instanceId?: string;
  instanceName?: string;
  node: string;
  gpu?: string;
  projectId?: string;
  utilPercent?: number;
  tempC?: number;
  powerW?: number;
  memoryUsedMiB?: number;
  memoryTotalMiB?: number;
  /** MK8s cluster and node group of the VM (labels mk8s_cluster_id / mk8s_node_group_id on the agent's series). */
  mk8sClusterId?: string;
  mk8sNodeGroupId?: string;
  source: string;
}

/* ------------------------------------------------------------ capabilities */

/**
 * The state of one read-only API capability for this deployment's identity, from the last sync:
 * - ok: answered; `items` counted.
 * - permission-denied: 401/403; `hint` names the role to grant.
 * - not-found: 404 (e.g. not offered in the region, or no data written yet where noted).
 * - rejected: 400 (the API refuses this parent; see `hint`).
 * - unreachable: timeout, network error, or 429/5xx after bounded retries.
 * - schema-drift: answered, but items did not match the documented contract (`drift`).
 * - not-configured: not attempted (no projects, no tenant id, or switched off).
 */
export type CapabilityState = 'ok' | 'permission-denied' | 'not-found' | 'rejected' | 'unreachable' | 'schema-drift' | 'not-configured';

export interface CapabilityStatus {
  id: string;
  title: string;
  /** Service group, e.g. compute, vpc, quotas. */
  service: string;
  /** The connector that makes the call. */
  connector: 'nebius-inventory' | 'nebius-monitoring' | 'nebius-metrics-history' | 'nebius-logging' | 'nebius-audit' | 'nebius-pricing' | 'billing-object-storage' | 'token-factory' | 'huggingface' | `mk8s:${string}`;
  /** What the call is made against (cluster: each Managed Kubernetes cluster of the listed projects). */
  scope: 'project' | 'tenant' | 'cluster';
  /** Documented REST path (or the base path of a non-REST source). */
  path: string;
  method: 'GET' | 'POST';
  state: CapabilityState;
  items?: number;
  latencyMs?: number;
  lastAttempt?: string;
  lastSuccess?: string;
  lastError?: string;
  hint?: string;
  drift?: string[];
  /** Per-project outcome when the capability is project-scoped and outcomes differ. */
  perProject?: { id: string; name?: string; state: CapabilityState; items?: number; error?: string }[];
  /** Verified against a live account (project viewer) on the given date, or never. */
  verified?: string;
  /** Data kept from the last success while the latest attempt failed. */
  stale?: boolean;
  health?: HealthStats;
}

/* ---------------------------------------------------------------- capacity */

/**
 * One quota allowance. Tenant allowances are what enforcement checks: proto3 JSON omits zero, so an
 * absent tenant `spec.limit` is 0 (verified live: QuotaFailure limit "0"). A project entry is either an
 * allocation (it has an id or a state and a limit; an absent limit is 0, a real cap of 0) or a placeholder
 * (no id, epoch created_at, no limit, no state): no project allocation is set and the project draws on
 * the tenant quota of that region (verified live 2026-10-11: a preemptible L40S node ran under such placeholders).
 */
export interface QuotaAllowanceView {
  /** Tenant allowances are what enforcement checks; project allowances are allocations beneath them. */
  scope: 'tenant' | 'project';
  /** The project, or '' for a tenant allowance. */
  projectId: string;
  name: string;
  region?: string;
  service?: string;
  description?: string;
  /** set: a limit is in force (every tenant allowance; a real project allocation). inherits-tenant: a project placeholder. */
  allocation: 'set' | 'inherits-tenant';
  /** The limit in force; null only for an inherits-tenant placeholder (no project limit exists; never read as 0). */
  limit: number | null;
  /** Absent status.usage is 0. A tenant allowance takes the sum of its projects when they report more (reconcileTenantUsage). */
  usage: number;
  /** A tenant allowance's own usage figure, when the projects beneath it report more (then `usage` is their sum). */
  reportedUsage?: number;
  /** null when the limit is 0 or not set (no percentage of nothing). */
  usagePercent: number | null;
  unit?: string;
  state?: string;
  /** used | not-used | not-applicable | unknown (status.usageState). */
  usageState?: string;
  /**
   * For an inherits-tenant placeholder: the tenant allowance of the same quota and region it draws on,
   * when it was read (unrestricted callers only). Headroom is computed against this.
   */
  tenant?: { limit: number; usage: number; usagePercent: number | null };
}

export interface CapacityAllowanceView {
  projectId: string;
  name: string;
  capacityBlockGroupId?: string;
  limit: number | null;
  usage: number | null;
  usagePercent: number | null;
  unit?: string;
  state?: string;
}

export interface PlatformView {
  name: string;
  humanName?: string;
  gpuMemoryGibibytes?: number;
  presets: { name: string; gpus: number; vcpus: number; memoryGibibytes: number }[];
  projects: string[];
  /** Regions of the projects that listed the platform. */
  regions: string[];
}

export interface CapacityBlockGroupView {
  id: string;
  name: string;
  region?: string;
  service?: string;
  platform?: string;
  fabric?: string;
  limit: number | null;
  usage: number | null;
  state?: string;
  nextChangeAt?: string;
}

/** Availability of one capacity type: level high | medium | low | limit-reached | unknown; dataState fresh | stale | unknown. */
export interface AdviceAvailability {
  level?: string;
  available?: number;
  limit?: number;
  dataState?: string;
  effectiveAt?: string;
}

/** Capacity advice for one region × fabric × platform × preset (tenant-level, needs tenant `viewer`). */
export interface ResourceAdviceView {
  region?: string;
  fabric?: string;
  platform?: string;
  preset?: string;
  gpus?: number;
  onDemand?: AdviceAvailability;
  preemptible?: AdviceAvailability;
  reserved?: AdviceAvailability;
}

export interface MaintenanceView {
  id: string;
  name: string;
  projectId: string;
  state?: string;
  scheduledAt?: string;
  startedAt?: string;
  finishedAt?: string;
  affected: string[];
}

/* -------------------------------------------------------------- live prices */

/** A list price from the Nebius billing calculator (estimate-batch). Never a quote. */
export interface LivePriceLine {
  key: string;
  description: string;
  count: number;
  /** Per hour for time-based SKUs; null when the calculator reports usage-based pricing. */
  hourly: Money | null;
  unit?: string;
  skus: { skuId: string; quantity: string; cost: string }[];
  note?: string;
  /** With a contract price: the list price of the same line, for comparison. */
  listHourly?: Money | null;
  /** A VM line's capacity type as priced (F1.41); also at the end of its description. */
  capacityType?: 'preemptible' | 'on-demand';
}

export interface LivePriceEstimate {
  source: 'Nebius billing calculator (list price)' | 'Nebius billing calculator (contract price)';
  offer: 'list' | 'contract';
  asOf: string;
  currency: string;
  projectId: string;
  lines: LivePriceLine[];
  hourly: Money | null;
  /** Why the contract price was not used, when it was asked for. */
  contractNote?: string;
  /** Whether a contract price was tried, and whether it was available to this identity (null: not tried). */
  contract: { attempted: boolean; available: boolean | null };
  /** With a contract price: the list-price total of the same lines (equal when the account pays list). */
  listHourly?: Money | null;
  unpriced: string[];
  /** A footprint's capacity type as requested and priced, in words for the header (F1.41); absent for the run-rate. */
  capacity?: { type: 'preemptible' | 'on-demand' | 'reserved'; text: string };
}

export interface LivePriceResponse {
  value: LivePriceEstimate | null;
  unavailableReason?: string;
  /**
   * Set (with value null) when the calculator is configured and the synced inventory has nothing running in scope:
   * the run-rate is 0 in this currency, not unknown, and nothing needs setting up.
   */
  nothingRunning?: { currency: string };
  /** With `nothingRunning`: when the inventory lists that found nothing to price answered. */
  observedAt?: string;
  /**
   * Set (with value null) when the footprint asks for nothing (`footprintIsEmpty`): its price is 0 in this currency,
   * known without asking the calculator (F1.18).
   */
  emptyFootprint?: { currency: string };
}

export interface OverviewResponse {
  /** The global filter matches no project although the inventory has some (e.g. a stage nobody uses): one reason for the whole page. */
  emptyScope?: string;
  /**
   * Clusters whose running GPU VMs advertise fewer allocatable GPUs (nvidia.com/gpu) than they have. A check to
   * make (drivers preset, device plugin), not a diagnosis.
   */
  gpuSchedulingChecks?: { cluster: string; clusterId: string; nodeGroups: string[]; gpuVms: number; gpus: number; allocatable: number }[];
  generatedAt: string;
  projects: SourcedMetric<string[]>;
  regions: SourcedMetric<string[]>;
  gpuInventory: SourcedMetric<{ gpus: number; byPlatform: Record<string, number> }>;
  cpuInventory: SourcedMetric<{ vcpus: number }>;
  k8sAllocatableGpus: SourcedMetric;
  k8sRequestedGpus: SourcedMetric;
  gpuUtilization: SourcedMetric<{ meanPercent: number; gpusReporting: number }>;
  pendingGpuPods: SourcedMetric;
  pendingProvisioningRequests: SourcedMetric;
  ttlExpired: SourcedMetric;
  orphanCandidates: SourcedMetric;
  /**
   * Quota allowances at or above 80 % use (nearLimitCheck, the count Capacity shows). `coverage.checked` allowances
   * were judged (limit 0 included, `zeroLimit` of them) of `coverage.total` read; `summary` is nearLimitText without the above-limit count, which has its own Overview row (F1.11).
   */
  quotasNearLimit: SourcedMetric<QuotaAllowanceView[]> & { coverage?: { checked: number; total: number; zeroLimit?: number; summary?: string } };
  /** Quota allowances in use above their limit, a limit of 0 included (nearLimitCheck.aboveLimit, flagged on Capacity too): its own attention row (F1.11). */
  quotasAboveLimit?: SourcedMetric<QuotaAllowanceView[]>;
  /** Planned resources (live sizing files) whose quota is 0 (blocked) or would be exceeded. */
  plannedQuotaIssues: SourcedMetric<PlannedQuotaIssue[]>;
  /** Real project caps that differ from the tenant limit (no effect, caps below, cap 0); unrestricted callers only. */
  allowanceCheck?: SourcedMetric<AllowanceFinding[]>;
  /** Per-GPU telemetry in scope (same as GET /capacity), so the Overview needs no second call. */
  gpuTelemetry: SourcedMetric<GpuTelemetryView[]>;
  maintenances: SourcedMetric<MaintenanceView[]>;
  connectors: ConnectorStatus[];
}

export interface ResourceView extends ObservedResource {
  attribution: Attribution;
  ttl: TtlState;
  orphanReasons?: string[];
  /** Why the resource is not (yet) an orphan candidate although a rule matched or it was not evaluated. */
  orphanNote?: string;
  desiredStateLink?: { liveRoot: string; sizingFile: string };
  docs?: { title: string; path: string }[];
  /** Its list was not read (or failed) on the latest inventory sync: the time it was last seen; it may be gone. */
  lastSeen?: string;
}

export interface CoverageEntry {
  connector: string;
  /** The project this entry covers, when per project. */
  project?: { id: string; name?: string };
  services: string[];
  partial: boolean;
  note?: string;
  /** The lists that hid resources, as "<catalog id> (403)" or "(unreachable)": carried by a sync that skips them (W1F.S7). */
  failed?: string[];
}

export interface ResourceListResponse {
  items: ResourceView[];
  total: number;
  coverage: CoverageEntry[];
  observedAt?: string;
}

export interface ResourceDetail extends ResourceView {
  /** Resources this one refers to (`out`) or that refer to it (`in`), with the relation. */
  related: { uid: string; name: string; type: string; relation: string; direction: 'in' | 'out' }[];
}

export interface GraphResponse extends ResourceGraph {
}

export const EVIDENCE_KINDS = [
  'mocked-plan-test',
  'static-validation',
  'upstream-live',
  'repo-live',
  'not-measured',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_KIND_LABELS: Record<EvidenceKind, string> = {
  'mocked-plan-test': 'Mocked plan test',
  'static-validation': 'Static validation (CI)',
  'upstream-live': 'Prior live run of the upstream recipe',
  'repo-live': 'Live run of this repository',
  'not-measured': 'Not yet measured',
};

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  title: string;
  path?: string;
  date?: string;
  region?: string;
  versions?: string;
  method?: string;
  cost?: string;
  limitations?: string;
  proves?: string;
  recipe?: string;
  /** Every recipe the run covers (the R-numbers in the README's Run column); `recipe` is the first. */
  recipes?: string[];
  /** A run of one of this repository's live roots (terraform/live/<stage>/<stack>), from the file's Kind header. */
  liveRoot?: string;
  /** What a run of this repository shows (`repo-live` only): a measurement, a run, or a read / plan (W1-P11). */
  level?: RunLevel;
}

export interface RunbookItem {
  id: string;
  title: string;
  path: string;
  summary: string;
}

export interface DocumentResponse {
  path: string;
  markdown: string;
}

export interface WorkloadSummary {
  cluster: string;
  namespace: string;
  name: string;
  kind: string;
  replicas?: number;
  readyReplicas?: number;
  gpuRequest: number;
  requests: Record<string, string>;
  limits: Record<string, string>;
  pendingPods: number;
  schedulingMessages: string[];
  /** Container restarts summed over the workload's pods (pod status); absent when the backend does not report it. */
  restarts?: number;
  /** Why the workload's containers wait (e.g. CrashLoopBackOff), from pod status; absent when not reported. */
  podIssues?: string[];
  /** A Job's outcome from its Failed / Complete conditions, with its failed pod count (status.failed); Jobs only. */
  job?: { outcome: 'running' | 'complete' | 'failed'; reason?: string; failedPods?: number };
  nodeSelector: Record<string, string>;
  tolerations: string[];
  recipe?: string;
  uid: string;
}

export interface WorkloadsResponse {
  /**
   * `staleReason`: why the cluster's snapshot is not current when its lifecycle explains it ("Cluster is being deleted
   * (inventory 10:56 UTC)"; clusterLifecycleReason in resources.ts); `error` carries it too, with any sync error.
   */
  clusters: {
    name: string;
    configured: boolean;
    dashboardUrl?: string;
    observedAt?: string;
    error?: string;
    staleReason?: string;
    /** Namespaces the portal reads in this cluster (the configured allowlist, when one is set). */
    namespaces: string[];
    /** Nodes with their state: `ready` is the Ready condition (absent when not reported), cordoned, deleting. */
    nodes: { name: string; nodeGroupId?: string; gpus: number; ready?: boolean; cordoned: boolean; deleting: boolean }[];
  }[];
  workloads: WorkloadSummary[];
  /**
   * Soperator (Slurm on Kubernetes) clusters in scope: an MK8s cluster labelled nip-stack=soperator or named for it, or a
   * cluster whose Kubernetes snapshot has a soperator namespace. The page shows its Soperator card only when one exists.
   */
  soperatorClusters: string[];
  /** When the inventory last read the cloud: the as-of time of "No Kubernetes cluster in scope". */
  inventoryObservedAt?: string;
  events: { cluster: string; namespace: string; involved: string; reason: string; message: string; type: string; lastSeen: string }[];
  slurm: { available: false; reason: string };
}

export interface NodeGroupCapacity {
  uid: string;
  cluster: string;
  name: string;
  platform?: string;
  preset?: string;
  gpusPerNode: number;
  nodes: number;
  fixedNodeCount?: number;
  autoscaling?: { min: number; max: number };
  capacityType: 'on-demand' | 'preemptible' | 'reserved' | 'unknown';
  fabric?: string;
  projectId?: string;
  region?: string;
  /** Mean GPU utilisation of the group's GPUs that report (Nebius Monitoring); absent when none report. */
  gpuUtil?: { meanPercent: number; gpusReporting: number };
}

export interface CapacityResponse {
  /** The global filter selects no project (e.g. a project and a region it is not in): one reason, said once (G2.10). */
  emptyScope?: string;
  gpusPresent: SourcedMetric;
  quotas: SourcedMetric<QuotaAllowanceView[]>;
  capacityAllowances: SourcedMetric<CapacityAllowanceView[]>;
  capacityBlockGroups: SourcedMetric<CapacityBlockGroupView[]>;
  /**
   * Block groups the region filter hides (tenant callers, a region filter active): an allowance naming one reads
   * "in eu-north1, outside the filter", not as a block group the API leaves out (F1.10).
   */
  blockGroupsOutsideFilter?: { id: string; name: string; region?: string }[];
  resourceAdvice: SourcedMetric<ResourceAdviceView[]>;
  platforms: SourcedMetric<PlatformView[]>;
  gpuTelemetry: SourcedMetric<GpuTelemetryView[]>;
  nodeGroups: NodeGroupCapacity[];
  /** When the cluster and node-group lists were read: the table's as-of time, also when it is empty (followup 53). */
  nodeGroupsObservedAt?: string;
  /** Every standalone GPU VM with its status; only running ones count toward `gpusPresent` (G2.7). */
  standaloneGpuVms: { uid: string; name: string; platform?: string; preset?: string; gpus: number; capacityType: string; status: string }[];
  requests: SourcedMetric<{ requestedGpus: number; pendingGpuPods: number }>;
  utilization: SourcedMetric<{ meanPercent: number; perNode: { node: string; percent: number }[] }>;
  /** Planned resources blocked by quota: the same check (and scope) as the Overview's tile. */
  plannedQuotaIssues?: SourcedMetric<PlannedQuotaIssue[]>;
  /** Real project caps against the tenant limit: the same check as the Overview's row. */
  allowanceCheck?: SourcedMetric<AllowanceFinding[]>;
  /** Scheduled maintenance in scope: the same list as the Overview's tile. */
  maintenances?: SourcedMetric<MaintenanceView[]>;
  /** Why no tenant quota allowances are in hand (tenantAllowancesGap), when none are; for the Quotas footnote (F1.33). */
  tenantQuotasGap?: string;
}

export interface Meta {
  user: string;
  scope: string[];
  permissions: Record<string, boolean>;
  /** Set only when the backend reads a test endpoint (the e2e stub): the settings that point there. Never in a live run. */
  testData?: { endpoints: string[] };
}

export interface FilterOptions {
  projects: { id: string; name: string }[];
  regions: string[];
  stages: string[];
  /** The first inventory sync has not finished: the scope is not known yet, so no link value is judged by it (#32). */
  pending?: true;
}

export interface HistoryResponse {
  days: number;
  points: HistoryPoint[];
  source: string;
  note: string;
}

export interface EvidenceResponse {
  items: EvidenceItem[];
  runbooks: RunbookItem[];
  decisions: RunbookItem[];
  recipes: RecipeView[];
}

export interface IntegrationsResponse {
  statuses: ConnectorStatus[];
  capabilities: CapabilityStatus[];
  /** Projects in the tenant that are not configured (discovery hint; never added to the scope). */
  unconfiguredProjects?: { id: string; name?: string; region?: string }[];
  coverage: CoverageEntry[];
  matrix: CapabilityRow[];
  canAdminister: boolean;
  /**
   * Managed Kubernetes clusters in scope identified as Soperator clusters (labelled nip-stack=soperator, named for it,
   * or with a soperator namespace): the docs coverage reads Slurm through their calls only (W1-P26).
   */
  soperatorClusterIds?: string[];
}

export interface SyncResponse {
  ok: true;
  note?: string;
}

export interface ListResponse<T> {
  items: T[];
}

export interface RecipesResponse {
  recipes: (RecipeDefinition & { stages: string[] })[];
  regions: {
    id: string;
    note?: string;
    default: string;
    platforms: { id: string; single_gpu_preset?: string; ib_preset?: string; fabric?: string; fabrics?: string[] }[];
  }[];
  stages: Record<string, StagePolicy>;
  sizing: { stage: string; stack: string; sizingFile: string; sizing: Record<string, string | number | boolean | null>; runProfiles?: RunProfile[] }[];
  /** Every recipe (R1–R16), so the page can say how each one without a form is offered. */
  catalog: RecipeView[];
}

/** One planned resource against a tenant quota allowance. */
export interface PlannedQuotaIssue {
  /** terraform/live/<stage>/<stack>, or the provisioning request. */
  plan: string;
  region: string;
  quota: string;
  description?: string;
  need: number;
  limit: number;
  usage: number;
  state: 'blocked' | 'exceeded';
  what: string;
  /** Why this region: where the root runs, or its run profile's region (the root is not applied yet). */
  regionBasis?: 'observed' | 'profile';
  /** The run profile whose vars sized the check (platform/profiles/<stack>/<profile>.json), when one did (G2.2). */
  profile?: string;
}

/** A previewed footprint against the quota allowances of its region (tenant level, as enforced). */
export interface QuotaCheck {
  region: string;
  /** Where the limits came from; none when no allowance list could be read. */
  source: 'tenant' | 'none';
  lines: (QuotaCheckLine & { description?: string })[];
  unchecked: QuotaRequirement[];
  reason?: string;
  /** When the tenant allowances were read: their own last success, not the snapshot time (#13). */
  observedAt?: string;
  /** Said when the latest read failed and the figures are from an earlier one. */
  note?: string;
}

/** A region where the same request fits, by the tenant allowances the quota API lists there (W1-P3). */
export interface FitsInRegion {
  region: string;
  /** The GPU platform the request would use there (the requested one when offered, else the region's default). */
  platform: string;
  /** Quota lines checked there, all within their limit. */
  checked: number;
  /** Requirements with no allowance listed there (never compute VMs: those must be checked). */
  unchecked: string[];
}

/** A reserved request against the tenant's capacity block groups (capacity.v1), W1-P4. */
export interface ReservationCheck {
  policy: 'AUTO' | 'STRICT';
  region: string;
  platform: string;
  /** matching: block groups of this region and platform; none: the tenant lists none; unknown: not read. */
  state: 'matching' | 'none' | 'unknown';
  groups: CapacityBlockGroupView[];
  message: string;
  observedAt?: string;
}

export interface PreviewResponse {
  issues: PolicyIssue[];
  change?: ChangePreview;
  quotaCheck?: QuotaCheck;
  /** The capacity advisor's view of the requested GPU nodes (tenant-level advice; absent when not read). */
  availability?: AvailabilityCheck;
  /** Reserved capacity against the tenant's capacity block groups (W1-P4). */
  reservations?: ReservationCheck;
  /** Where else the request fits by the quota API, when a quota stops it here (W1-P3). */
  fitsIn?: FitsInRegion[];
  baseHashes: Record<string, string>;
  commit?: string;
}

export interface BillingSummaryResponse {
  report: CostReport;
  daily: CostReport;
  metricDescription: string;
  health: ExportHealth;
  /** Stored rows for the project / region selection over any range: an empty range is not an empty export. */
  rowsAnyRange: number;
  /**
   * Stored rows the caller may see, whatever the project, region or range: a project without rows is not an empty
   * export (G4.1).
   */
  importedRows: number;
  /**
   * The last exported hour of the rows in the selection and range: where the reporting period ends. `health` keeps
   * the whole export's `exportedThrough` for lag and coverage (G1.3). Absent when the range holds no row (G4.2).
   */
  periodThrough?: string;
  /** Rows charged for more than a day (month-long tax): in the totals, not on the daily axis (G4.10). */
  dailyExcluded?: { rows: number; totals: Money[]; categories: string[] };
  /**
   * With a project or region filter: the last exported hour of that selection (its last usage). `health` dates the
   * export as a whole, so an idle project never reads as a stale export (G1.3).
   */
  selectionLastUsage?: string;
  /** The export pull connector, so an empty page can say whether it is set up and what it waits for. */
  exportPull?: {
    state: ConnectorStatus['state'];
    scope: string;
    lastSuccess?: string;
    note?: string;
    /** The pull's next scheduled run (#12). */
    nextRunAt?: string;
    /** The next export file, estimated from the last arrivals; absent when the cadence cannot be observed (#12). */
    nextFile?: ExportCadence;
  };
  kind: 'reported';
  note: string;
}

export interface ImportRecord {
  id: string;
  importedAt: string;
  importedBy: string;
  filename: string;
  summary: IngestSummary & { errors: { row: number; message: string }[]; unknownColumns: string[] };
}

export interface RateBookSummary {
  id: string;
  name: string;
  kind: RateBook['kind'];
  classification: RateBook['classification'];
  currency: string;
  entries: number;
  discountRules: RateBook['discountRules'];
  note?: string;
  /** Kept for the scenarios that price with it; never a default, not offered for a new scenario (W1-P8). */
  archived: boolean;
  /** The portal default, stored in the database (W1-P8); a configured default still wins. */
  isDefault: boolean;
}

export type ScenarioRecord = Scenario & { createdBy: string; updatedAt: string };

/**
 * Which rate book prices the run-rate (and provisioning estimates), and why (G4.5): asked for, set in the
 * configuration, the only one imported, or the first of several by id when no default is configured.
 */
/** The built-in price source (W1-P6): the live calculator's list price, offered beside the rate books. */
export interface BuiltInPriceSource {
  id: string;
  name: string;
  /** The calculator's currency (nebius.pricing.currency). */
  currency: string;
  /** False without the Nebius connector; `reason` then says why. */
  available: boolean;
  reason?: string;
}

export interface RateBookChoice {
  id: string;
  name: string;
  how: 'requested' | 'configured' | 'portal-default' | 'only' | 'first-by-id';
  text: string;
}

export interface RunRateResponse {
  value: RunRateResult | null;
  unavailableReason?: string;
  /** No active rate book, and the live list price prices the run-rate without one: the user rate book is optional. */
  rateBookOptional?: boolean;
  observedAt?: string;
  rateBookChoice?: RateBookChoice;
}
