# Nebius Estate — setup

The portal reads; it never creates cloud resources, roles, exports or budgets. Everything below is
done by a person, deliberately. There is one runtime, two ways to run it:

| | Local (one operator) | Served |
|---|---|---|
| Config | `app-config.yaml` + `app-config.local.yaml` + `app-config.private.yaml` when present ([private overlay](#private-overlay); `yarn start`, `make portal-dev`) | `app-config.yaml` + `app-config.production.yaml` |
| Sign-in | guest, accepted only because the backend binds `127.0.0.1` | a real provider ([security](security.md#identity)) |
| Database | SQLite files in `portal/.local-data/` (git-ignored) | PostgreSQL |
| Projects | optional: without them every connector shows "not configured" | required |

Both need exactly one backend replica ([architecture](architecture.md)).

## Read-only Nebius identity

One read-only identity serves every Nebius connector: the inventory (`GET` lists at
`https://api.nebius.cloud`), GPU telemetry (Nebius Monitoring at `https://read.monitoring.api.nebius.cloud`)
and live list prices (the billing calculator's estimate, a POST that creates nothing). With a service
account there is one token exchange at `https://sts.nebius.com/oauth2/token/exchange`. The backend
reads these environment variables (names as in the repository `.env.example`; load it with
`set -a; source .env; set +a` before `yarn start`):

| Variable | Meaning |
|---|---|
| `NEBIUS_PROJECT_IDS` | comma-separated project ids to inventory (`projectIdsEnv`) |
| `NEBIUS_SA_ID`, `NEBIUS_SA_PUBLIC_KEY_ID` | the read-only service account and its authorized key id |
| `NEBIUS_SA_PRIVATE_KEY_FILE` | path to the private key PEM (relative paths are from the repository root, e.g. `secrets/portal-viewer.pem`) |
| `NEBIUS_IAM_TOKEN` | instead of a service account: a short-lived token (`nebius iam get-access-token`, about 12 h) |

The service account is used when `NEBIUS_SA_ID` and `NEBIUS_SA_PUBLIC_KEY_ID` are set; otherwise the
token. With neither, the connector reports which variables are missing.

**Service account (recommended).**
1. Create one service account for the portal.
2. Create a **custom group** for it and give that group one `viewer` access permit per project in
   `NEBIUS_PROJECT_IDS`. Do not add it to the default `viewers` group: that group is tenant-wide.
   Never `editor`.
3. Create an authorized key pair; keep the private key as a file under `secrets/` (git-ignored,
   mode 600) or in your secret store. Never commit it.
4. Set the variables above and start the backend.

The exact `nebius` CLI commands are in [docs/credentials.md](../credentials.md).

**Check:** open **Integrations & Coverage**. The table "API capabilities" lists every call with its
state, items, latency and health; a refused one says what to grant. With project-level `viewer`
permits, everything project-scoped answers; capacity block groups, capacity advice, the tenant
project list and contract prices stay `permission-denied` until the group also holds tenant-level
read roles (contract prices need `resource.billinggroup.get` on the billing group). With a
tenant-level read grant (this setup grants tenant `viewer` + `security-auditor`; the minimum role is
not established) all four answered on 2026-10-11: block groups (200, an empty list: "No reservations
in this tenant") and the tenant project list (200, 9 projects) with the portal identity
([evidence](../evidence/2026-10-11-portal-ai-services.md#nebius-tenant-level-reads-portal-service-account)),
capacity advice and contract prices (equal to list on that account) in the
[pricing run](../evidence/2026-10-11-solutions-pricing.md). To check from a terminal, with the same
variables loaded:

```bash
cd portal && yarn verify:live   # read-only probe of every capability; prints a table; non-zero on a regression or drift
```

With a service account, the backend signs a 5-minute RS256 JWT (`kid` = key id, `iss` = `sub` = service account id), exchanges it, and reuses the
token until shortly before it expires. Key and token never reach the browser or the logs.

```yaml
# app-config.production.yaml (excerpt; app-config.local.yaml maps the same variables, tenantId as ${NEBIUS_TENANT_ID:-})
nebiusEstate:
  nebius:
    tenantId: ${NEBIUS_TENANT_ID}
    projectIdsEnv: NEBIUS_PROJECT_IDS
    # or explicitly, with names and regions: projects: [{ id: project-…, name: sandbox, regions: [eu-north1] }]
    auth:
      serviceAccount: { idEnv: NEBIUS_SA_ID, publicKeyIdEnv: NEBIUS_SA_PUBLIC_KEY_ID, privateKeyFileEnv: NEBIUS_SA_PRIVATE_KEY_FILE }
      tokenEnv: NEBIUS_IAM_TOKEN
    syncIntervalMinutes: 15
    # maxConcurrency: 12           # requests in flight per host (max 16)
    # minRequestIntervalMs: 20     # spacing between request starts per host
    # fullSyncEvery: 4             # every 4th scheduled sync also reads the slow tier
    # discoverProjects: false      # list tenant projects as a hint (needs tenant viewer); never widens the scope
    # monitoring: { enabled: true }                                  # GPU metrics from Nebius Monitoring
    # pricing: { currency: usd, cacheMinutes: 30, tryContractPrice: true }   # live list prices
```

`tenantId` is optional locally: `app-config.local.yaml` maps it as `${NEBIUS_TENANT_ID:-}`, so with the variable
unset or empty (as `.env.example` ships it) the key is dropped and the tenant is read from a project's parent and kept
for later syncs, so one failed project read no longer loses the tenant-level lists (quotas, reservations,
capacity advice) or the audit events. Set it, as production does, so they never depend on a project read.

The first sync starts in the background once the backend is up, then repeats every
`syncIntervalMinutes`; "Sync now" on Integrations runs one on demand (refused with 409 while one runs).
Scheduled syncs read the core lists (instances, disks, filesystems, GPU clusters, MK8s clusters,
allocations, buckets, Serverless, managed PostgreSQL and MLflow, registries, quota allowances); the
first sync, a manual one and every `fullSyncEvery`-th one read everything, and slow-tier data is
carried over unchanged in between, shown as "last seen" with the time it was read.

A call that cannot connect (DNS, refused, reset, unreachable network, timeout) is retried for about 30 s
during a sync, and for about 3 s on a request a page waits for (Logs, audit events, Monitoring queries),
before it counts as failed; any other error fails at once, and the error names its cause
(`fetch failed (ENOTFOUND: …)`). A sync where some calls got no answer shows the inventory as
"degraded (N of M calls failed)", counted per list as "Calls at the last sync" on the same card, records a
failed run and keeps "last success" at the last sync where every call answered. A scheduled sync that starts more than twice
its interval late (the host slept) first checks that the API is reachable, waits up to 2 min for it, and
otherwise is deferred to the next run with a note on Integrations; the last data stands.

**Project discovery (opt-in).** With `discoverProjects: true` (on in `app-config.local.yaml`) and a
tenant `viewer`, the tenant's project list is read too. The scope stays exactly
`NEBIUS_PROJECT_IDS`: projects the tenant lists but the variable does not are shown on Integrations as
a hint ("N projects in the tenant are not in NEBIUS_PROJECT_IDS") and are never read.

List only the projects the portal should see. A project with a single `regions` entry labels its
resources with that region; ids from `NEBIUS_PROJECT_IDS` carry no region.

## Access roles

```yaml
nebiusEstate:
  access:
    roles:
      - { name: platform, principals: [group:default/platform], projects: ['*'], permissions: ['*'] }
      - { name: team-a, principals: [group:default/team-a], projects: [project-…], permissions: [nebius.estate.read, nebius.telemetry.read] }
```

## Kubernetes

Read-only, and self-healing for Managed Kubernetes: **nothing to configure**.

**MK8s clusters are discovered.** Every sync lists the clusters of the configured projects
(`GET /mk8s/v1/clusters`) and connects to each RUNNING one with what the API reports:
`status.controlPlane.endpoints.publicEndpoint` (or `privateEndpoint` with `nebius.mk8s.endpoint:
private`, for a backend inside the VPC), the CA in `status.controlPlane.auth.clusterCaCertificate`
(pinned per cluster, in memory), and the portal's own Nebius IAM token as the bearer token. Verified
live on 2026-10-11: that token is accepted as Kubernetes user `serviceaccount-<id>` in group
`nebius:viewer`; lists of namespaces, nodes and deployments answer, while secrets, `services/proxy`
and any write are refused (403).

- Each cluster is its own connector on Integrations (`Kubernetes — <name> (MK8s, discovered)`) with
  its own capability and health. A PROVISIONING cluster shows as *waiting* and connects once RUNNING;
  DELETING is not connected.
- A torn-down and recreated cluster (new id, endpoint or CA) is picked up on the next sync; a rotated
  endpoint or CA is noted on the card ("Reconnected: …").
- A cluster that no longer exists keeps its last data, marked stale, for `nebius.mk8s.forgetAfterSyncs`
  syncs (default 3), then is dropped with "cluster no longer exists".
- Only `https://…mk8s.<region>.nebius.cloud:443` endpoints reported by the API are called: the
  allowlist comes from discovery, never from a request.
- Kubernetes nodes are linked to their VMs (`providerID`) and node groups (node labels), so the graph
  reads cluster → node group → node VM → boot disk.

```yaml
nebiusEstate:
  nebius:
    mk8s:
      discover: true            # default
      endpoint: public          # or private
      forgetAfterSyncs: 3
```

**Other clusters (explicit).** For a cluster that is not Managed Kubernetes, create a read-only identity:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: nip-portal-read }
rules:
  - apiGroups: [""]
    resources: [nodes, namespaces, pods, persistentvolumeclaims, events]
    verbs: [get, list]
  - apiGroups: [apps]
    resources: [deployments, statefulsets, replicasets]
    verbs: [get, list]
  - apiGroups: [batch]
    resources: [jobs]
    verbs: [get, list]
```

Bind it to a service account and issue a token. Provide the token through an environment variable,
then list the cluster:

```yaml
nebiusEstate:
  kubernetes:
    clusters:
      - name: sandbox-inference
        url: https://<api-server>        # https only; from config, never from a request
        tokenEnv: K8S_SANDBOX_INFERENCE_TOKEN   # K8S_<NAME>_TOKEN
        caFile: /etc/nebius-estate/sandbox-inference-ca.crt
        mk8sClusterId: <mk8scluster-…>     # explicit link to the Nebius cluster (enables scoping)
        namespaces: [inference, o11y]      # optional narrowing
        dashboardUrl: https://…            # optional link to an existing cluster UI
```

A cluster without `mk8sClusterId` is visible only to callers with an unrestricted project scope.
On a local run, put this block in the [private overlay](#private-overlay), not in a committed file.

Without any cluster, Kubernetes shows as **optional** (neutral, not counted as needing attention): it
needs a Managed Kubernetes cluster, and GPU telemetry already comes from Nebius Monitoring.

## Private overlay

MK8s clusters need no entry here (they are discovered). Real endpoints for one machine that the API
cannot report (a non-Nebius cluster's API server and CA file, an external Prometheus) go in
`portal/app-config.private.yaml`. The file is git-ignored; start from the commented template:

```bash
cp portal/app-config.private.yaml.example portal/app-config.private.yaml   # uncomment and fill in
```

`yarn start` (and so `make portal-dev`) and `yarn config:check` load it after `app-config.yaml` and
`app-config.local.yaml` when it exists, and skip it when it does not; the startup log lists the files
loaded. It holds variable names and endpoints only: tokens stay in `.env` (`K8S_<NAME>_TOKEN`,
`PROMETHEUS_TOKEN`). The same validation applies as for any config file: cluster URLs must be https,
and Prometheus may use `http://127.0.0.1:9090` only because the local backend binds loopback. Restart
`yarn start` after editing it. Production never reads it (`app-config.production.yaml` is the only
overlay there).

## Telemetry

GPU utilisation, temperature, power and memory come from **Nebius Monitoring**, read with the same
identity (`viewer` on the project); no exporter, port-forward or Prometheus of our own:

- `…/projects/<project>/service-provider/prometheus/api/v1/query`: the GPU metrics of VMs and, on
  MK8s GPU nodes, the DCGM series the Nebius observability agent ships (verified live 2026-10-11:
  `DCGM_FI_DEV_GPU_UTIL`, `…_GPU_TEMP`, `…_POWER_USAGE`, `…_FB_USED` with labels `instance_id`,
  `mk8s_cluster_id`, `mk8s_node_group_id`, `job="nebius-observability-agent"`). Series join the
  inventory by `instance_id` and node groups by `mk8s_node_group_id`; GPU & Capacity shows the mean
  utilisation per node group.
- `…/projects/<project>/prometheus/api/v1/query`: series written to the project itself (user-ingested),
  read for projects with an MK8s cluster. It answers 404 "project/bucket not found" until something
  writes there; the capability then says "waiting for the observability agent", never zero GPUs.

A GPU reported by both appears once. An **external Prometheus** (dcgm-exporter outside Nebius
Monitoring) is an explicit option only; unset, it reads "not needed" (complete, not a gap): GPU
telemetry already comes from Nebius Monitoring (official endpoint, all listed projects). The in-cluster Prometheus
through the Kubernetes API proxy is refused by design, and port-forwards do not survive a rebuild.

```yaml
nebiusEstate:
  prometheus: { url: http://localhost:9090, tokenEnv: PROMETHEUS_TOKEN }   # https for anything but localhost; tokenEnv only if it needs a bearer token
```

Every telemetry figure names its source.

**History (Fleet page).** The same endpoint's `query_range` fills the portal's sample store on every
sync: 1-minute GPU samples kept 7 days and hourly roll-ups kept 90 days, in the portal database
(connector *GPU metrics history* on Integrations). A sync reads from the newest stored sample, so a
restart or an outage heals itself on the next sync (at most 7 days back), in 6-hour windows per project
written one at a time; a gap longer than one window is probed first with
`max_over_time(DCGM_FI_DEV_GPU_UTIL[6h])`, so a project without GPUs costs one call. Monitoring and Logs
answers larger than 32 MB are refused with an error naming the limit. Object Storage
(`request_rate`, `http_bytes_sent`, `http_bytes_received`, which grow like counters and are rated over
5 minutes) and volume byte counters are read for the service panels. Nothing to configure; `nebius.monitoring.enabled: false` turns all of it off.

**Alerts.** The rule files in `platform/alerts/` (shared with in-cluster Prometheus) and
`platform/alerts/portal/` are evaluated after each sync: DCGM and node rules against this endpoint,
portal rules from the inventory, and rules on kube-state-metrics, kubelet or vLLM listed as "needs
in-cluster Prometheus" ([fleet alerts runbook](../../runbooks/fleet-alerts.md)). Acknowledge and mute
are local notes (`nebius.alerts.annotate`). Browser notifications are a toggle on the Alerts page;
Slack, email and webhooks are a typed seam (`AlertNotifier`) without an implementation yet.

## Logs

The Logs page reads **Nebius Observability Logs** through its Loki-compatible API with the same
identity (verified live 2026-10-11): `https://read.logging.api.nebius.cloud/projects/<project>/loki/api/v1/`
`labels`, `label/__bucket__/values` and `query_range`. Nothing is stored; lines are read on demand,
at most 1000 per query, and only by callers with `nebius.logs.read` for projects in their scope.

- Every query names a bucket (`{__bucket__="sp_serial"}`): `sp_serial` (VM serial consoles),
  `sp_mk8s_control_plane`, `sp_mk8s_audit_logs`, `sp_k8srelease`, `sp_postgres`, `sp_mlflow`,
  `sp_cloudapps`, and `default` (what the observability agent ingests). A bucket the service never
  wrote to answers "logging bucket … not found" and is shown as "no logs yet from <service>".
- Serial-console lines carry `sp_resource_id` (the VM id), so a VM or an alert opens the page
  pre-filtered to that VM.
- The documented LogQL limits ([query language](https://docs.nebius.com/observability/logs/query-language#limitations))
  are checked before a query is sent.

```yaml
nebiusEstate:
  nebius:
    logging: { enabled: true }   # default; the endpoint is fixed (a loopback one only for the e2e stub)
```

## Budgets and the default rate book

Optional. The default rate book prices the run-rate tile and provisioning estimates (otherwise the first
rate book by id is used; with no active book, provisioning estimates use the built-in Nebius list price).

```yaml
nebiusEstate:
  commercial:
    defaultRateBook: <rate book id>
```

Budgets are entered on **Budgets & credits** and stored in the portal database
([billing and pricing](billing-and-pricing.md#budgets-and-credits)). The `nebiusEstate.budgets` key is
**deprecated**: it is still read and validated, and each entry shows read-only on Budgets & credits
("from config", measured against reported BilledCost of its month excl. tax and credit rows, `countsAsSpend`); nothing is imported. Re-enter
each one on that page and remove the key.

## Billing export

Set up a periodic FOCUS export in the Nebius console (admin; one active export per contract) to a bucket
you own. The portal does not create exports. To have it pull the files, create a service account with
read access to that bucket only, issue an access key, and set in `.env`:

```bash
NEBIUS_BILLING_EXPORT_BUCKET=<bucket>
NEBIUS_BILLING_EXPORT_REGION=eu-north1
NEBIUS_BILLING_EXPORT_PREFIX=             # optional
NEBIUS_BILLING_EXPORT_ACCESS_KEY_ID=…
NEBIUS_BILLING_EXPORT_SECRET_ACCESS_KEY=…
```

`app-config.local.yaml` and `app-config.production.yaml` already name these variables. Without them,
import the CSV files by hand on **Costs → Import FOCUS CSV**. See
[billing-and-pricing](billing-and-pricing.md#billing-export-pull).

## Run

```bash
cp portal/.env.example portal/.env   # fill in; never commit
make portal-build                    # typecheck, lint, config schema check (local and production files), build
cd portal
yarn build-image                     # packages/backend/Dockerfile: Node pinned by digest
# run ONE container with NODE_ENV=production; it starts with app-config.yaml + app-config.production.yaml,
# the variables from .env, and this repository mounted read-only at /app/repo
```

The backend creates and upgrades its tables itself (knex migrations) on start-up.

Record a `yarn verify:live` run as evidence (`docs/evidence/`) when you first connect an account and
after API changes: most lists were empty on the account they were verified against (2026-10-11), so
item mappings are contract-tested against the documented shapes.
