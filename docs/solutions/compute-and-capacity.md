# Compute and capacity

GPU platforms, presets, interconnect, capacity options and quotas, then sizing arithmetic. All
links read on **2026-10-11**. Prices are in [pricing-and-billing.md](pricing-and-billing.md).

## GPU platforms

Source: [VM types and GPUs](https://docs.nebius.com/compute/virtual-machines/types).

| GPU | Platform ID | Arch | GPU memory | Mem. bandwidth | InfiniBand (per the types page) | Host NIC | Presets (GPUs / vCPU / RAM GiB) |
|---|---|---|---|---|---|---|---|
| B300 | `gpu-b300-sxm` | Blackwell Ultra, SXM | 288 GB HBM3e | 10 TB/s | 800 Gbps (8× ConnectX-8) | BlueField-3 400 Gbps | 1/24/346, **8/192/2768** |
| B200 | `gpu-b200-sxm` (us-central1), `gpu-b200-sxm-a` (me-west1) | Blackwell, SXM | 180 GB HBM3e | 8 TB/s | 400 Gbps (8× ConnectX-7) | BlueField-3 400 Gbps | 1/20/224, **8/160/1792** |
| H200 | `gpu-h200-sxm` | Hopper, SXM | 141 GB HBM3e | 4.8 TB/s | 400 Gbps (8× ConnectX-7) | BlueField-3 200 Gbps | 1/16/200, **8/128/1600** |
| H100 | `gpu-h100-sxm` | Hopper, SXM | 80 GB HBM3 | 3.35 TB/s | 400 Gbps (8× ConnectX-7) | ConnectX-6 100 Gbps | 1/16/200, **8/128/1600** |
| RTX PRO 6000 Server | `gpu-rtx6000` (us-central1), `gpu-rtx6000-a` (uk-south2, eu-south1) | Blackwell, PCIe Gen5 | 96 GB GDDR7 | 1.6 TB/s | — | BlueField-3 400 Gbps | 1/24/218, 8/192/1744 |
| L40S | `gpu-l40s-a` (Intel), `gpu-l40s-d` (AMD) | Ada Lovelace, PCIe | 48 GB GDDR6 | 864 GB/s | — | — | `-a`: 1 GPU with 8–40 vCPU; `-d`: 1, 2 or 4 GPUs (up to 4/192/1152) |

**Bold** = the only presets accepted in a GPU cluster (InfiniBand). RTX PRO 6000 and L40S cannot
join a GPU cluster ([presets compatible with GPU clusters](https://docs.nebius.com/compute/virtual-machines/types#presets-compatible-with-gpu-clusters)).

Sizing consequence: on B300, B200, H200, H100 and RTX PRO 6000 there are **only 1-GPU and 8-GPU
presets**. A model that needs 2 or 4 GPUs of tensor parallelism on those platforms runs on an
8-GPU VM (and is billed for 8) or is sharded differently. Only `gpu-l40s-d` offers 2- and 4-GPU
presets. All GPU platforms support preemptible VMs ([VM types](https://docs.nebius.com/compute/virtual-machines/types#compatibility-with-vm-types)).

Rack-scale systems (GB200/GB300 NVL72): not on the types page; see
[regions.md](regions.md#gpu-platforms-per-region) for what the official sources do say.

## InfiniBand GPU clusters

Source: [InfiniBand networking](https://docs.nebius.com/compute/clusters/gpu),
[topology](https://docs.nebius.com/compute/clusters/gpu/topology),
[MK8s InfiniBand](https://docs.nebius.com/kubernetes/gpu/clusters),
[topology-aware scheduling](https://docs.nebius.com/kubernetes/gpu/topology-aware-scheduling).

| Fact | Detail |
|---|---|
| Unit | A *GPU cluster* is created in one InfiniBand *fabric*; one fabric accepts one GPU platform |
| Bandwidth | Clusters page: each GPU's NIC provides 400 Gbps, 3.2 Tbps per 8-GPU node; GPUDirect RDMA. (The types page lists B300 at 800 Gbps with ConnectX-8; see [gaps](gaps-and-discrepancies.md).) |
| Isolation | Each GPU cluster gets a unique InfiniBand partition key (P-Key); clusters on the same fabric cannot talk over IB |
| Project scope | All VMs in a GPU cluster must be in the GPU cluster's project; for MK8s the GPU cluster must be in the node group's cluster's project |
| When to change fabric | Docs: keep the preselected fabric unless another suits the platform better or you hit capacity issues |
| Topology | Three layers (fabric root, POD core, scalable-unit leaf); communication across higher layers costs more; topology-aware NCCL all-reduce showed "up to 20%" gains in Nebius tests |
| MK8s labels | `topology.nebius.com/gpu-cluster-id`, `tier-0` (e.g. multi-node NVLink), `tier-1`, `tier-2`; use them for Kueue/Volcano/TAS placement |
| Quota | 5 GPU clusters per region by default (0 in `eu-north2`) ([Compute quotas](https://docs.nebius.com/compute/resources/quotas-limits#infiniband)) |
| Validation | `ibstatus` (`LinkUp`, 400 Gb/sec 4X NDR) and perftest ([test a GPU cluster](https://docs.nebius.com/compute/clusters/gpu/test)); NCCL all-reduce ([Soperator NCCL](https://docs.nebius.com/slurm-soperator/jobs/examples/nccl-all-reduce), [MK8s NCCL](https://docs.nebius.com/kubernetes/gpu/nccl-test)) |
| Example result (not a guarantee) | 8 VMs × 8 H200: peak `busbw` ≈ 379 GB/s at 8 GiB messages ([Soperator NCCL example output](https://docs.nebius.com/slurm-soperator/jobs/examples/nccl-all-reduce#example-output)) |

Fabrics per region: [regions.md](regions.md#gpu-platforms-per-region). In this repository R3 picks
the fabric from `platform/regions.yaml` and refuses an 8-GPU-only setting with a 1-GPU preset
(`terraform/stacks/training/main.tf`).

## Capacity options

| Option | How it works | Guarantees | Interruption | How to get it | Source |
|---|---|---|---|---|---|
| On-demand (PAYG, regular VM) | Taken from the common pool at create/start | None: "Not enough resources" possible at create **and at restart of a stopped VM** | Maintenance stops (reschedulable up to 2× by 7 days) | Quota only | [Not enough resources](https://docs.nebius.com/compute/virtual-machines/not-enough-resources), [maintenance](https://docs.nebius.com/compute/virtual-machines/maintenance) |
| Preemptible | Spot price per GPU-hour, updated as often as every 15 min; optional pricing policy (max price) or "follow spot price" | None ("spot pricing doesn't guarantee resource availability") | `SIGTERM` 60 s before stop; stopped (not deleted); volumes kept, dynamic public IP lost; only `recovery_policy = FAIL`; type cannot be changed after create | Preemptible GPU VM quota (8 per region by default) | [Preemptible VMs](https://docs.nebius.com/compute/virtual-machines/preemptible), [spot pricing](https://docs.nebius.com/signup-billing/pricing-policy) |
| Capacity block group (reservation) | N GPUs of one platform on one fabric, as dated *intervals* (start 00:00 UTC, end 23:59 UTC) | GPUs remain available even if the VM is stopped; not counted against GPU quota | If an interval expires while a VM runs, the VM continues as PAYG | Request through a Nebius manager (or support to be connected); comes with a commitment-discount addendum | [Capacity block groups](https://docs.nebius.com/overview/limits/capacity-block-groups), [VM reservations](https://docs.nebius.com/compute/virtual-machines/reservations), [MK8s reservations](https://docs.nebius.com/kubernetes/node-groups/reservations) |
| Commitment discounts | Discount for committing to resource types, amounts and duration (GPUs/vCPU/RAM, disks, filesystems); generally prepaid | Billing construct; extension "subject to the available capacity" | n/a | Company accounts only, via sales | [Commitment discounts](https://docs.nebius.com/signup-billing/billing-models/committed-usage) |
| Pro Solution for Soperator | Expert-run Slurm deployment; contracts "with reserved capacity and discounted pricing" | Per contract | Per contract | Sales | [Deploy Soperator](https://docs.nebius.com/slurm-soperator/deploy/overview#pro-solution-for-soperator) |

Reservation policy on a VM or node group ([VM reservations](https://docs.nebius.com/compute/virtual-machines/reservations)):

| `policy` | `reservation_ids` | Behaviour |
|---|---|---|
| `AUTO` (default) | none / listed | Use any matching (or the listed) reservation; fall back to the common pool |
| `STRICT` | none / listed | Use only reservations; create/update **fails** if none fits |
| `FORBID` | none | Common pool only (listing IDs is a validation error) |

Not supported with reservations: preemptible VMs and non-GPU VMs. Changing an existing VM's
reservation requires stopping it. List order of IDs is the consumption order.

Project limits cap how many GPUs of a capacity block group each project may consume; `0`
disables use; lowering below usage does not stop running VMs but they may not restart
([project limits](https://docs.nebius.com/overview/limits/project-limits)). This is the
mechanism behind R5-style "teams share one reservation".

Ephemeral nodes (Soperator ≥ 3.0, enabled by Nebius) move reserved GPUs between a Soperator
training cluster and an MK8s inference node group on the same capacity block group with
`scontrol power up|down` ([ephemeral nodes](https://docs.nebius.com/slurm-soperator/capacity/ephemeral-nodes)).

### Capacity advisor

Administration → Capacity dashboard, or CLI; per platform, preset, region, fabric and VM type it
shows how many VMs you can launch and how likely that is. Covers Compute VMs, MK8s nodes,
Managed Soperator nodes and Serverless AI VMs; not standalone applications or non-GPU VMs; **not
in the Terraform provider**; data is as of a timestamp and "doesn't guarantee availability"
([capacity advisor](https://docs.nebius.com/compute/virtual-machines/capacity-advisor)).

## Quotas

| Fact | Source |
|---|---|
| Per region, configurable per project; view under Administration → Limits → Quotas; only `admin` can change; requests tracked in the support center | [Quotas](https://docs.nebius.com/overview/quotas) |
| A VM counts against quota from create to delete, running or stopped; delete (not stop) to free quota | [Compute quotas](https://docs.nebius.com/compute/resources/quotas-limits) |
| MK8s and Managed Soperator nodes use Compute quotas; Managed Soperator nodes count against non-GPU vCPU quota but not GPU-VM counts (they require reservations) | [MK8s quotas](https://docs.nebius.com/kubernetes/resources/quotas-limits), [Soperator quotas](https://docs.nebius.com/slurm-soperator/managed-soperator/resources/quotas) |
| Serverless AI has no own quotas: Compute quotas apply; SSH key or static IP consumes a public-IP quota | [Serverless pricing and quotas](https://docs.nebius.com/serverless/pricing-quotas) |
| Max MK8s nodes is bounded by the allocations quota (default 1000): about 498 nodes private-only without HA, about 331 with public IPs and HA | [MK8s constraints](https://docs.nebius.com/kubernetes/resources/quotas-limits#nodes) |
| Automatic quota reduction after prolonged low usage (email, ~2-day grace, not below defaults) | [Quotas](https://docs.nebius.com/overview/quotas#automatic-quota-reduction) |

Default values per region: [regions.md](regions.md#default-quotas-that-change-the-first-day-plan).
Per-stack quota arithmetic for this repo: [`docs/capacity.md`](../capacity.md#quotas-per-stack);
procedure: [`runbooks/capacity-request.md`](../../runbooks/capacity-request.md).

## Sizing arithmetic

General arithmetic, not Nebius claims. Inputs from the model card; GPU memory from the table
above (GB as published by Nebius). Leave headroom for activations, CUDA context and fragmentation;
inference engines reserve a configurable fraction of GPU memory (vLLM `--gpu-memory-utilization`).

### Serving: weights

`weights_GB ≈ parameters (billions) × bytes per parameter` (BF16/FP16 = 2, FP8 = 1, 4-bit ≈ 0.5).

| Model | BF16 weights | FP8 weights | Smallest fit by memory (weights only), before KV cache |
|---|---|---|---|
| 7B | 7 × 2 = **14 GB** | 7 GB | 1 × L40S (48 GB) or any larger GPU |
| 70B | 70 × 2 = **140 GB** | 70 GB | BF16: 1 × B300 (288) or 1 × B200 (180); 2 × H100 = 160 GB leaves ~20 GB, too tight → 8-GPU preset. FP8: 1 × H200 (141 GB) leaves ~70 GB for KV; 1 × H100 (80 GB) leaves ~10 GB, too tight |
| 405B | 405 × 2 = **810 GB** | 405 GB | BF16: 8 × H200 = 1128 GB, 8 × B200 = 1440, 8 × B300 = 2304; 8 × H100 = 640 GB does not fit → 2 nodes. FP8: 8 × H100 (640) |

### Serving: KV cache

`KV bytes per token = 2 × layers × kv_heads × head_dim × bytes_per_element`

Example with an assumed GQA config of 80 layers, 8 KV heads, head dim 128, BF16 (check the
model's `config.json`): 2 × 80 × 8 × 128 × 2 = 327,680 B ≈ **0.31 MiB per token**. 64 concurrent
sequences × 8,192 tokens = 524,288 tokens × 0.3125 MiB ≈ **160 GiB of KV cache**. With 140 GB of
BF16 weights that is ~300 GB: one B300 (288 GB) is short and there is no 2-GPU preset, so BF16
means an 8-GPU VM (e.g. 8 × H200, 1128 GB); FP8 weights (70 GB) + 160 GiB KV ≈ 240 GB fits one
B300 (288 GB) with little headroom. Re-run with real concurrency and context, then confirm with a load test (R1
`make validate-cluster WITH_LOAD=1`).

### Training: memory per parameter

Full fine-tune with mixed-precision Adam is commonly estimated at ~16 bytes/parameter before
activations (2 weights + 2 gradients + 12 FP32 master weights and two moments), sharded across
GPUs with ZeRO-3/FSDP.

| Model | 16 B/param | 8 × H100 (640 GB) | 16 × H100 (1280 GB) | 8 × H200 (1128 GB) | 16 × H200 (2256 GB) | 8 × B300 (2304 GB) |
|---|---|---|---|---|---|---|
| 7B | 112 GB | fits | fits | fits | fits | fits |
| 70B | 1120 GB | no | marginal (activations) | no | fits | fits |

LoRA/QLoRA on a frozen base needs roughly the inference weights plus adapters and optimizer
state for the adapters only; a 70B LoRA run commonly fits one 8-GPU node.

### Training: run shape and GPU-hours

`GPU-hours = nodes × 8 × wall-clock hours`. Example: 2 × 8-GPU nodes for 14 days =
2 × 8 × 24 × 14 = **5,376 GPU-hours**. Quota check against defaults: `eu-north1` allows 32 H200
GPUs and 12 regular GPU VMs without reservation, so 2 nodes (16 GPUs) fit; `us-central1` H200
default is 0 and needs a request ([Compute quotas](https://docs.nebius.com/compute/resources/quotas-limits)).
Converting GPU-hours to money: [pricing-and-billing.md](pricing-and-billing.md#worked-example).

Throughput assumptions (tokens/s per GPU, MFU) are not published by Nebius for these platforms;
measure them (R3 NCCL + DDP smoke test) before quoting a duration.
