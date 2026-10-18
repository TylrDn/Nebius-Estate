# Training workloads — NCCL validation and PyTorch DDP (Recipe 3, Layer 3)

The jobs that prove and use a training cluster, in a fixed order (P4): **single node → NCCL
across nodes → the training job**. The cluster, GPU cluster and driver path underneath are
[`stacks/training`](../../terraform/stacks/training/README.md); pass bars are in
[`tests/README.md`](../../tests/README.md#training-stackstraining-testsvalidaterun-trainingsh).

```
install-training-operator.sh       Kubeflow Training Operator v1.9.3 (MPIJob / PyTorchJob CRDs), as in the Nebius NCCL-test doc
nccl/base                          MPIJob running all_reduce_perf (docs/kubernetes/gpu/nccl-test)
nccl/overlays/lab-1gpu             1 worker × 1 GPU: plumbing smoke test on the inference cluster's GPU node
nccl/overlays/single-node-8gpu     1 worker × 8 GPUs: NVLink only, no network
nccl/overlays/multi-node-2x8       2 workers × 8 GPUs: InfiniBand (stacks/training with gpu_node_count = 2)
nccl/overlays/multi-node-2x8-b200  the same on B200, via components/b200
nccl/components/b200               swaps in the B200 image and adds -mca coll ^hcoll
ddp/                               PyTorchJob: torchrun DDP on 1..N nodes with a synthetic model (proves the stack, not a benchmark)
```

| Pin | Value | Source |
|---|---|---|
| NCCL tests (H100/H200, base) | `nccl-tests:2.23.4-ubu22.04-cu12.4` | [NCCL tests doc](https://docs.nebius.com/kubernetes/gpu/nccl-test), H100/H200 tab |
| NCCL tests (B200, component) | `nccl-tests:2.26.5-ubu22.04-cu12.8` + `-mca coll ^hcoll` | same doc, B200 tab (no B300 manifest yet) |
| Training Operator | `v1.9.3` | same doc |
| PyTorch (DDP) | by digest in `ddp/pytorchjob.yaml` | [`docs/compatibility-matrix.md`](../../docs/compatibility-matrix.md) |

Prerequisite: `tests/validate/00-nodes.sh` and `01-gpu.sh` pass on the target cluster. The
`nccl-test` namespace is privileged with `IPC_LOCK` for RDMA, as in the Nebius doc: run it only
on a dedicated cluster ([`docs/security.md`](../../docs/security.md)).

## Run

```bash
workloads/training/install-training-operator.sh
kubectl apply -k workloads/training/nccl/overlays/single-node-8gpu   # or lab-1gpu / multi-node-2x8
tests/validate/03-nccl.sh single-node-8gpu                           # waits, parses, writes results/03-nccl-<overlay>.json
tests/validate/run-training.sh                                       # the whole bottom-up sequence
tests/validate/ddp.sh                                                # after NCCL passes: runs workloads/training/ddp, writes results/ddp.json (samples/s)
```

`03-nccl.sh` records the image, flags, message sizes, the per-size busbw table, average bus
bandwidth (not for `lab-1gpu`: on one rank it is 0 by definition), the transport and whether
every worker sits in one GPU cluster. A failing multi-node result is a platform failure to fix
before training ([`runbooks/incident.md`](../../runbooks/incident.md#nccl--interconnect-training-env)).

## Placement on the fabric (beyond two nodes)

GPU nodes in a GPU cluster carry `topology.nebius.com/gpu-cluster-id`, `tier-2` and `tier-1`
labels (`kubectl get nodes -L topology.nebius.com/gpu-cluster-id,topology.nebius.com/tier-2,topology.nebius.com/tier-1`).
For jobs larger than one rack, a topology-aware scheduler such as Kueue (feature gate
`TopologyAwareScheduling`) with a `Topology` over those labels keeps a job's pods close together;
annotate the pod template with `kueue.x-k8s.io/podset-required-topology: "topology.nebius.com/gpu-cluster-id"`
or `…-preferred-topology: "topology.nebius.com/tier-2"`
([topology-aware scheduling](https://docs.nebius.com/kubernetes/gpu/topology-aware-scheduling#how-to-enable-topology-aware-scheduling)).
This directory does not install it (the 2-node NCCL proof does not need it); R16
[`workloads/kueue`](../kueue/README.md) installs Kueue v0.20.1 with a Topology over these labels.
