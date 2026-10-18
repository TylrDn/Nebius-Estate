# Service level objectives

Objectives the alert rules in `platform/alerts/` are written against. They are starting
points for a customer conversation, not measurements: nothing in this repository has served
traffic yet. Every threshold change lands here with the date and the evidence that motivated it.

## Inference (vLLM, per stage)

| SLI | How measured | sandbox | staging | prod | Alert |
|---|---|---|---|---|---|
| Availability (ready replica) | `kube_deployment_status_replicas_available > 0` | best effort | 99 % / 30 d | 99.5 % / 30 d | `VllmNoReplicasReady` (critical, 5 min) |
| p95 end-to-end latency | `vllm:e2e_request_latency_seconds` histogram, 5-min window | observe | ≤ 10 s | ≤ 10 s (model-dependent; set per deployment) | `VllmHighE2eLatency` (warning, 10 min) |
| Queue depth | `vllm:num_requests_waiting` 5-min average | observe | ≤ 20 | ≤ 20 | `VllmRequestsQueueing` |
| Error budget burn (restarts) | container restarts / 30 min | observe | ≤ 2 | ≤ 2 | `VllmPodRestarting` |

Throughput (tokens/s) is a capacity number, not an SLO; `tests/load` records it per overlay and
`docs/evidence/` keeps the figures with versions and dates.

## GPU platform

| SLI | Target (staging/prod) | Alert |
|---|---|---|
| GPU node readiness | no GPU node NotReady > 5 min | `GpuNodeNotReady` (critical) |
| GPU hardware health | zero Xid / uncorrectable ECC events | `GpuXidError`, `GpuUncorrectableEccErrors` (critical) |
| Sustained throttling | none > 15 min under load | `GpuThermalOrPowerThrottling` (warning) |
| Metrics pipeline | DCGM metrics present while GPU nodes exist | `GpuMetricsMissing` (warning) |
| Scheduling | no GPU pod Pending > 15 min | `PodsPendingOnGpu` (warning) |

## Training (NCCL)

Not an SLO; a **regression gate** per run: the multi-node NCCL pass bar in
[`tests/README.md`](../tests/README.md#training-stackstraining-testsvalidaterun-trainingsh)
(≥ 300 GB/s average busbw over `/IB`). A run below the bar is a failed validation, recorded in
`docs/evidence/`.

## Storage

| SLI | Target | Alert |
|---|---|---|
| Shared filesystem usage | < 85 % | `SharedFilesystemAlmostFull` |
| Prometheus volume usage | < 85 % of the claim (any `prometheus_pv_size`) | `PrometheusStorageAlmostFull` |

## Where alerts go

Alertmanager is enabled where the [stage policy](../platform/README.md#stage-policy) sets `alertmanager` (`modules/o11y`
`alertmanager_enabled`), with a **null receiver by default**: rules fire visibly in
Prometheus/Alertmanager without paging anyone until a receiver is configured per stage
(`alertmanager_config_secret` on the stack/live root names a Kubernetes Secret you create out of band, so the
receiver's webhook URL or key never lands in git or in Terraform state; `alertmanager_config` is only for
receivers without credentials; see [runbooks/alerting.md](../runbooks/alerting.md)). Sandbox has no
Alertmanager; the same rules can be evaluated with `promtool` offline.
