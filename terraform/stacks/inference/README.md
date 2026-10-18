# `stacks/inference` — Kubernetes inference (R1)

**Purpose.** A Managed Kubernetes cluster with a CPU node group and a single-GPU node group on the
managed driver image, a shared filesystem as the model cache, and the platform layer (device plugin,
CSI, observability) owned by Terraform. The vLLM server on top is
[`workloads/inference`](../../../workloads/inference/README.md). Use it when the customer needs their
own runtime, networking or observability ([ADR-0001](../../../docs/decisions/0001-kubernetes-vs-serverless.md));
a managed endpoint is [R6](../../../recipes/serverless/README.md).

**Used by.** [S1](../../../solutions/S1-private-llm-serving-vpn/README.md) private LLM serving with VPN, [S6](../../../solutions/S6-multi-region-dr/README.md) multi-region DR ([all solutions](../../../solutions/README.md)).

## What it builds

| Resource | Notes |
|---|---|
| MK8s cluster | etcd size, endpoint exposure and audit logs from the [stage policy](../../../platform/README.md#stage-policy) |
| CPU node group `-ng-cpu` | `cpu-d3`, system pods, o11y, CSI |
| GPU node group `-ng-gpu` | only when GPU nodes are requested; `1gpu-*` preset from `platform/regions.yaml`, driver image, taint `nvidia.com/gpu` |
| Shared filesystem + `csi-mounted-fs-path` | model cache on every node; or R8's filesystem via `existing_filesystem_id` |
| Device plugin + DCGM, Prometheus/Grafana, Nebius agent | Marketplace releases; Alertmanager where the stage requires it |

## Inputs that matter

| Variable | Default | Meaning |
|---|---|---|
| `gpu_node_count` / `gpu_autoscaling` | 1 / `null` | fixed count or `{min,max}`; the stage cap applies to the maximum |
| `gpu_platform` / `gpu_preset` | region default | `gpu-h100-sxm` / `1gpu-16vcpu-200gb` in `eu-north1` |
| `gpu_preemptible`, `gpu_reservation` | off | only where the stage allows ([ADR-0007](../../../docs/decisions/0007-capacity-on-demand-vs-preemptible.md)) |
| `k8s_version` | `null` | pinned in staging and prod |
| `cluster_name` | `null` → `nip-<stage>-inference` | prefix of the node groups (`…-ng-cpu`, `…-ng-gpu`) and the filesystem (`…-shared-fs`); tenant-unique and fixed at creation ([`docs/naming.md`](../../../docs/naming.md)) |
| `subnet_id`, `security_group_ids`, `service_cidr` | `null` | the project's default subnet (`source scripts/bootstrap-backend.sh` exports `TF_VAR_subnet_id`) or R7 outputs; `subnet_name` has no default |
| `cpu_platform` / `cpu_preset` | `cpu-d3` / `8vcpu-32gb` | the CPU group never carries GPUs: a non-`cpu-*` platform or an `<n>gpu-*` preset is refused, because no stage GPU cap counts this group |
| `cpu_node_count` | `2` | at most 16. `0` creates no CPU node group and leaves the GPU node untainted so it hosts the system add-ons; for a project whose non-GPU vCPU quota is 0. With no nodes at all, `enable_o11y` and `enable_filestore` must be false |
| `propagate_cost_labels` | `true` | node VMs carry the `nip-*` cost allocation labels except the per-run `nip-run` / `nip-ttl-expires`; changing it, or any other label while it is true, recreates every node |
| `existing_filesystem_id` | `null` | R8 output |
| `allowed_cidrs` | `[]` | public-endpoint allowlist; required in staging, each entry /8 or narrower there (prod refuses a public endpoint outright) |

Left `null`, the stage policy sets `etcd_cluster_size`, `public_endpoint`, `audit_logs`,
`filestore_forbid_deletion` and `alertmanager_enabled`; a root may tighten them, never loosen them.

## Outputs and composition

`cluster_id`, `k8s_host` and `cluster_ca_certificate` feed the live root's Kubernetes providers and
`make kubeconfig`; `node_groups`, `filestore` and `grafana_admin_password` serve validation.
Consumes R7 (`subnet_id`, `security_group_ids`, `service_cidr`) and R8 (`filesystem_id`); changing
`service_cidr` on an existing cluster replaces it.

## Quotas and cost

Sandbox: 16 non-GPU vCPU, 1 GPU VM, ~800 GiB SSD, 64 GiB filesystem
([`docs/capacity.md`](../../../docs/capacity.md#stacksinference)). Billed while it exists: nodes,
disks, filesystem; the control plane is free ([`docs/cost.md`](../../../docs/cost.md#cost-shape-per-recipe)).

The default non-GPU vCPU quota (`compute.instance.non-gpu.vcpu`) is **0** in `eu-north1` and
`us-central1` (`.cache/nebius-docs/compute/resources/quotas-limits.md:41`, Compute quotas), so the
CPU node group cannot be created there until it is raised; the first sandbox apply hit exactly this
([evidence](../../../docs/evidence/2026-10-11-sandbox-inference-portal-connectors.md)). Request the
quota, or run with `cpu_node_count = 0` ([`runbooks/deploy.md`](../../../runbooks/deploy.md)). That
path ran once on 1 preemptible L40S `1gpu-8vcpu-32gb`, live calculator ≈ $0.78/h including disk and
filesystem ([evidence](../../../docs/evidence/2026-10-11-sandbox-inference-populate.md); list price,
not a quote).

## Validate

- Static: `terraform test` (mocked): stage policy, preconditions, sizing modes, R7/R8 wiring.
- Live: [`runbooks/deploy.md`](../../../runbooks/deploy.md), then `make validate-cluster`
  (`WITH_LOAD=1` adds the benchmark; bars in [`tests/README.md`](../../../tests/README.md)).

## Evidence

| Run | What it shows | What it does not |
|---|---|---|
| [2026-10-11 first sandbox apply](../../../docs/evidence/2026-10-11-sandbox-inference-portal-connectors.md) (1 preemptible L40S, `eu-north1`) | cluster, GPU node group and filesystem created; clean destroy | CPU node group (quota 0); GPU allocatable never confirmed |
| [2026-10-11 second sandbox apply](../../../docs/evidence/2026-10-11-sandbox-inference-populate.md), `cpu_node_count = 0` | 12 resources created; `nvidia.com/gpu` allocatable 1 on the untainted GPU node; Qwen2.5-1.5B weights loaded | vLLM engine start failed on the read-only root filesystem; the manifest fix was not re-run; no serving, throughput or latency figure; billed cost pending the export |
| [2026-10-12 sixth sandbox apply](../../../docs/evidence/2026-10-12-sandbox-inference-validate.md), `l40s-gpu-only` with the R8 filesystem and the R12 node identity | 11 resources in 9 min; L40S 46,068 MiB, driver 580.173.02; `00-nodes`, `01-gpu` pass (after a check fix); headroom for vLLM; clean destroy | NCCL step timed out; no vLLM deployed, so nothing served or benchmarked |
| [2026-10-08 B300 smoke](../../../docs/evidence/2026-10-08-mk8s-b300-gpu-smoke.md) | the driver-image + device-plugin pattern on one B300 | upstream recipe, not this stack |

The serverless bench of 2026-10-08 left [a cost estimate only](../../../docs/evidence/costs.md#runs-with-a-cost-estimate-only);
no figure from it may be quoted.

## Teardown

`make destroy-plan destroy STAGE=<stage> STACK=inference CONFIRM=yes`, then `make leftovers`
([`runbooks/teardown.md`](../../../runbooks/teardown.md)).

## Upstream references

[MK8s GPU set-up](https://docs.nebius.com/kubernetes/gpu/set-up) ·
[node groups](https://docs.nebius.com/kubernetes/node-groups/manage) ·
[filesystems over CSI](https://docs.nebius.com/kubernetes/storage/filesystem-over-csi) ·
`vllm` chart in `nebius/nebius-k8s-applications` ·
solutions library `k8s-training/` (module shapes).
