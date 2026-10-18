# Rescoping a recipe for a client

Each recipe ships at the smallest shape that proves it. For a client, a solutions architect changes a
few inputs along four dimensions and re-runs the check that proves the new shape. This page lists,
per recipe, which inputs those are, which meter each one moves, and which acceptance check or bench
proves the result. It names inputs and meters, never prices: prices are read on the day for the exact
region and preset with `price.py` ([R9](../recipes/finance/README.md#pricing-and-tco-method)) and
recorded with their date ([`docs/cost.md`](cost.md)).

| Dimension | Question to answer first ([`AGENTS.md`](../AGENTS.md) policy) |
|---|---|
| Workload | which model or job, traffic shape (prompt and completion length, concurrency), data size, latency and throughput targets |
| Scale | GPUs or nodes, replicas, filesystem and bucket sizes, teams sharing the capacity |
| Region | data residency, which GPU platforms and services the region offers ([`platform/regions.yaml`](../platform/regions.yaml)), latency to the users |
| Budget | approved spend per run or month, on-demand vs preemptible vs reserved ([`docs/capacity.md`](capacity.md)) |

## Applies to every recipe

- **Region.** Every stack takes `region` (default `eu-north1`). A platform, preset, InfiniBand fabric,
  Object Storage class or managed service is used only where `platform/regions.yaml` lists it for that
  region; the plan refuses the rest. Prices differ per region, so re-run `price.py` after a region
  change; quotas are per region too (`make quota-check`).
- **Scale is capped per stage.** `max_gpu_nodes` in [`platform/stages.yaml`](../platform/stages.yaml)
  caps every GPU count at plan time (sandbox, staging, prod differ). A client shape above the cap is
  a reviewed change to the stage policy, not a tfvars edit.
- **Budget.** Write the client shape as a footprint file (`solutions/S*/footprint*.json` are the
  examples), price it with `price.py` (`--advice` adds the capacity advisor), fill the
  [estimate worksheet](cost.md#estimate-worksheet), and attach both to the spend approval. Quotas are
  the only hard cap; budgets only notify ([spend controls](cost.md#spend-controls)).
- **Runs.** A client shape for a sandbox run is best written as a run profile
  (`platform/profiles/<stack>/<name>.json`, `PROFILE=<name>` on `make preflight`, `make plan` and
  `make destroy-plan`), which renders the shape and its `nip-run` / `nip-ttl-expires` labels;
  `make preflight` checks the plan's quota demand, capacity, region and platform, spot caps, stage caps and the TTL
  before the plan, and `make ttl-teardown` arms the teardown at the TTL
  ([deploy](../runbooks/deploy.md#preflight)).
- **Proof.** A number needs its method, exact versions and an evidence file (P6,
  [`docs/evidence/`](evidence/README.md)). The bars below are defaults; set the client's bar as the
  input named, and the result file records the bar it was judged against.

## R1 Inference on Kubernetes (vLLM)

[`terraform/stacks/inference`](../terraform/stacks/inference/README.md) +
[`workloads/inference`](../workloads/inference/README.md)

| | Inputs to change | Default |
|---|---|---|
| Workload | `MODEL` + `MODEL_REVISION` (the pin is required), `MAX_MODEL_LEN`, `GPU_MEMORY_UTILIZATION`, `OVERLAY` through [`workloads/inference/render.sh`](../workloads/inference/render.sh) | the `qwen2.5-1.5b` overlay: `Qwen/Qwen2.5-1.5B-Instruct`, 8192, 0.85 |
| Scale | `gpu_node_count` or `gpu_autoscaling`, `gpu_platform` / `gpu_preset`, `cpu_node_count`, `filestore_size_gib`; replicas through `OVERLAY=qwen2.5-7b-prod` (one replica per GPU node) | 1 GPU node, 2 CPU nodes, 64 GiB filesystem (sandbox) |
| Region | `region`; the GPU platform must be listed for it | `eu-north1`, `gpu-h100-sxm` |
| Budget | `gpu_preemptible` (sandbox only) with `gpu_spot_pricing_policy_id` from R9; `gpu_reservation` for committed capacity | on-demand |
| Costs | GPU and CPU nodes bill per second while they exist, busy or idle; the filesystem per GiB-hour of provisioned size. A larger model needs a GPU with the memory for weights plus KV cache (raising `MAX_MODEL_LEN` grows the cache), which can mean a larger preset; the model is cached on the shared filesystem through the `model-cache` PVC (40 Gi in `base/pvc.yaml`), so a larger model also needs a larger PVC and `filestore_size_gib`. Cost per output token is the formula in [`docs/evidence/costs.md`](evidence/costs.md#cost-per-output-token-a-method-not-a-result), fed by the bench | [cost shape](cost.md#cost-shape-per-recipe) |
| Proved by | `make validate-cluster` (nodes → GPU → NCCL plumbing → storage → `04-workload`), then the bench at the client's traffic shape: `BENCH_INPUT_LEN`, `BENCH_OUTPUT_LEN`, `BENCH_NUM_PROMPTS`, `BENCH_CONCURRENCY` (the sweep points), `BENCH_WARMUP_PROMPTS` with `WITH_LOAD=1`, judged against the pass bars `BAR_*`; the shape that ran is recorded under `params` in `results/05-load.json` | bench defaults 256 / 128 tokens, 200 prompts at each of concurrency 1, 8, 32, 10 warm-up ([method](../tests/load/README.md)) |

Example: a RAG client on the 7B model with 16k context, measured at its own traffic shape.

```bash
OVERLAY=qwen2.5-7b MAX_MODEL_LEN=16384 workloads/inference/render.sh | kubectl apply -f -
BENCH_INPUT_LEN=4096 BENCH_OUTPUT_LEN=256 BENCH_CONCURRENCY="1 4 16" WITH_LOAD=1 make validate-cluster
```

On a node with one GPU and no CPU node (the `l40s-gpu-only` profile), vLLM holds the only GPU, so the
`01-gpu` and `02-interconnect` probe pods stay Pending: run `00`–`02` before the model is deployed, then
`03-storage`, `04-workload` and `05-load.sh` one by one, and check the node has room for the bench Job
beside vLLM ([live-run plan](plans/2026-10-12-live-runs.md), run 2 step 3).

## R2 Foundation and lifecycle

[`terraform/`](../terraform/README.md) (`live/foundation`, `modules/stage-policy`)

| | Inputs to change | Default |
|---|---|---|
| Workload | which stacks the client runs decides which stage roots are rendered (`make render-live`) | every stack |
| Scale | the stages the client needs and their policy in `platform/stages.yaml` (GPU caps, TTL, preemptible, deletion protection) | sandbox, staging, prod |
| Region | `region` of each stage project and its state bucket | `eu-north1` |
| Budget | the stage caps are the plan-time budget control; quotas per project are the hard stop | [stage policy](../platform/README.md#stage-policy) |
| Costs | the state buckets at Object Storage prices; the rest are projects and IAM objects | — |
| Proved by | `make ci` (render-live-check, mocked tests, `make policy`, and the script tests of run profiles, `make preflight` and `make ttl-teardown`); a client policy change shows in the generated stage-policy table and the conftest rules. Live, per run: `make preflight STAGE= STACK= [PROFILE=]` prints `GO` before `make plan`, and the TTL job is armed before `make apply` | — |

## R3 Distributed training (DDP, NCCL)

[`terraform/stacks/training`](../terraform/stacks/training/README.md) +
[`workloads/training`](../workloads/training/README.md)

| | Inputs to change | Default |
|---|---|---|
| Workload | the DDP job (`workloads/training/ddp`: replicas, `nvidia.com/gpu`, `nprocPerNode`); `NCCL_OVERLAY` for the platform (`multi-node-2x8-b200` on B200) | one GPU per replica; `multi-node-2x8` |
| Scale | `gpu_node_count` (8-GPU nodes; 2 is the minimum for a multi-node test), `enable_gpu_cluster`, `infiniband_fabric`, `filestore_size_gib` | 0 GPU nodes until approved; 256 GiB |
| Region | `region`; InfiniBand needs a platform with a fabric there | `eu-north1` |
| Budget | `gpu_reservation` (prod requires STRICT whenever GPU nodes > 0); `gpu_preemptible` for burst ([S4](../solutions/S4-burst-training-preemptible/README.md)) | on-demand |
| Costs | each 8-GPU node is 8 GPU-hours per wall-hour while it exists, plus a 1,023 GiB boot disk; a reservation is billed on its own terms ([billing for reservations](https://docs.nebius.com/compute/virtual-machines/reservations#billing-for-reservations)) | [cost shape](cost.md#cost-shape-per-recipe) |
| Proved by | `tests/validate/run-training.sh`: multi-node NCCL (its step `tests/validate/03-nccl.sh`) passes on InfiniBand, one GPU cluster, average busbw ≥ `NCCL_MIN_BUSBW` (default 300 GB/s, the docs' bar; set the client's bar or a baseline measured on the same platform). The bar applied is recorded as `min_bus_bandwidth_GBps`. Then the workload: `tests/validate/ddp.sh` records samples/s and step time, with a bar only when `DDP_MIN_SAMPLES_PER_S` is set (from the first recorded run on the same platform and node count) | [NCCL bar](../tests/README.md#training-stackstraining-testsvalidaterun-trainingsh) |

## R4 Slurm on Kubernetes (Soperator)

[`terraform/stacks/soperator`](../terraform/stacks/soperator/README.md)

| | Inputs to change | Default |
|---|---|---|
| Workload | partitions and node sets in a profile next to [`profiles/lab.tfvars`](../terraform/stacks/soperator/profiles/lab.tfvars) | lab profile: one CPU worker |
| Scale | worker node sets (GPU platform, count), jail and `/data` filesystem sizes | lab sizes; prod 2,048 GiB jail and `/data` |
| Region | `region` in the stage var file | `eu-north1` |
| Budget | GPU workers are the cost; keep the lab profile until the client shape is priced | no GPU |
| Costs | controller, login and worker VMs, Network SSD and IO_M3 disks and the shared filesystems bill while they exist | [cost shape](cost.md#cost-shape-per-recipe) |
| Proved by | `make soperator-check` (mocked plan per stage), then [`runbooks/soperator-jobs.md`](../runbooks/soperator-jobs.md): `sinfo`, `sbatch`, NCCL across workers at the same bar as R3 | — |

## R5 Team namespaces and SkyPilot

[`recipes/team-platform`](../recipes/team-platform/README.md)

| | Inputs to change | Default |
|---|---|---|
| Workload | the SkyPilot task (`resources.accelerators`, `ARTIFACT_BUCKET`) | `H100:1` |
| Scale | one namespace per team; `requests.nvidia.com/gpu` in each `ResourceQuota`; R1's `gpu_node_count` sized to the sum of the shares | 1 GPU, one team |
| Region | the R1 cluster's region; `S3_ENDPOINT` in the task matches the artifact bucket's region | — |
| Budget | the quota divides GPUs the client already pays for in R1 | — |
| Costs | no new billable resource; a task holds an R1 GPU while it runs | — |
| Proved by | `make kustomize` (CI); live, the task's `/artifacts/metrics.json` and `sky down` freeing the quota | — |

## R6 Serverless AI vs. Kubernetes

[`recipes/serverless`](../recipes/serverless/README.md)

| | Inputs to change | Default |
|---|---|---|
| Workload | `MODEL` / `MODEL_REVISION` (keep them equal to R1's for a like-for-like comparison), `VLLM_IMAGE` | as R1's default overlay |
| Scale | `PLATFORM` / `PRESET` of the endpoint or job | `gpu-l40s-a` / `1gpu-8vcpu-32gb` |
| Region | the project's region | — |
| Budget | how long the endpoint must exist (cold starts included) against request volume; serverless wins on bursty demand, the cluster when the GPU is busy most of the time | — |
| Costs | per second while the endpoint exists or the job runs | [recipe](../recipes/serverless/README.md#quotas-cost-run-validate) |
| Proved by | `endpoint.sh measure` and `job.sh` write pass/fail JSON; `compare.py` against R1's `05-load.json`. The serverless bench is the R1 method (`tests/load`, same `BENCH_*` shape and bars); `MEASURE_FROM=cluster` runs it in-region from the R1 cluster, and `compare.py` labels a comparison like-for-like only when both ran in-region with the same `params` | — |

## R7 Private network perimeter

[`terraform/stacks/network`](../terraform/stacks/network/README.md)

| | Inputs to change | Default |
|---|---|---|
| Workload | `enable_bastion` with `allowed_cidrs` (the client's ranges), `wireguard_cidr` not overlapping their on-prem ranges | no bastion in sandbox |
| Scale | `vm_preset` of the NAT VM (NAT throughput scales with vCPUs), `cidr` per stage | `4vcpu-16gb`, `10.40.0.0/16` |
| Region | `region` | `eu-north1` |
| Budget | the NAT VM (and the bastion) exist for the life of the stage, not per run | — |
| Costs | NAT VM and its boot disk, one public IP each for NAT and bastion | [cost shape](cost.md#cost-shape-per-recipe) |
| Proved by | `tests/validate/network.sh`: no node has a public IP; egress leaves through the NAT address | — |

## R8 Dataset and checkpoint data plane

[`terraform/stacks/data`](../terraform/stacks/data/README.md) +
[`workloads/data/copy-job`](../workloads/data/copy-job/kustomization.yaml)

| | Inputs to change | Default |
|---|---|---|
| Workload | `transfer` (source, rate limits), the copy job's `SOURCE` / `TARGET` / `TRANSFERS`, `dataset_storage_class` (`ENHANCED_THROUGHPUT` for high-throughput reads) | no transfer; region default class |
| Scale | `filesystem_size_gib` (the working set, not the whole bucket), `checkpoint_noncurrent_days` | 256 GiB; 14 days |
| Region | `region`; residency requirements decide it ([S7](../solutions/S7-eu-data-residency/README.md)); the storage classes offered differ per region | `eu-north1` |
| Budget | provisioned filesystem size and stored bytes, including non-current checkpoint versions until they expire | — |
| Costs | filesystem per GiB-hour provisioned; buckets per stored GiB | [cost shape](cost.md#cost-shape-per-recipe) |
| Proved by | `tests/validate/03-storage.sh` (fio write and read on the filesystem; both rates ≥ `DATA_MIN_MIBPS`), `tests/validate/data.sh` (the copy Job's bucket-to-filesystem rate ≥ `COPY_MIN_MIBPS`) and `tests/validate/checkpoint-restore.sh` (a checkpoint restored from its noncurrent version); set each bar to the client's throughput target ([tests](../tests/README.md#network-r7-and-data-plane-r8)). The first live run records a baseline for the provisioned filesystem size | `DATA_MIN_MIBPS` 450 MiB/s (a floor taken from the docs' ceiling for one Network SSD disk; the filesystem figures are "up to" only, so replace it with the measured baseline); `COPY_MIN_MIBPS` 0 (record only) |

## R9 Finance and governance

[`recipes/finance`](../recipes/finance/README.md) + [`terraform/stacks/governance`](../terraform/stacks/governance/README.md)

| | Inputs to change | Default |
|---|---|---|
| Workload | the footprint file describing the client shape | `solutions/S*/footprint*.json` |
| Scale | `capacity_limits` (keep lower stages off reserved GPUs), `quota_watch` | none |
| Region | `region`; spot caps only where `platform/regions.yaml` marks `spot_price_cap: true` | `eu-north1` |
| Budget | `spot_price_caps` per GPU platform; the console budget per project | none |
| Costs | nothing billable; the FOCUS export's bucket at Object Storage prices | — |
| Proved by | `price.py <footprint> --dry-run` (CI), then `price.py` live with a read-only identity; governance `terraform test` | — |

## R10 GPU VM quickstart

[`terraform/stacks/gpu-vm`](../terraform/stacks/gpu-vm/README.md)

| | Inputs to change | Default |
|---|---|---|
| Workload | `model` (a `workloads` key in `platform/versions.yaml` with a pinned revision), `vllm_extra_args` | `qwen2.5-1.5b-instruct` |
| Scale | `platform` / `preset` (a multi-GPU preset sets tensor parallelism), `boot_disk_size_gib`, `existing_filesystem_id` | region default 1-GPU preset; 200 GiB |
| Region | `region`; needs R7's NAT for egress | `eu-north1` |
| Budget | `preemptible` with `spot_pricing_policy_id` (sandbox only) | on-demand |
| Costs | the VM while it exists; the boot disk running or stopped | [recipe](../terraform/stacks/gpu-vm/README.md#quotas-and-cost) |
| Proved by | [`runbooks/gpu-vm.md`](../runbooks/gpu-vm.md#validate): server up, `nvidia-smi`, `/v1/models`, a chat completion; a load figure: `tests/load/bench.sh --target r10` (the R1 sweep, `BENCH_*` and bars, same JSON; the key is read over SSH) | — |

## R11 Token Factory

[`recipes/token-factory`](../recipes/token-factory/README.md)

| | Inputs to change | Default |
|---|---|---|
| Workload | the model (`list-models.sh`), prompt and completion size; for the load bench a model whose id is a public Hugging Face repo, or a named tokenizer (`--tokenizer` / `BENCH_TOKENIZER`, token counts approximate) | smoke: `nvidia/Nemotron-3_5-Lightning`; bench: `Qwen/Qwen3-30B-A3B-Instruct-2507` (`--model` / `BENCH_MODEL`) |
| Scale | public endpoint (per token) vs dedicated endpoint (replicas, GPUs) | public |
| Region | a dedicated endpoint fixes region and capacity; for public endpoints the region is not an input of this recipe | — |
| Budget | monthly input and output tokens × the listed per-token prices, re-read with `list-models.sh --verbose` | — |
| Costs | per token (public); per GPU-hour while a dedicated replica is ready | [cost model](../recipes/token-factory/README.md#cost-model) |
| Proved by | `smoke.py --dry-run` (CI); `smoke.py --yes --json` live, one request, the owner decides each run; a load figure: `CONFIRM=yes tests/load/bench.sh --target r11` (the R1 sweep, paid per token, after a free check that the tokenizer repo resolves on Hugging Face; the cost line needs the listed per-token price, [method](../tests/load/README.md)) | — |

## R12 ML services (registry, MLflow, PostgreSQL)

[`terraform/stacks/ml-services`](../terraform/stacks/ml-services/README.md)

| | Inputs to change | Default |
|---|---|---|
| Workload | `enable_mlflow`, `enable_postgresql`, `node_pull_scope` | registry only |
| Scale | `postgresql` preset, `hosts`, `disk_size_gibibytes` (can grow, never shrink), `max_connections` | `2vcpu-8gb`, 1 host, 96 GiB |
| Region | `region`; MLflow and PostgreSQL are not offered everywhere ([region availability](../terraform/stacks/ml-services/README.md#region-availability)) | `eu-north1` |
| Budget | MLflow is one size for its whole life; PostgreSQL hosts and disk scale it | — |
| Costs | MLflow cluster and PostgreSQL hosts per hour while they exist, disks per GiB; the registry is free | [recipe](../terraform/stacks/ml-services/README.md#quotas-and-cost) |
| Proved by | `tests/validate/ml-services.sh` ([`runbooks/ml-services.md`](../runbooks/ml-services.md#validate)): push and pull an image (by digest, from a node with no pull secret), log an MLflow run and read it back, `psql` through the private endpoint; one pass: a second `make plan` after the apply prints "No changes" | — |

## R13 CI federation and team groups

[`terraform/modules/foundation/ci-federation`](../terraform/modules/foundation/ci-federation/README.md)

| | Inputs to change | Default |
|---|---|---|
| Workload | `repository` (the client's), `stages` with their `jobs` | off |
| Scale | `groups`: the client's teams, project-scoped | none |
| Region | none: IAM objects are not regional | — |
| Budget | nothing billable | — |
| Costs | IAM objects only | — |
| Proved by | mocked `terraform test` (subjects, refusals); live, a federated plan and then a federated apply from the stage's GitHub Environments ([`runbooks/identity.md`](../runbooks/identity.md#first-federated-run); the sandbox plan side ran on 2026-10-11) | — |

## R14 Observability

[`recipes/observability`](../recipes/observability/README.md)

| | Inputs to change | Default |
|---|---|---|
| Workload | which signals the client needs and the alert rules in `platform/alerts/` | provider metrics |
| Scale | projects to read (`--project`), log `--since` window (at most 14 days) | — |
| Region | `NIP_O11Y_MONITORING_URL` / `NIP_O11Y_LOGGING_URL` for a regional host | the global hosts |
| Budget | in-cluster Prometheus disk belongs to R1/R3; a log export bills its bucket | — |
| Costs | Monitoring, Logging and Tracing are in preview and free of charge ([pricing](https://docs.nebius.com/observability/resources/pricing)) | — |
| Proved by | `make recipes-check` (dry runs, refusals); live, read-only metric names and log labels; end to end, `recipes/observability/acceptance.sh` ([runbook](../runbooks/observability.md#alerts-end-to-end-in-cluster-prometheus-and-alertmanager-moduleso11y)): Grafana data sources provisioned and healthy, every `platform/alerts` rule loaded, a test alert active and routed to a receiver (delivery confirmed at the receiver) | — |

## R15 Rack-scale GB300 NVL72

[`terraform/stacks/nvl`](../terraform/stacks/nvl/README.md)

| | Inputs to change | Default |
|---|---|---|
| Workload | training that needs one NVLink domain of 72 GPUs | — |
| Scale | `racks` (whole racks, 0–8; 18 nodes, 72 GPUs each), `gpu_cluster_id` for 2+ racks | 0 |
| Region | where the client's GB300 reservation is | — |
| Budget | `capacity_reservation_ids`: a rack exists only on a reservation, at the commitment's rate for its term; every stage caps `nvl` at 0 until one is approved | 0 racks |
| Costs | per rack 18 nodes plus 18 × 1,024 GiB boot disks; GB300 has no list price on the pricing page | [recipe](../terraform/stacks/nvl/README.md#quotas-and-cost) |
| Proved by | mocked `terraform test`; live ([`runbooks/nvl.md`](../runbooks/nvl.md#validate)): 18 `Ready` nodes per rack, NVLink status, an NCCL all-reduce across 72 GPUs (bar: unknown until measured on the platform) | — |

## R16 Team scheduling (Kueue)

[`workloads/kueue`](../workloads/kueue/README.md)

| | Inputs to change | Default |
|---|---|---|
| Workload | the topology request on the client's jobs (required vs preferred level) | `topology.nebius.com/gpu-cluster-id` required |
| Scale | teams and their GPU shares in `overlays/<stage>`; the sum may not exceed `max_gpu_nodes.training` × 8; per-GPU CPU and memory from the nodes' allocatable | half the stage cap per team |
| Region | the R3 cluster's | — |
| Budget | queues divide R3's GPU nodes; borrowing uses idle capacity the client already pays for | — |
| Costs | nothing beyond R3 | — |
| Proved by | `make kustomize` and `make policy` (`policy/kueue.rego`); live, `tests/validate/kueue.sh` ([`runbooks/team-scheduling.md`](../runbooks/team-scheduling.md#validate)): queues `Active`, a job admitted in one GPU cluster, a second team borrowing then reclaimed; `--shares N` runs the drill on fewer free GPUs | — |
