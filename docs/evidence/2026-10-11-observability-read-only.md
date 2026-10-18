# R14 observability scripts, read-only against a real project — 2026-10-11

- Kind: run of this repository (uncommitted working tree, 2026-10-11)
- Date / region / platform / presets: 2026-10-11, one project (the `eu-north1` regional monitoring
  host answered for it) that held a Managed Kubernetes cluster with the Nebius observability agent
  and GPU telemetry from one VM at the time; no resource was created for this run
- Versions: nebius CLI 0.12.285 (host); the scripts in `recipes/observability` as committed with this file
- Method: the read-only portal service account through the CLI profile `nip-portal-viewer` (project
  `viewer`, IAM access token, no static key). `recipes/observability/metrics.sh` (`names`,
  `--bucket <service> names`, `--ingested names`, `query`, `series`, `coverage`) and
  `recipes/observability/logs.sh` (`buckets`, `labels`, `values`, `query`), all `GET`; plus
  `nebius logging labels --bucket sp_serial` and two header-form probes
- Cost: none (Observability is free in preview; no resource created)
- Caveats: proves the read endpoints, paths and token form answer with project `viewer`, which metric
  names and log labels exist, and which `platform/alerts` metrics Nebius Monitoring has. **Not**
  shown: Grafana provisioning against a running Grafana, traces (none ingested), journald collection
  (not enabled), console alerts (console only)

Project and resource IDs are left out.

## Metrics (`read.monitoring.api.nebius.cloud`)

| Path | Result |
|---|---|
| `/projects/<p>/service-provider/prometheus/api/v1/label/__name__/values` | 200, 952 names: `node_*` 366, `cilium_*` 200, `DCGM_*` 112, `coredns_*` 42, `disk_*` 28, `system.*` 25, `filestore*` 22 and others |
| `/projects/<p>/buckets/gpu/…` | 200, 113 names (the `DCGM_*` set) |
| `/projects/<p>/buckets/compute/…` | 200, 403 names |
| `/projects/<p>/buckets/nbs/…` | 200, 103 names (volumes) |
| `/projects/<p>/buckets/sp_storage/…` | 200, 7 names (`buckets_stat_*`) |
| `/projects/<p>/buckets/msp/…` | 404: no MLflow or PostgreSQL in the project |
| `/projects/<p>/prometheus/…` (ingested) | 200, 445 names: `node_*` 248, `kube_*` 146 (the agent's cluster metrics). The 2026-10-11 portal run saw 404 here before anything was ingested |
| regional `read.monitoring.eu-north1.nebius.cloud/projects/<p>/service-provider/prometheus/…` | 200 (952 names) |
| `Authorization: Bearer <IAM token>` and `Authorization: <IAM token>` | both 200 |

Series labels: `DCGM_FI_DEV_GPU_UTIL` carries `instance`, `instance_id`, `job`, `mk8s_cluster_id`,
`mk8s_node_group_id`, `uuid` (no `Hostname`, no `gpu`); ingested `kube_pod_status_phase` carries
`k8s.cluster.id`, `k8s.node_group.id`, `namespace`, `pod`, `phase` and others.

`metrics.sh coverage` over `platform/alerts/`:

| Metric | Provider | Ingested | Rule files |
|---|---|---|---|
| `DCGM_FI_DEV_XID_ERRORS`, `DCGM_FI_DEV_ECC_DBE_VOL_TOTAL`, `DCGM_FI_DEV_GPU_UTIL`, `DCGM_FI_DEV_GPU_TEMP` | yes | no | `gpu-health.yaml`, `portal/fleet.yaml` |
| `DCGM_FI_DEV_CLOCK_THROTTLE_REASONS` | **no** (`DCGM_FI_DEV_CLOCKS_EVENT_REASONS` is present) | no | `gpu-health.yaml` |
| `kube_*` (8 names) | no | yes | `inference.yaml`, `scheduling-and-storage.yaml`, `gpu-health.yaml` |
| `node_filesystem_avail_bytes`, `node_filesystem_size_bytes` | yes | yes | `scheduling-and-storage.yaml` |
| `vllm:*` (2 names) | no | no | `inference.yaml` (no vLLM was running) |
| `nebius_estate_*` (5 names) | no | no | `portal/fleet.yaml` (computed by the portal, never stored) |

## Logs (`read.logging.api.nebius.cloud/projects/<p>/loki/api/v1`)

| Request | Result |
|---|---|
| `label/__bucket__/values`, last 24 h | 200: `default`, `sp_mk8s_control_plane`, `sp_serial` |
| `labels?query={__bucket__="sp_serial"}` (and `nebius logging labels --bucket sp_serial`) | `level`, `span_id`, `syslog_facility`, `syslog_level`, `trace_id` (CLI and API agree) |
| `labels?query={__bucket__="sp_mk8s_control_plane"}` | 35 labels: `cluster_id`, `component`, `k8s_event_reason`, `k8s_namespace_name`, `k8s_pod_name`, `level` and the other `k8s_*` keys |
| `labels?query={__bucket__="default"}` | 16 labels from the agent: `k8s_cluster_id`, `k8s_namespace_name`, `k8s_node_group_id`, `k8s_pod_name`, `level` and others; no `mk8s_cluster_id` or `SYSTEMD_UNIT`, so no journald entries |
| `label/level/values` in `sp_mk8s_control_plane` | `debug`, `error`, `fatal`, `info`, `trace`, `unknown`, `warn` |
| `label/k8s_namespace_name/values` in `default` | `inference`, `nvidia-device-plugin`, `o11y` |
| `query_range` `{__bucket__="sp_mk8s_control_plane",level="error"}`, limit 3 | 200, 3 lines |
| `query_range` `{__bucket__="sp_serial"}`, limit 2 | 200, 2 serial-console lines |

## Traces (`read.tracing.api.nebius.cloud/projects/<p>/tempo`)

| Request | Result |
|---|---|
| `api/search/tags` | 501 "old search_tags api not supported" |
| `api/v2/search/tags` | 200: the intrinsic scopes only (no trace ingested) |
