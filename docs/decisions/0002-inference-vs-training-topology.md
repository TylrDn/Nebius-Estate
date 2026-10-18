# ADR 0002: Inference vs. training topology

- **Status:** accepted
- **Date:** 2026-10-09
- **Owner:** platform

## Context
Inference (Recipe 1) and distributed training (Recipe 3) look alike at Layer 1 (managed
Kubernetes + GPU node groups) but differ in what must be proven before the workload runs.
Training needs GPUs to cooperate across nodes, so interconnect topology and collective
performance become first-class; inference needs a working request path and safe rollouts.

## Options considered
1. One cluster for both, with mixed node groups.
2. Separate environment roots: `stacks/inference` (inference, single-GPU, driver image) and
   `stacks/training` (8-GPU nodes in an InfiniBand GPU cluster, operators opt-in).
3. Training only, serve from the same nodes.

## Decision and rationale
Option 2. The two differ in every layer that matters:

| | `stacks/inference` (inference) | `stacks/training` |
|---|---|---|
| Node preset | `1gpu-*`, enforced | `8gpu-*`, enforced when in a GPU cluster |
| Interconnect | none | `nebius_compute_v1_gpu_cluster` on a named InfiniBand fabric (`fabric-3` H100 / `fabric-7` H200 in eu-north1) |
| Drivers | managed image (`cuda13.0`) + device plugin | the same by default; Network Operator → GPU Operator opt-in for MIG/CDI (ADR-0003) |
| Proof before workload | request path + latency/throughput | single-node NCCL → multi-node NCCL over `NET/IB` |
| Rollout concern | Recreate/undo, PDB | job restart from checkpoint on shared Filestore |
| Default size | 1 GPU | **0 GPUs** (plan-only) until spend approval |

Separate roots also mean separate state (ADR-0005): a training teardown cannot touch the
serving cluster.

## Evidence
`k8s-training/{main,gpu_cluster,locals}.tf` @ `soperator-v4.1.13-2` (`d1c15ca`); InfiniBand fabric table at
docs.nebius.com/compute/clusters/gpu; NCCL-test doc (MPIJob, Training Operator v1.9.3),
all verified 2026-10-09. Bandwidth numbers only exist after `tests/validate/03-nccl.sh` runs.

## Security and cost consequences
Training pods run privileged with IPC_LOCK for RDMA (as in the Nebius doc): keep them in a
dedicated namespace with `pod-security.kubernetes.io/enforce: privileged` and no other
workloads. 8-GPU nodes cost ~8× the lab node per hour; the root defaults to zero of them.

## Failure modes and recovery
`NET/Socket` instead of `NET/IB` on a multi-node run → stop; Network Operator or GPU
cluster membership is wrong. Storage-bound training looks like slow collectives; separate
with `03-storage.sh` first (`runbooks/incident.md`).

## Portability constraints
MPIJob/PyTorchJob manifests port to any Kubeflow cluster; the GPU cluster + fabric are Nebius-specific.

## Review trigger
A workload that needs both serving and training on one cluster, or Nebius changing the fabric table.
