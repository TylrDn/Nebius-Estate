# Spend of the prior validation runs (2026-10-07/08)

The **billed** figures come from the FOCUS 1.2 periodic export of the contract (Billing → Export →
Periodic export, imported by the portal on 2026-10-11; the console's Usage page shows the same
total). The per-run figures further down are the lab harness's **estimates** (wall-clock minutes ×
list price), kept because they are the only per-run split; they are not what was charged. These are
prior runs of the upstream recipes in `uk-south1`, not runs of this repository, and none of this is a
quote or says anything about the price or availability of capacity today.

## Billed (FOCUS export, project `nbis-labs`, uk-south1)

| Day (UTC) | Billed USD |
|---|---|
| 2026-10-07 | 4.39 |
| 2026-10-08 | 3.81 |
| **Total** | **8.19** |

| Line item | Usage | Billed USD |
|---|---|---|
| Preemptible NVIDIA B300 NVLink | 0.50 GPU-h at $4.30 | 2.17 |
| Non-GPU AMD Epyc Genoa CPU | 162.03 vCPU-h at $0.015 | 2.43 |
| Non-GPU AMD Epyc Genoa RAM | 648.12 GiB-h at $0.0045 | 2.92 |
| Disk (Network SSD) | 4,423.5 GiB-h | 0.43 |
| Shared filesystem | 2,228.5 GiB-h | 0.24 |
| Public IP address | 4.95 IP-h | 0.00 |

The export has an `x_TrialId` column, but every value is `NULL`: no row is marked as drawn from trial
or promo credit.

## Estimated per run (lab harness; not billed figures)

| Run set | Runs | Passed | Minutes | Estimated USD | Summary |
|---|---|---|---|---|---|
| vLLM vs. serverless bench (1×B300) | 2 | 1 | 23.8 | 1.71 | [estimate only](#runs-with-a-cost-estimate-only) |
| MK8s + B300 GPU smoke | 1 | 1 | 30.5 | 2.27 | [`2026-10-08-mk8s-b300-gpu-smoke.md`](2026-10-08-mk8s-b300-gpu-smoke.md) |
| Soperator 4.1.13 (CPU worker) | 7 | 1 | 290.0 | 9.29 | [`2026-10-08-soperator-4.1.13-cpu.md`](2026-10-08-soperator-4.1.13-cpu.md) |
| Shared filesystem fio | 1 | 1 | 3.8 | 0.02 | [estimate only](#runs-with-a-cost-estimate-only) |
| **Total** | **11** | **4** | **348.1** | **13.29** | |

The estimates overstate the bill by about 1.6× on both days. Wall-clock minutes include time
waiting for capacity and provisioning that is not billed; and the bill shows only **0.50 GPU-hours**
of B300 on 2026-10-08, which is the smoke test (02:07–02:38): the bench run's 23.7 minutes produced no
GPU charge, so it most likely never received its GPU. Per-run rows: [`raw/*/runs.md`](raw/README.md).

## Runs with a cost estimate only

Two runs left only their harness rows here. They show that the runs were attempted, and nothing
else: no figure from them may be quoted.

| Run | Date / platform | Cost | What is missing | What this repository measures instead |
|---|---|---|---|---|
| vLLM on one B300 vs. a serverless endpoint ([raw](raw/2026-10-08-serverless-bench/runs.md)) | 2026-10-08 00:58 UTC, 1 × `gpu-b300-sxm` preemptible (an attempt the day before aborted after 0.1 min, $0) | 23.7 min, $1.71 estimated (no GPU charge on the bill) | method, versions and every throughput figure | [`recipes/serverless`](../../recipes/serverless/README.md): the same image digest and model revision on R1 and on an endpoint, `vllm bench serve` at fixed concurrency, TTFT/TPOT/E2E p50/p99, cold start; `compare.py` writes `<date>-serverless-comparison.md` here |
| Shared filesystem fio ([raw](raw/2026-10-07-filestore-fio/runs.md)) | 2026-10-07 16:21 UTC | 3.8 min, $0.02 estimated | VM preset, fio version and the numbers; direct I/O was requested but cache effects were never ruled out | `tests/validate/03-storage.sh`: 1 MiB sequential write, 1 GiB, `--direct=1`, from a GPU node, method recorded with the number |

## Observed unit costs

From the FOCUS export and the billing console, 2026-10-07/08:

| Item | $/h observed | Note |
|---|---|---|
| `gpu-b300-sxm` 1gpu-24vcpu-346gb, preemptible | 4.30 | ≈ 45 % of on-demand that day; spot prices can change every 15 minutes |
| `cpu-d3` 4vcpu-16gb | 0.132 | |
| 52 vCPU + 208 GiB `cpu-d3` (the Soperator run) | 1.716 | |
| 1,280 GiB Network SSD | 0.125 | |
| 448 GiB shared filesystems | 0.049 | |
| Managed Kubernetes control plane | 0 | not billed; only nodes are |

## Cost per output token (a method, not a result)

`$ per 1M output tokens = ($/h of the node) / (tokens/s × 3600 × utilisation) × 1e6`. At $4.30/h and a
*hypothetical* 1,000 tokens/s at 100 % utilisation that is $1.19 per 1M output tokens; the real throughput
for this repository's model and image is what [`recipes/serverless`](../../recipes/serverless/README.md)
measures.
