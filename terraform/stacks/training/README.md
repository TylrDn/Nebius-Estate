# `stacks/training` — Distributed training (R3)

**Purpose.** A Managed Kubernetes cluster for multi-node training: 8-GPU nodes in an InfiniBand
GPU cluster on the managed driver image with the device plugin
([ADR-0003](../../../docs/decisions/0003-gpu-driver-ownership.md)), a shared dataset and checkpoint
filesystem, and observability. Jobs (NCCL test, PyTorch DDP) are
[`workloads/training`](../../../workloads/training/README.md). Researchers who want `sbatch` use
[R4](../soperator/README.md).

**Used by.** [S2](../../../solutions/S2-fine-tune-70b-two-weeks/README.md) 70B fine-tune, [S4](../../../solutions/S4-burst-training-preemptible/README.md) burst training on preemptible, [S9](../../../solutions/S9-data-science-notebooks/README.md) data-science notebooks ([all solutions](../../../solutions/README.md)).

## What it builds

| Resource | Notes |
|---|---|
| MK8s cluster + CPU node group | stage policy as in R1 |
| GPU cluster (InfiniBand) | only when `gpu_node_count > 0`; fabric from `platform/regions.yaml` |
| GPU node group | 8-GPU preset, driver image, taint `nvidia.com/gpu`, label `nip.nebius.io/infiniband` |
| Shared filesystem + CSI | datasets and checkpoints; or R8's filesystem |
| Device plugin + DCGM, or Network Operator → GPU Operator | the operator path is opt-in (`enable_gpu_operator`) for MIG/CDI |
| Prometheus/Grafana, Nebius agent | Alertmanager where the stage requires it |

The Kubeflow Training Operator (MPIJob/PyTorchJob CRDs) is not Terraform:
`workloads/training/install-training-operator.sh` after apply.

**Plan-only by default:** `gpu_node_count = 0` creates no GPU cluster or GPU node group; raising
it is a separate, reviewed change with a spend approval.

## Inputs that matter

| Variable | Default | Meaning |
|---|---|---|
| `gpu_node_count` | 0 | 8-GPU nodes; 2 is the minimum for a multi-node NCCL test; stage caps 4/8/32 |
| `gpu_reservation` | `null` | prod requires `STRICT` whenever GPU nodes are requested |
| `enable_gpu_cluster`, `infiniband_fabric` | `true`, region default | an IB cluster needs an 8-GPU preset |
| `enable_gpu_operator`, `mig_strategy` | `false` | operator-managed drivers instead of the driver image |
| `cluster_name` | `null` → `nip-<stage>-training` | prefix of the node groups (`…-ng-cpu`, `…-ng-gpu`) and the filesystem (`…-shared-fs`); tenant-unique and fixed at creation ([`docs/naming.md`](../../../docs/naming.md)) |
| `subnet_id`, `security_group_ids`, `service_cidr` | `null` | the project's default subnet (`source scripts/bootstrap-backend.sh` exports `TF_VAR_subnet_id`) or R7 outputs; `subnet_name` has no default |
| `propagate_cost_labels` | `true` | node VMs carry the `nip-*` cost allocation labels except the per-run `nip-run` / `nip-ttl-expires`; changing it, or any other label while it is true, recreates every node |
| `existing_filesystem_id` | `null` | R8 output |
| `filestore_size_gib` | 256 | sizing files: 256 / 1,024 / 4,096 |

## Outputs and composition

`cluster_id`, `k8s_host`, `gpu_cluster`, `node_groups`, `filestore`. Consumes R7 and R8 like R1;
changing `service_cidr` on an existing cluster replaces it.

## Quotas and cost

GPU quota is the gate: 8 GPUs per node in one fabric
([`docs/capacity.md`](../../../docs/capacity.md#stackstraining)). The CPU node group (`cpu_node_count`
1–16, `variables.tf:116-125`; no zero option, unlike R1; `cpu_platform` must be `cpu-*` and `cpu_preset` not
`<n>gpu-*`, since no stage GPU cap counts this group) needs non-GPU vCPU quota, whose default is
**0** in `eu-north1` and `us-central1` (`.cache/nebius-docs/compute/resources/quotas-limits.md:41`): raise it first
([evidence](../../../docs/evidence/2026-10-11-sandbox-inference-portal-connectors.md)). At 0 GPU nodes it costs the CPU
nodes, disks and filesystem; GPU nodes bill per hour while they exist.

## Validate

- Static: `terraform test` (mocked): GPU cluster only with GPU nodes, fabric and preset checks,
  operator path, stage policy.
- Live: [`runbooks/deploy.md`](../../../runbooks/deploy.md#training-stack-stacktraining), then
  `tests/validate/run-training.sh`; multi-node passes only over InfiniBand at ≥ 300 GB/s
  ([`tests/README.md`](../../../tests/README.md)).

## Evidence

None of this stack yet: not run live. The prior upstream
[B300 smoke](../../../docs/evidence/2026-10-08-mk8s-b300-gpu-smoke.md) covers the driver-image path and
single-GPU NCCL init only; **multi-node InfiniBand has never been measured**.

## Teardown

Set `gpu_node_count = 0` and apply to release GPUs, then
`make destroy-plan destroy STAGE=<stage> STACK=training CONFIRM=yes` and `make leftovers`
([`runbooks/teardown.md`](../../../runbooks/teardown.md)).

## Upstream references

[MK8s GPU set-up](https://docs.nebius.com/kubernetes/gpu/set-up) ·
[GPU clusters](https://docs.nebius.com/compute/clusters/gpu) ·
[reservations](https://docs.nebius.com/kubernetes/node-groups/reservations) ·
solutions library `k8s-training/` at `soperator-v4.1.13-2`.
