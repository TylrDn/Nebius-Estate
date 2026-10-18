# Validation (bottom-up, P4)

Run in order; don't move up until the step below passes. Each script writes
`results/<step>.json`, and the wrappers stop at the first failing layer.

## Inference (`stacks/inference`): `make validate-cluster` → `tests/validate/run-all.sh`

| Step | Script | Passes when |
|---|---|---|
| 0 Node | `00-nodes.sh` | all nodes Ready; expected platform/preset labels present |
| 1 GPU | `01-gpu.sh` | `nvidia.com/gpu` allocatable on GPU nodes; `nvidia-smi` works in a pod; DCGM exporter up; every DaemonSet covers the tainted GPU nodes |
| 2 NCCL plumbing | `02-interconnect.sh` | one-GPU `all_reduce_perf` exits 0 with `Out of bounds values : 0 OK` and an NCCL version (busbw on one rank is 0 by definition and is not recorded). The pod is waited for up to `NCCL_POD_TIMEOUT_S` (default 900 s, image pull included; `tests/validate/lib-pod.sh`), and a pod that does not finish is recorded with its reason (timeout, Unschedulable, ImagePullBackOff). The verdict is the same on every shape; `fabric` says InfiniBand was not tested (`not-applicable` where `GPU_PLATFORM` has no fabric in `platform/regions.yaml`, e.g. `gpu-l40s-a`) and `multi_gpu` points at `03-nccl.sh` |
| 3 Storage | `03-storage.sh` | storage verdict (`storage_verdict`): the filesystem is mounted (virtiofs) on every node, the RWX StorageClass exists; fio sequential write then read on the mount with `DATA_FIO_JOBS` parallel jobs (default 4 × `DATA_FIO_SIZE` 1G) and both aggregate rates ≥ `DATA_MIN_MIBPS` (default 450 MiB/s: the docs' ceiling for one Network SSD disk, a floor; the filesystem figures in the docs are upper bounds only, so raise it to a measured baseline). The workload PVC (`PVC_NAME`, default `model-cache`) is reported apart in `pvc_check`: Bound passes; missing, or Pending on the chart's `WaitForFirstConsumer` class, is `not-applicable` with a reason (the overlay creates it and `04-workload` needs it); Pending on an `Immediate` class, Lost, or unreadable fails the step |
| 4 Workload | `04-workload.sh` | vLLM Deployment available; `/health` and one chat completion succeed; startup time recorded |
| 5 Load | `05-load.sh` (only with `WITH_LOAD=1`) | the concurrency sweep (`BENCH_CONCURRENCY`, default 1, 8, 32) completes and every point meets the pass bars (`BAR_*`; default E2E p99 ≤ 10 s, every request answered); records p50/p99 TTFT/TPOT/E2E, output tokens/s, cost per 1M output tokens, cold vs warm start and where the generator ran ([`load/README.md`](load/README.md)) |

`run-all.sh` writes `results/summary.json` from the steps of that invocation. On a node with one GPU
and no CPU node (run profile `l40s-gpu-only`) the vLLM Deployment holds the GPU and the `01`/`02`
probe pods stay Pending: run `00`–`02` before deploying the model, then `03`–`05` one by one
([`docs/rescoping.md`](../docs/rescoping.md#r1-inference-on-kubernetes-vllm)).

The same bench runs against R10's VM and R11's Token Factory base URL: `load/bench.sh --target r10|r11`
(same sweep, bars and JSON; R11 is paid per token and refuses without `CONFIRM=yes`). R14's end-to-end
check (Grafana data sources, alert rules loaded, a test alert routed) is
[`recipes/observability/acceptance.sh`](../recipes/observability/acceptance.sh).

## Training (`stacks/training`): `tests/validate/run-training.sh`

Steps: `00-nodes` → `01-gpu` → `03-nccl.sh single-node-8gpu` → `03-nccl.sh <NCCL_OVERLAY>`
(default `multi-node-2x8`; `multi-node-2x8-b200` on B200) → `03-storage`; summary in
`results/summary-training.json`. The DDP job (`workloads/training/ddp`) runs afterwards:
`tests/validate/ddp.sh` applies it, waits, and records rank 0's samples/s (global batch / median
step time after 5 warm-up steps), step time, world size and versions as `results/ddp.json`. It passes
when the job succeeded and printed its summary; `DDP_MIN_SAMPLES_PER_S` adds a bar (default none:
the docs give no DDP figure, so set it from the first recorded run on the same platform, node count,
`BATCH` and `HIDDEN`).

**NCCL pass bar** (multi-node overlays, `03-nccl.sh` via `lib-nccl.sh`):

- average bus bandwidth ≥ `NCCL_MIN_BUSBW` GB/s (default **300**, the docs' stability bar:
  [NCCL tests](https://docs.nebius.com/kubernetes/gpu/nccl-test));
- `# Out of bounds values : 0 OK`;
- transport is InfiniBand: `NET/IB : Using [..]mlx5_X:1/IB`. A `/RoCE` suffix (plain NIC, no
  GPU cluster) or `NET/Socket` fails;
- every worker runs on a node with the same `topology.nebius.com/gpu-cluster-id`.

`NCCL_MIN_BUSBW` is the input for a client's own bar (e.g. `NCCL_MIN_BUSBW=350 tests/validate/run-training.sh`);
the bar applied is recorded as `min_bus_bandwidth_GBps`, and a value that is not a positive number is
refused before the MPIJob is applied.

**Per platform** ([`validate/nccl-bars.tsv`](validate/nccl-bars.tsv); `NCCL_PLATFORM=<platform>`
records the row in the result, `NCCL_MIN_BUSBW` still wins; `bar_source` says which rule set the
bar, including "general docs bar" for a platform not in the table). The docs give one bar for every
GPU-cluster platform their NCCL tutorial lists, and example outputs for two; an example is not a
bar (its node count and message sizes differ from these overlays):

| Platform | Bar (avg busbw, GB/s) | Figure the docs show | Source |
|---|---|---|---|
| `gpu-h100-sxm` | 300 | 317.11 (the tutorial's example; its nodes are H100 8-GPU, 2 nodes, 512 MB–8 GB) | [MK8s NCCL test](https://docs.nebius.com/kubernetes/gpu/nccl-test) |
| `gpu-h200-sxm` | 300 | 355.703 (8 nodes × 8 H200 under Slurm, 512 MB–16 GB) | [Soperator all-reduce](https://docs.nebius.com/slurm-soperator/jobs/examples/nccl-all-reduce) |
| `gpu-b200-sxm`, `gpu-b200-sxm-a` | 300 | unknown: the docs show no B200 figure | MK8s NCCL test |
| `gpu-b300-sxm` | 300 | unknown: the docs show no B300 figure | MK8s NCCL test |
| any other | none | unknown: not a GPU-cluster platform in the tutorial | — |

`single-node-8gpu` records busbw (NVLink) without a bar. Reading the numbers: single-node
busbw is bounded by NVLink, multi-node by the InfiniBand fabric; compare against a baseline you
measured on the same platform, not a vendor figure (P6). The same bar applies to NCCL under
Slurm ([`runbooks/soperator-jobs.md`](../runbooks/soperator-jobs.md)).

## Network (R7) and data plane (R8)

| Script | Passes when |
|---|---|
| `network.sh` (`STAGE=<stage>`) | no node has an `ExternalIP`; a short-lived `curl` pod's egress source address, as an echo endpoint (`ECHO_URL`, default `https://ifconfig.me/ip`) sees it, equals the NAT VM's public address; the workload subnet carries the stack's route table with a `0.0.0.0/0` route |
| `data.sh` | the `workloads/data/copy-job` Job completed with no rclone errors and copied data; records bytes, files and average MiB/s (`COPY_MIN_MIBPS` sets a bar, default none) |
| `checkpoint-restore.sh` (`CKPT_BUCKET`, `S3_ENDPOINT`, a key that may write the bucket) | on the versioned checkpoint bucket, a marker overwritten by a bad save and then deleted is restored both times from its noncurrent version (the [runbook's](../runbooks/data.md#restore-a-checkpoint-from-a-noncurrent-version) list + copy); the drill's versions are removed afterwards |

Run them after `00-nodes` on a cluster deployed into the R7 subnet and with the R8 filesystem
attached ([`runbooks/network.md`](../runbooks/network.md), [`runbooks/data.md`](../runbooks/data.md)).

## Team queues (R16)

| Script | Passes when |
|---|---|
| `kueue.sh` (`--shares <gpus>` on a small cluster) | the sample job is admitted with both pods in one GPU cluster; `team-vision` borrows beyond its GPU share once its jobs fill the cohort; a `team-nlp` job is admitted by preempting a `team-vision` Workload ([`runbooks/team-scheduling.md`](../runbooks/team-scheduling.md#validate)) |

## ML services (R12)

| Script | Passes when |
|---|---|
| `ml-services.sh` (`REGISTRY_URL`, `MLFLOW_HOST`, `PG_HOST`; Secret `ml-services-check`) | the [check Job](../workloads/ml-services/check-job/README.md) pushed to and pulled from the registry, logged and read back an MLflow run and got `1` from `psql` `select 1` (a service whose host is empty is skipped), and a pod without a pull secret pulled the pushed digest ([`runbooks/ml-services.md`](../runbooks/ml-services.md#validate)) |

## Offline checks

- `selftest.sh` (`make selftest`, in CI): the NCCL parser against the logs in `fixtures/`
  (an InfiniBand 2×8 run, a real single-B300 `/RoCE` log, a socket fallback).
  It also checks the per-platform NCCL bar lookup, the DDP summary parser (`fixtures/ddp-*.log`) and
  `train.py`'s samples/s arithmetic (torch stubbed), and runs [`load/selftest.sh`](load/selftest.sh): the load parser and pass bars against
  synthetic sweep logs ([`load/fixtures/`](load/fixtures/README.md)).
- `tests/scripts/test-storage-fio.sh`, `test-checkpoint-restore.sh`, `test-ml-services-check.sh`
  (`make selftest`): `03-storage.sh` against fio JSON fixtures (format of a fio 3.13 run, not a Nebius
  measurement), the restore drill against a stub versioned bucket, `ml-services.sh` against check-Job
  log fixtures; `test-kueue-acceptance.sh`: `kueue.sh` against stub Kueue v1beta2 objects.

For every result record: GPU model, node count, driver, CUDA, NCCL, Kubernetes and operator
versions, plus topology ([`docs/evidence/README.md`](../docs/evidence/README.md)).
