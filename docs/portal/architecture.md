# Nebius Estate — architecture

```text
 browser (React, Backstage new frontend system)
   │  fetchApi: the user's Backstage token; never a cloud credential
   ▼
 Backstage backend (Node 24, one replica) ───────────────────────────────────────────────────
   auth (guest only on a loopback-only local run) · permission backend + NebiusRolePolicy (default deny for nebius.*)
   │
   └─ nebius-estate-backend (/api/nebius-estate)
       InventoryService (snapshot, connector and capability status, in memory; runs in the database)
        ├─ NebiusInventoryConnector ── https://api.nebius.cloud: every catalog list (GET, pageToken)
        ├─ NebiusMonitoringConnector ─ https://read.monitoring.api.nebius.cloud (PromQL, GPU metrics)
        ├─ NebiusCalculator ────────── https://api.nebius.cloud billing calculator (the only POST)
        ├─ BillingExportPuller ─────── https://storage.<region>.nebius.cloud export bucket (SigV4, GET) → FOCUS import
        ├─ KubernetesConnector ─────── configured API servers (read-only token, optional)
        ├─ discovered MK8s clusters ─── https://<pu|pr>.<cluster>.mk8s.<region>.nebius.cloud (endpoint + CA from the MK8s API, Nebius token)
        ├─ PrometheusConnector ─────── an external Prometheus (explicit config; not needed when unset)
        ├─ TelemetryRecorder (ext.) ── Nebius Monitoring query_range → GPU sample store; storage and volume figures
        └─ LogsExtension (ext.) ────── https://read.logging.api.nebius.cloud (Loki labels; lines read on demand)
       AlertEngine (after each sync) ─ platform/alerts/*.yaml + platform/alerts/portal/*.yaml → alert store → notifiers
       RepoReader (allowlisted, read-only) ─ platform/*.yaml, live sizing files, docs, runbooks
       ProvisioningStore · HistoryStore · CommercialStore · HealthStore · SampleStore · AlertStore ── portal database (knex migrations)
       commercial/: FOCUS import and reports (SQL-filtered), rate books, scenarios, run-rate
   ▼
 @internal/nebius-domain (pure logic and the HTTP contracts, shared with the frontend)
```

**One replica.** The inventory snapshot and connector states live in process memory, and the sync
task is scheduled per process (`scope: local`). Run exactly one backend replica; a second one would
serve its own snapshot and call the APIs twice. Everything that must survive a restart is in the
database.

**Configuration.** `app-config.yaml` is the base. `app-config.local.yaml` adds one operator's run
(loopback bind, guest sign-in, SQLite files in `portal/.local-data/`, a local role, credential and
project variable names) and is what `yarn start` loads. A served deployment uses
`app-config.production.yaml`, which still requires the backend/frontend identity integration described
in [security](security.md#identity). In the operator path every connector is real and read-only, and an
unconfigured one says so. The separate `make portal-demo` command loads the synthetic REST stub and
isolated test configuration on loopback; every page identifies test data. The `nebiusEstate` block is typed in
`plugins/nebius-estate-backend/config.d.ts` and read once by `readEstateConfig`, which fails closed
([security](security.md#identity)).

**Tests** use `portal/e2e-stub/`: `stubApi.js` answers every catalog list, projects by id, the
Monitoring PromQL query and the billing calculator in the documented shapes, with invented data
(`e00mock` ids, XTS prices) — including refused tenant-level lists and secret values that must never
be copied. Unit tests serve it through a mocked `fetch`; the Playwright suite starts it with
`nebius-stub.mjs` and runs the portal with `e2e-stub/app-config.e2e.yaml` on ports 3100/7107.

## What the portal reads from the repository

`RepoReader` reads a fixed allowlist of paths (`ALLOWED` in `repo/RepoReader.ts`), resolved inside the
repository root, symlinks included. The model behind every page is cached for five seconds, so a new
commit in the checkout shows up without a restart.

| Source | Used for |
|---|---|
| `platform/stages.yaml` | stage list and policy (GPU caps, TTL, reservations), the global stage filter, provisioning validation |
| `platform/regions.yaml` | regions, GPU platforms and presets, fabrics, accepted Kubernetes versions |
| `platform/versions.yaml` | pinned versions (duplicate top-level keys are merged and reported) |
| `terraform/live/<stage>/<stack>/<stage>.auto.tfvars` (the seven rendered stacks: inference, training, network, data, gpu-vm, ml-services, governance; `STACKS` in `nebius-domain/src/repo.ts`) and `terraform/live/<stage>/soperator/stage.tfvars` | live roots, their sizing, and whether mocked plan tests exist next to them (prod has no `gpu-vm` root) |
| `terraform/**/*.tftest.hcl` | the mocked-plan-test evidence list |
| `docs/evidence/`, `runbooks/`, `docs/decisions/`, `docs/solutions/`, `docs/design/` | evidence, runbook and ADR lists; the document viewer |
| each recipe's README (the root README's recipe table is mirrored as `RECIPES` in `nebius-domain/src/repo.ts`, with its runbooks; `repo.test.ts` fails when they diverge) | the R1–R16 recipe cards (README, runbooks, evidence rows, stage caps); a card whose README is not in the checkout yet says so instead of offering Read |
| `solutions/README.md`, `solutions/S<n>-*/README.md`, `solutions/S<n>-*/footprint*.json` | the Solutions page (S1–S9: scenario, composed recipes, status, Read) and "Price this footprint" |
| `docs/reference/nebius-docs.json` (`make docs-catalog`) and, when present, its git-ignored page mirror `.cache/nebius-docs/<path>.md` | the Nebius docs page (`/nebius-docs`: sections, key pages, search, a page in a drawer from the mirror, else its sections linked to docs.nebius.com) and coverage stated against the catalog on that page and on Integrations (`docsCoverage`, `DOCS_SECTIONS` in `nebius-domain/src/nebiusDocs.ts`; a catalog section missing there fails `nebiusDocs.test.ts`) |

Only R1, R3 and R4 (inference, training, Soperator lab) have provisioning forms and footprint
calculators. R7 (network), R8 (data), R9 (governance), R10 (gpu-vm) and R12 (ml-services) are
Terraform stacks with live roots: their roots and sizing files are shown read-only (Provisioning →
"Recipes without a form"), resources labelled with their stack link to them, nothing is generated
for them (their tfvars carry no sizing keys a form could edit). R2, R5, R6, R11, R13, R14, R15 and
R16 are documentation and runbook entries; R15 (nvl) has no live root and a cap of 0 in every stage
(`max_gpu_nodes.nvl`), shown on its card with R10's `gpu-vm` cap.

**Solutions.** The Solutions page (`/solutions`, Assurance; `/evidence?tab=solutions` links redirect there) lists S1–S9 from the index table of
`solutions/README.md` (status as the table states it, else the README's Status line, else "design
done; live evidence not yet run"). "Price this footprint" maps a solution's `footprint*.json` (the
`recipes/finance/price.py` format) onto the live-price footprint (`parseSolutionFootprint`): VMs become
node groups, disks and filesystems become storage, and a VM marked `compare` (the default for GPU
platforms) adds a preemptible row in which the other VMs stay on-demand. Both rows go through
`POST /pricing/footprint` like every other live price. The document viewer has no Mermaid renderer
(none is in the lockfile): each Mermaid block keeps its source under a "Diagram (Mermaid)" caption
linking to the file on GitHub.

## Data models (kept separate)

| Model | Type | Where it comes from | Never mixed with |
|---|---|---|---|
| Desired configuration | `RepoModel`, `LiveRoot` | repository files | discovered state: the explorer compares them and says "not drift detection" |
| Discovered resources | `ObservedResource` (stable `uid`, `providerId`, type, project, region, labels, status, refs, source, `observedAt`, coverage notes) | connectors | telemetry, billing |
| Kubernetes view | `KubeCluster` (allocatable, workloads with requests/limits, pods, PVCs, events) | Kubernetes connector | cloud capacity, utilisation |
| Telemetry | `GpuTelemetryView` per GPU series (utilisation, temperature, power, memory, MK8s cluster and node group, source) | Nebius Monitoring (VMs and the MK8s observability agent), optional external Prometheus | requests |
| Telemetry history | `GpuSample` (1 min, 7 days) and `GpuHourly` (90 days) per `GpuSeries` (project, VM, GPU uuid, cluster, node group); `FleetResponse` | the sample store, filled from Nebius Monitoring `query_range` | inventory counts, billed cost |
| Alerts | `AlertRule` (the rule files), `AlertInstance` (rule × label set, pending/firing/resolved, `activeAt`), transitions, `AlertNote` (ack, mute) | rule evaluation after each sync | the rule files themselves (never edited) |
| Logs | `LogLine` (time, line, stream labels), `LogBucketStatus` | Nebius Observability Logs, on demand | nothing (never stored) |
| Capacity and quotas | `QuotaAllowanceView`, `CapacityAllowanceView`, `CapacityBlockGroupView`, `ResourceAdviceView`, `PlatformView`, `MaintenanceView` | quotas, capacity, compute, maintenance APIs | inventory counts |
| Live prices | `LivePriceEstimate` (list or contract price, as of, SKU lines, unpriced lines) | Nebius billing calculator | rate-book estimates, billed cost |
| API capabilities | `CapabilityStatus` (state, hint, drift, per project, `HealthStats`) | every connector call | — |
| Billing records | `BillingRecord` (four separate cost columns, currency, charge category/class) | FOCUS CSV | estimates |
| Rate cards | `RateBook` / `RateEntry` (unit, period, capacity type, bundles, effective dates, source, classification) | user imports | billed cost |
| Scenarios / estimates | `Scenario`, `ScenarioEstimate` (draft label, coverage, sensitivity, selling price) | user | billed cost |
| Provisioning requests | `ProvisioningRequestRecord` (input, base hashes, patch, state) | user | anything applied |

Metrics returned to the overview are `SourcedMetric` values: `value | null`, `source`, `observedAt`,
`unavailableReason`. A missing source is `null` and rendered as **Unavailable**, never as 0.

## Relationships

Edges come only from explicit fields:
- `parent` (API `parentId`)
- `attached-to` (disk `status.readWriteAttachment` / `readOnlyAttachments`)
- `mounted-by` (instance filesystems)
- `in-fabric` (GPU cluster id)
- `in-subnet`
- `member-of` (node VM → node group: the `mk8s-node-group-id` label Managed Kubernetes sets, or a node label)
- `managed-by` (a node disk → its node group, or a VM with only `mk8s-cluster-id` → its cluster)
- `owned-by` (Kubernetes ownerReferences)
- `runs-on` (exact instance id in a node `providerID`)
- `in-cluster` (namespace → the MK8s cluster it was read from)
- `assigned-to` (IP allocation → VM, `status.assignment.networkInterface.instanceId`)
- `in-network` (security group, route table, managed PostgreSQL/MLflow → network, `spec.networkId`)
- `routes` (route table → subnet, `status.assignment.subnets`)
- `snapshot-of` (disk snapshot → disk, `spec.sourceDiskId`)
- `backed-by` (Serverless endpoint/job/DevLab → VM, `status.instances[].computeInstanceId`)
- `secured-by` (VM → security group, `spec.network_interfaces[].security_groups[].id`)
- `pool-of` (IP pool → the subnets and networks it is assigned to, `status.assignment.subnets` / `networks`)

Tenant, project and region grouping comes from the corresponding fields. Nothing is linked by name.
References whose target is not in the snapshot are listed as unresolved, not guessed.

**Defaults and managed resources** follow [docs/naming.md §6](../naming.md) (explicit field, then a
Nebius label, then a name pattern as fallback): `status.default`; pools listed by a default network
(`spec.ipv4_*_pools`), else `default-(network|public)-pool*`; the per-network system DNS zone
`<network_ID>.compute.internal.` (default, `in-network`); the per-cluster security group
`mk8scluster-<id>-node-groups-system` (`managed-by` the cluster); allocations labelled
`nebius.com/managed-by: mk8s` (managed, not unattributed). Kubernetes nodes are tied to their VM by
`providerID` or the node name (MK8s names nodes after the VM id), and to their node group by the
documented `nebius.com/node-group-id` label (any `mk8snodegroup-*` value as a fallback).

**Attribution** comes from the `nip-*` labels our stacks write (`nip-stack`, falling back to the
deprecated `nip-env`). What Managed Kubernetes creates for a cluster — node VMs and their boot disks
(`mk8s-cluster-id` / `mk8s-node-group-id`), CSI volumes (`compute.csi.nebius.com/cluster-id` or the
`k8s.io/<mk8scluster-…>` label) and a node's IP allocations (`assigned-to` a node VM) — takes every `nip-*`
value it lacks (stage, stack, owner, run, TTL) from its node group, then its cluster, and says so
("attributed via node group <name>"). The TTL-expired view uses that inherited TTL. *Unattributed* counts
only resources whose parents are unlabelled too.

**Orphan candidates** are for a person to review; the portal never deletes anything (confirm with
`scripts/leftovers.sh`, follow `runbooks/teardown.md`). Rules: a disk with no attachments and no
`status.managedBy`; a labelled resource whose parent is missing; a GPU cluster no VM uses. Not
evaluated: anything created in the last 30 minutes or provisioning/deleting ("recently created — not
evaluated yet"). A rule must hold on two consecutive syncs, except for resources older than 6 hours
(a provisioning gap cannot explain those, and a restart would otherwise hide them for one interval).

## Frontend

- **App shell.** `@backstage/frontend-defaults` with two features: the `nebius-estate` plugin (every
  page) and an app module. The app module provides the nav (grouped, ordered), the dark and light
  unified themes, a flex layout and the sign-in page. The stock themes are disabled in
  `app-config.yaml`.
- **Design system.** `plugins/nebius-estate/src/ui/` holds:
  - CSS tokens under `body[data-theme-mode]`
  - the page shell (title, "Read-only to Nebius" badge, the test-data banner on a stub run, global project/region/stage filter)
  - sourced metric tiles and sortable, keyboard-operable tables
  - a focus-trapped drawer, tabs and SVG charts with text alternatives
- **Global filter.** Kept in the URL (`?project=…&region=…&stage=…`), so every view is shareable and
  bookmarkable; one schema (`globalFilterSchema`) validates it in the app and on the backend. Nav
  links carry the three parameters from page to page. Every page applies it: the backend narrows
  the caller's scoped snapshot with it on `/overview`, `/capacity`, `/workloads`, `/history`,
  `/resources` and `/graph`. Scope is always enforced first.
- **Refresh.** One page-wide refresh clock: the header's Refresh button refetches every view on the
  page, and the page refreshes itself every five minutes while the tab is visible. The header shows
  when it last refreshed. Data stays on screen while refetching.
- **Graph.** Opens with the tenant, project and region levels unfolded (one node per project, never
  folded behind "N × Project"), top-level resources beneath. Each node expands to its children with "+N"
  or the → key; Collapse folds back to the tenant, and a click on a project opens it and its drawer. A search or filter shows only matches and their ancestors, and
  the selected resource's path is always open.
- **Clock.** Ages and TTLs use the browser's clock; estimates and quotes are dated by the backend's.
- **Document viewer.** Renders allowlisted Markdown (sanitised by Backstage's `MarkdownContent`).
  Relative links open the linked file in the same viewer; only `http(s)` and `mailto` links leave it.
  A file missing from the checkout, or not allowlisted, is explained in place rather than shown as an
  error.
- **Charts.** Hand-written SVG with a labelled y-axis (rounded maximum, midline), readable day ticks
  and a screen-reader table. Trend lines break on missing days: a gap means "not observed", never zero.

## History

`HistoryStore` (table `nebius_estate_history`) holds one row per (day, project, region, stage):
- resources, running instances, GPUs and vCPUs on running VMs
- TTL-expired and orphan-candidate counts
- the DCGM utilisation sum and sample count

`summarizeDay` in the domain package computes the row. It is recorded after start-up and after every
scheduled sync; a later sync on the same day merges into that day's rows (`mergeDayRows`: the day's maximum
GPUs, vCPUs and running VMs, the mean utilisation, the last resource and TTL or orphan counts), and retention is
400 days. `GET /history?days=30` returns per-day totals for the caller's scope and the global filter.

- **Backfill from GPU telemetry (#33).** Rows written before the per-day maximum kept only a day's last state, so
  a GPU run torn down before the last sync read 0 GPUs. After the first sync of each start, `backfillHistory`
  compares every recorded day (within the 90-day roll-up window) per project with the sample store's hourly
  roll-ups: the peak hourly GPUs (the GPUs and VMs that reported in the project's busiest hour of the day, the
  same quantity as the row's per-sync peak, so VMs replaced during the day are not added up) and the
  sample-weighted utilisation of the day. A shortfall is raised from telemetry and the row is marked
  (`telemetryBackfill`); the point then carries `incomplete` with the reason, and the GPU and utilisation charts
  draw it as a hollow point (vCPU and TTL charts do not: those figures are not backfilled). Nothing is lowered, no
  unrecorded day is added, and a second run changes nothing. Today takes no utilisation from telemetry: the first
  sync of a fresh start runs before the telemetry recorder, which is start-up order, not a gap. A VM replaced
  within one hour still counts with its successor in that hour. vCPUs and resource counts are not backfilled
  (telemetry does not carry them), and billing rows are not used.

- **Days without data are absent.** The portal must have run that day, so the trend starts the day it
  is deployed.
- **Utilisation is a sample-weighted mean** and is null when no samples were recorded.

## Connectors and API capabilities

Every Nebius call is an entry of the catalog (`inventory/nebius-catalog.ts`): the documented path,
the parent it takes (project, tenant, or each MK8s cluster), and what to grant when it is refused.
About 30 lists per project cover compute, MK8s, VPC, storage, registries, managed PostgreSQL and
MLflow, Serverless endpoints/jobs/DevLabs, tunnels, KMS keys, secrets (metadata only), DNS,
maintenance, quotas, capacity allowances and platforms; capacity block groups and capacity advice
are tenant-level. Each call's outcome is a **capability state**: `ok`, `permission-denied` (with
the role to grant), `not-found`, `rejected` (400), `unreachable` (timeout, network, 429/5xx after
retries), `schema-drift`, or `not-configured`. One refused or broken list never hides the others.
Connectors themselves can also be `optional`: Kubernetes with no cluster at all needs a Managed Kubernetes
cluster the deployment may not run. An unset external Prometheus is `not-needed`: shown as complete ("GPU
telemetry already comes from Nebius Monitoring (official endpoint, all listed projects). Set this only for a
Prometheus you run outside Nebius."). Neither has "Sync now", their runs are neutral, and they never count
as not configured or as needing attention.

- **Contracts.** Responses are checked against the documented list key and status enums, extracted
  from `openapi.json` into `apiContracts.ts`, with passthrough zod schemas: unknown fields are
  fine; an undocumented enum value or an item without `metadata.id` is reported as drift, and the
  readable items are still used. Lists whose items have no id are keyed by name instead (quotas:
  parent + name + region; capacity advice: region + fabric + platform + preset).
- **Last good data.** A list that fails keeps its previous items, marked stale in their coverage
  notes; the capability keeps its last success and is flagged `stale`. Nothing turns into zero.
- **Bounds.** Per host: at most 12 requests in flight (≤ 16) and 20 ms between starts (configurable);
  15 s timeout; 3 retries on 429/5xx/network with backoff and jitter, honouring `Retry-After`;
  100 pages per list. Different hosts (inventory, Monitoring, Kubernetes, Prometheus) sync in
  parallel. Platforms are read once per region. Within the inventory, project lists, tenant lists
  and discovery run concurrently, and node groups are read as soon as their project's clusters are.
- **Tiers.** Each catalog entry is `core` or `slow`. Scheduled syncs read the core tier; the first
  sync, a manual one and every `fullSyncEvery`-th (default 4) read both, and slow-tier data is
  carried over unchanged meanwhile. The core tier is what changes while runs create and delete things:
  VMs, disks, filesystems, GPU clusters, MK8s clusters and node groups, IP allocations, buckets,
  Serverless, **managed PostgreSQL and MLflow, container registries and quota allowances (project
  and tenant)**. The last four were slow until 2026-10-12, when R12's PostgreSQL, MLflow and registry
  showed up ~35 min late and stayed listed (PostgreSQL priced) after deletion; they cost 4 list calls
  per project and 1 per tenant per sync, under the same per-host limit. Simulated at 350 ms per call
  for 9 projects with 12 calls in flight: full sync 285 calls in ~8.9 s, core sync 131 calls in
  ~4.4 s (was 94 calls in ~3.3 s) (`capabilities.test.ts`).
- **Own read times.** Every resource keeps the time its list was last read (`observedAt`); the
  snapshot records when the latest normal (core or full) sync read the cloud (`inventoryReadAt`; a
  fast re-sync does not move it). A cloud resource read before that (a slow-tier list a core sync
  skipped, or a list whose read failed) is shown as **Last seen <time>** in the drawer and the
  Explorer (`ResourceView.lastSeen`) and is never priced in a run-rate (see billing-and-pricing.md).
  Capacity cards (quota allowances, capacity allowances, platforms, block groups, advice) carry the
  last success of their own lists, the oldest one when a card joins two (project and tenant quotas),
  not the snapshot time, and say when a list's latest read failed.
- **Fast re-sync (lifecycle-aware).** While the last snapshot has an MK8s cluster or node group
  PROVISIONING / UPDATING / DELETING, or a VM CREATING / STARTING / UPDATING / STOPPING / DELETING
  (the raw API state, `ObservedResource.apiState`), one extra sync of the **fast tier** runs
  `fastSyncSeconds` (default 120; 60–900, 0 = off) after the end of the last sync. The fast tier is
  `compute.instances`, `mk8s.clusters` and `mk8s.node-groups` (plus each project by id) and the
  discovered clusters' Kubernetes APIs (`mk8s:<id>`); every other list is carried over unchanged, and
  Monitoring, pricing, extensions, the alert evaluation and the orphan streaks wait for a normal sync.
  It goes through the same single-sync lock (a fast sync due while another runs joins it) and the same
  per-host limiters, and never starts within the "Sync now" cooldown (60 s) of the inventory's last
  attempt. It stops as soon as nothing is transitional; after `fastSyncMax` (default 30, about an hour)
  in a row it falls back to the normal cadence and says so on the inventory card until things settle.
  Effect: a cluster is connected about 2 min after RUNNING, and "Cluster is being deleted" shows on the
  next fast sync instead of being skipped by a 15-minute gap (`fastSync.test.ts`, `fastSyncService.test.ts`).
- **Discovery.** With `discoverProjects`, the tenant project list is read; projects missing from
  `NEBIUS_PROJECT_IDS` are reported to unrestricted callers as a hint and never added to the scope.
- **Read-only by construction.** The HTTP client refuses any method but GET unless the exact path is
  allowlisted: the token exchange and the billing calculator's estimate, which prices a would-be
  create request and creates nothing.
- **Scheduling.** The first sync starts in the background after start-up (the plugin never waits on
  the cloud), then every `syncIntervalMinutes` (≥ 5, default 15). One sync runs at a time; "Sync
  now" while one runs answers 409 at once, and within a minute of the last attempt it is not repeated.
  While something is changing state the fast re-sync above adds runs of the fast tier; the inventory
  and `mk8s:` cards then show "Next run in 2 min (a cluster is provisioning)".
- **Health.** Every run of every connector and capability is recorded (`nebius_estate_sync_runs`,
  7 days): start, duration, outcome, error class, HTTP status, items. `ConnectorStatus.health` and
  `CapabilityStatus.health` carry the 24 h success rate, p50/p95 duration, consecutive failures,
  next run and recent runs. The inventory card's "not covered" list is derived from capability states.

| Connector | Default | Notes |
|---|---|---|
| Nebius inventory | on (with projects and an identity) | projects read by id; tenant listing never required |
| Nebius Monitoring | on | per project, `…/service-provider/prometheus/api/v1/query` for the DCGM GPU metrics of VMs (utilisation, temperature, power, memory); the VM-id label is not documented, several candidates are tried |
| Nebius pricing | on | list prices from the billing calculator, cached per spec and project (30 min, LRU of ≤ 2000 answers); contract prices tried first when allowed, with a visible fallback |
| Billing export pull | on (with the bucket variables) | lists the FOCUS export bucket (SigV4, GET only), imports new or changed files through the FOCUS import; key + ETag + size dedupe ([billing](billing-and-pricing.md#billing-export-pull)) |
| Kubernetes (MK8s, discovered) | on (with projects) | one connector per cluster; endpoint, CA and id re-read every sync (self-healing); the portal's Nebius token; PROVISIONING clusters wait; vanished clusters kept stale, then dropped ([setup](nebius-setup.md#kubernetes)) |
| Kubernetes (explicit) | off | non-Nebius clusters from config; read-only token |
| Prometheus (external) | optional | extra GPU source, explicit config only |
| Token Factory (`token-factory`) | on (with `nebiusEstate.ai.tokenFactory` and the key variable) | `GET /v1/models`; runs on the sync loop as a `SyncExtension` (`ai/`); usage and balance are console only ([AI services](billing-and-pricing.md#ai-services)) |
| Hugging Face (`huggingface`) | on (with `nebiusEstate.ai.huggingface` and the token variable) | `whoami-v2`, model API and a HEAD of `config.json` per workload model; never downloads weights |
| GPU metrics history (`nebius-metrics-history`) | on (with Monitoring) | a `SyncExtension` (`telemetry/`): `query_range` per project from the newest stored sample (≤ 7 days, 1-min step, 6-hour windows), written to the sample store with hourly roll-ups; Object Storage and volume figures for the Fleet service panels |
| Logs (`nebius-logging`) | on (with projects) | a `SyncExtension` (`logs/`): one `label/__bucket__/values` call per project per sync (health); lines are read on demand by `/logs/query`, never stored |
| Audit events (`nebius-audit`) | on (with projects; answers once the tenant grants `auditlogs.audit-event-viewer`) | a `SyncExtension` (`audit/`): one single-event `GET /audit/v2/audit-events` per region of the listed projects per sync, after the inventory has read the projects (health); events are read on demand by `/audit/events` (tenant-wide, writes only unless asked), never stored; token, client IP, user agent and request or response contents are never copied |

Connector titles, scope and coverage come from one set of definitions (`connectorDefinitions`). A
connector without configuration stays `not-configured` and is never called.

## Database

Tables are created by knex migrations (`plugins/nebius-estate-backend/migrations/`), run at start-up:
history, provisioning requests, billing imports and rows, rate books, scenarios, sync runs, billing export objects, budgets, credits and Token Factory spend entries (entered by the owner), GPU series, 1-minute samples and hourly roll-ups, alerts, alert transitions and alert notes. Billing rows keep
their attributed project, charge-period start, region, service and supersession slot as indexed
columns next to the JSON row, so reports select in SQL and supersession is one `DELETE` per batch of
slots, in the import's transaction: only active rows are stored. Each import keeps its summary, who
imported it, when, and the projects it carried (the import list follows the caller's scope by them).
Provisioning state changes are compare-and-set on the previous state.

## HTTP API

All routes are under `/api/nebius-estate`:
- estate: `/meta`, `/filters`, `/overview`, `/resources[/:uid]`, `/graph`, `/capacity`, `/workloads`,
  `/history`, `/repo`, `/evidence`, `/solutions`, `/document?path=`, `/nebius-docs`, `/nebius-docs/page?path=` (catalogued
  paths only), `/integrations`, `/integrations/:id/sync`;
- provisioning: `/provisioning/recipes`, `/provisioning/preview`, `/provisioning/estimate`,
  `/provisioning/live-price`,
  `/provisioning/requests` (and `/:id`, `/:id/patch`, `/:id/withdraw`, `/:id/evidence`);
- commercial: `/billing/summary`, `/billing/export.csv`, `/billing/imports`, `/ratebooks[/:id]`,
  `/estimate`, `/scenarios[/:id]`, `/scenarios/:id/quote.(json|csv)`, `/runrate`, `/runrate/live`,
  `/pricing/footprint`;
- budgets: `/budgets` (stored budgets, credits and entries, plus the deprecated config budgets read-only), `/budgets/signals`, `/budgets/{budget|credit|spend}[/:id]` (`nebius.billing.budget.write`, audited); all scoped to the caller's projects ([billing](billing-and-pricing.md#budgets-and-credits));
- AI services: `/ai-services`;
- operate: `/fleet?range=1h|6h|24h|7d` (`nebius.telemetry.read`), `/alerts[?state=&project=]`, `/alerts/:id`
  (detail, history, guided fix), `POST /alerts/:id/notes` and `DELETE /alerts/:id/notes/(ack|mute)`
  (`nebius.alerts.annotate`, audited), `/logs/buckets`, `/logs/query` (`nebius.logs.read`),
  `/audit/events?region=&sinceMinutes=&limit=&reads=` (`nebius.audit.read`, roles scoped to every project only).

Response shapes are the TypeScript contracts in `portal/packages/nebius-domain/src/api.ts`, used by
the backend and the frontend alike; request bodies and queries are validated with zod (invalid input
returns 400). JSON bodies are parsed per route, not router-wide, so each keeps its limit: 2 MB on the
estate, provisioning and commercial routes, 64 KB on budget writes and alert notes (413 beyond). The
calculator-backed routes (including live estimates, quotes and list-book previews) share a per-user
token bucket (30 at once, then one per second; 429 with `Retry-After`). Optional Fleet idle cost uses
that same bucket and becomes unavailable on exhaustion while telemetry remains available. Stored-book
calculations do not consume it. Estimates and quotes use the backend clock. There is no
generated OpenAPI document.

## Known gaps

| Gap | Effect | Handling |
|---|---|---|
| Most lists were empty on the live account used to verify them (2026-10-11) | A mapping could miss a field once items appear | Mappers accept camelCase and snake_case; unknown states become `unknown`, never `running`; drift is reported per capability; `yarn verify:live` re-checks |
| Instance → node-group membership is not an explicit field in the instance API | No `member-of` edge from the inventory; GPU VMs count as standalone | The edge is drawn only when data provides it (Kubernetes node `providerID`) |
| FOCUS re-export semantics are not documented | Duplicate or overlapping files | Exact-duplicate drop plus supersession per billing account × attributed project (`x_ProjectId`, else `x_ContainerId`) × hour; a row whose two project columns disagree is rejected |
| FOCUS `Tags` carries cost allocation labels only for Compute resources (since 2026-09-21), in an undocumented text encoding | Other rows have no labels in the export | `parseTags` reads a JSON object or `k=v`/`k:v` pairs and ignores anything else; label breakdowns use the row's tag first, then join `ResourceId` to inventory labels, and say which source each value came from |
| Provider console URLs are not documented | No deep links | None are shown; nothing is fabricated |
| Tenant-level reads (capacity block groups, capacity advice, tenant projects) | Refused with project-level permits only | Shown as permission-denied with the role to grant; answered on 2026-10-11 with a tenant-level read grant (tenant `viewer` + `security-auditor` in this setup): block groups and tenant projects in [portal AI-services evidence](../evidence/2026-10-11-portal-ai-services.md), advice in the [pricing run](../evidence/2026-10-11-solutions-pricing.md) |
| Capacity advice items carry no `metadata.id`; `reserved` may omit `available`/`limit` | No stable id; some numbers absent | Keyed by region + fabric + platform + preset; absent numbers show as "numbers not reported", never 0; stale `dataState` is labelled |
| The FOCUS export key layout in the bucket is not documented | Unknown file naming | Every `.csv`/`.csv.gz`/`.gz` under the prefix is a candidate; supersession per hour makes re-exports count once |
| The label carrying the VM id on Nebius Monitoring GPU series is not documented | A series may not be tied to its VM | Several labels are tried; a series without one is kept under its host label and its project |
| Quota allowances carry no `metadata.id`; proto3 JSON omits zero limits and usage | A tenant allowance with no limit is read as 0 (observed to behave as 0 once: a QuotaFailure naming limit "0"). A project entry with no id, no limit, no state and created_at at the epoch is read as a placeholder, not a limit of 0: the project draws on the tenant quota (observed once: a preemptible L40S node ran under such entries, 2026-10-11). Both: [evidence](../evidence/2026-10-11-sandbox-inference-portal-connectors.md) | Identity is parent + name + region; omitted tenant limit and absent usage read as 0; placeholders read as "uses tenant quota" with headroom against the tenant limit of their region; limit 0 is shown as blocked (alarm only for Compute in a region the estate uses) with where to request quota; tenant allowances (enforced) lead, project allocations beneath; planned footprints are checked against the tenant allowances on Overview and in the provisioning preview (preemptible GPU VMs against the preemptible VM count, not the GPU quota); real project caps (entries with an id) are compared with the tenant limit of their quota and region (`checkAllowances`: no effect above it, a cut below it or at 0), shown as the Allowance check on Capacity, an Overview row and the `ProjectAllowanceBelowTenant` alert ([capacity](../capacity.md#project-allowances-vs-tenant-quotas)); each Capacity GPU card shows the effective limit min(project cap, tenant) for the filtered project ("capped by project"), or the projects capped below the tenant limit, or "project cap unknown" when no project allowance was read, and a GPU clusters cap of 0 as "8-GPU presets cannot join an InfiniBand GPU cluster" on models the live platform list gives an 8-GPU preset (none when the list is unavailable); each region with GPU quota says whether its non-GPU vCPU allowance lets the Kubernetes recipes start CPU node groups (tenant limit, the filtered project's lower cap, or with project caps only and no filter the highest cap with its project named and projects at 0 listed) |
| The live roots do not name their region | A planned footprint's region is unknown | Each live root is checked in its own region only: where its resources run (`nip-region`, else their region), else the region the global filter selects (the region, or the filtered project's region), else the first region of `platform/regions.yaml` (eu-north1, the documented `NEBIUS_REGION`). One check (`checkPlannedFootprint`) serves Overview, the Capacity header and the footprint calculator; the provisioning preview checks its own region |
| Some lists refuse large pages (capacity allowances ≥ 500, NVL groups > 50) | A list could fail on page size | Page size 100 by default, 50 for NVL groups; a list that still refuses its page size is read again with the service default and a drift note |
| Slurm accounting | Not shown | Unavailable, with the manual source named ([capability matrix](capability-matrix.md)) |
| Dynamic spot prices for large GPU platforms | Preemptible estimates are uncertain | Rates marked `variable`; every estimate that uses one is flagged |

## Fleet, alerts and logs

- **Sample store.** `TelemetryRecorder` runs on the sync loop as a `SyncExtension`: for each listed
  project it reads `query_range` of the five DCGM series from the newest stored sample (at most 7 days
  back, 1-minute step, in 6-hour windows per project read and written one at a time; one call per metric
  and window, and a gap longer than a window is probed first with `max_over_time`, so a project without
  GPUs costs one call) and upserts one row per GPU and minute. Every write re-rolls the hours it touched
  and prunes: minutes after 7 days, hours after 90 days. At most `MAX_TRACKED_GPUS` series seen within
  the 7-day window are tracked; when full, a new GPU evicts the series seen longest ago (with its
  samples and roll-ups), never one of the same write. A restart or an outage heals on the next sync.
  Monitoring and Logs answers are capped at 32 MB.
- **Fleet.** `GET /fleet` buckets the store per range: 7 d from the hourly roll-ups; 1 h, 6 h and 24 h
  from the minutes, downsampled in SQL to one row per GPU and bucket (≤ 96 per GPU), so a request never
  loads every minute sample. An unobserved bucket is null and drawn as "not observed", never as 0. Idle-GPU cost is idle
  GPU-hours (utilisation below 5 %) × the VM's live price from `commercial/livePrice` ÷ its GPUs, and is
  labelled an estimate; VMs that cannot be priced are listed with the reason.
- **Rule engine.** `AlertEngine` runs after every sync (`InventoryService.afterSync`). One source of
  rules: `platform/alerts/*.yaml` (also loaded by in-cluster Prometheus) and `platform/alerts/portal/`.
  A rule's metric names decide where it runs: `nebius_estate_*` signals come from the snapshot
  (`alerts/signals.ts`); `kube_*`, `kubelet_*`, `container_*`, `apiserver_*` and `vllm:*` need an
  in-cluster Prometheus and are listed with that reason; everything else is PromQL against Nebius
  Monitoring per project. `for:` is honoured with pending state kept in the alert store; a newly
  active series looks back over `for:` with `query_range`, so a condition that already held long enough
  fires within one sync. A failed query never resolves an alert. Transitions are kept 90 days.
- **Budget alerts.** `budgetSignals` (Budgets & credits) feeds the same engine as source `budgets`: one
  pseudo-rule per kind (`BudgetThresholdCrossed`, `BudgetOver`, `BudgetProjected`, `BudgetForecast`, `CreditExpiring`), an alert per signal id
  that fires and resolves with the signal and carries the signal's own guided fix
  (`runbooks/finance.md#budget-or-credit-signal`). A failed read keeps budget alerts as they were. The
  engine sees every budget and credit; `/budgets` and `/budgets/signals` are scoped per caller.
- **Inbox scope.** `/alerts` returns the caller's alerts only; rule statuses carry firing / pending
  counts of those alerts and reasons with other projects' ids and names masked.
- **Guided fix.** Every rule names `annotations.runbook` (repo path#anchor) and `annotations.docs`
  (docs.nebius.com page#anchor); `alerts/rules.test.ts` fails when either does not exist. The detail
  route renders the runbook section through the document reader, adds `checks` and `fix`, and never
  executes anything.
- **Notifier.** `AlertNotifier` (domain) is the seam: the browser implements it with the Notification
  API while the Alerts page is open (user toggle, kept in the browser); the backend `NotifierRegistry`
  dispatches transitions to registered channels, and none ships yet (Slack, email and webhook config
  types exist, without an implementation).
- **Logs.** `/logs/query` validates LogQL against the documented limits (`validateLogQL`), keeps the
  caller to projects in scope, reads at most 1000 lines with `direction=backward`, and turns "logging
  bucket … not found" into "no logs yet from <service>".
