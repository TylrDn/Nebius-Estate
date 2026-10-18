# S1–S9 pricing: billing calculator, capacity advisor and quota names, read-only — 2026-10-11

- Kind: run of this repository (uncommitted working tree, 2026-10-11)
- Date / region / platform / presets: 2026-10-11, calculator runs between 09:09:19Z and 09:12:20Z, one
  project per region (`eu-north1`, `eu-west1`, `eu-west2`); Token Factory model listing at 09:12:58Z;
  quota-name listing in nine projects in nine regions at ~09:05Z. Presets: the `footprint*.json` files
  beside each solution (H100, H200, B300 and L40S 1- and 8-GPU presets, `cpu-d3`, disks, filesystems).
  No resource was created
- Versions: nebius CLI 0.12.285 (host, for the access token); `recipes/finance/price.py` and
  `recipes/token-factory/list-models.sh` as committed with this file; footprints in `solutions/S<n>-<slug>/`
- Method: `nebius iam get-access-token`, then for every footprint
  `python3 recipes/finance/price.py <footprint> --project <a project in its region> --contract --advice --tenant <tenant>`
  (`POST /billing/v1/calculator/estimate-batch` plus the tenant-level capacity advisor);
  `recipes/token-factory/list-models.sh --verbose`;
  `nebius quotas quota-allowance list --parent-id <project>` per project. Commands per solution: section 6
  of each [`solutions/S*/README.md`](../../solutions/README.md#how-the-prices-were-read)
- Cost: none (the calculator prices a would-be create request; the advisor, quota listing and model
  listing are reads)
- Caveats: list and spot prices at one moment, **an estimate, not a quote**; spot can change every 15
  minutes. `--contract` returned the list price on every line because the pricing account has no
  commitment, so no reserved rate was observed. The capacity advisor is a tenant view at that moment,
  not a guarantee. The quota API returned names and usage but no limits. Lines the calculator does not
  price (Managed MLflow, PostgreSQL, Object Storage, Token Factory dedicated endpoints) come from pricing
  pages, not from this run. **Nothing was deployed; no solution has a live run.**

Project, tenant and resource IDs are left out. Figures are copied from section 6 of each solution;
re-price on the day before using one with a customer.

## Calculator totals (USD list, on-demand unless stated)

| Solution | Footprint, region, priced at | Per hour | Total | Preemptible (spot at that moment) |
|---|---|---|---|---|
| [S1](../../solutions/S1-private-llm-serving-vpn/README.md#6-cost-model) | `footprint.json`, `eu-north1`, 09:09:19Z | 12.5032 | 9,127.34 a month | not applicable (prod serving) |
| [S2](../../solutions/S2-fine-tune-70b-two-weeks/README.md#6-cost-model) H200 | `footprint.json`, `eu-north1`, 09:09:54Z | 87.6031 | 29,434.65 per 336 h run | 13.8431/h, 4,651.29 per run (GPU $0.79) |
| S2 B300 | `footprint-b300.json`, `eu-west2`, 09:09:39Z | 153.2032 | 51,476.28 per run | 17.2032/h, 5,780.28 per run (GPU $1.00) |
| [S3](../../solutions/S3-llm-api-token-factory/README.md#6-cost-model) self-host | `footprint.json`, `eu-north1`, 09:10:09Z | 5.5563 | 4,056.10 a month | 0.9463/h, 690.80 a month |
| [S4](../../solutions/S4-burst-training-preemptible/README.md#6-cost-model) | `footprint.json`, `eu-north1`, 09:10:21Z | 145.3996 | 10,468.77 per 72 h burst | 26.6796/h, 1,920.93 per burst (GPU $0.79) |
| [S5](../../solutions/S5-slurm-migration/README.md#6-cost-model) | `footprint.json`, `eu-north1`, 09:10:35Z | 175.2325 | 127,919.73 a month | 27.7125/h, 20,230.13 a month |
| [S6](../../solutions/S6-multi-region-dr/README.md#6-cost-model) primary | `footprint.json`, `eu-north1`, 09:11:13Z | 11.9780 | 8,743.92 a month | not applicable (prod serving) |
| S6 warm standby | `footprint-standby.json`, `eu-west1`, 09:10:58Z | 6.5282 | 4,765.58 a month | not applicable |
| [S7](../../solutions/S7-eu-data-residency/README.md#6-cost-model) | `footprint.json`, `eu-north1`, 09:11:41Z | 5.8982 | 4,305.66 a month | — |
| S7 | `footprint-eu-west2.json`, `eu-west2`, 09:11:28Z | 9.9982 | 7,298.66 a month | — |
| [S8](../../solutions/S8-batch-inference/README.md#6-cost-model) | `footprint.json`, `eu-north1`, 09:12:10Z | 18.1900 | 436.56 per 24 h run | 3.3500/h, 80.40 per run |
| S8 rate card | `footprint-rates.json`, `eu-north1`, 09:11:54Z | per line (below) | — | per line (below) |
| [S9](../../solutions/S9-data-science-notebooks/README.md#6-cost-model) | `footprint.json`, `eu-north1`, 09:12:20Z | — | 55,194.74 a month | — |

Arithmetic derived from these lines (not separate calculator calls): S6 pilot-light standby $787.24 a
month, S6 active/active ≈ $17,487.84 a month, S4 at a $1.50 spot cap $3,556.77 per burst, S7 perimeter
and data plane without the GPU $363.66 a month (`eu-north1`).

## Rate card (S8, 09:11:54Z, per hour, one VM)

| Preset | On-demand | Preemptible |
|---|---|---|
| `gpu-l40s-a 1gpu-8vcpu-32gb` | 1.5484 | 0.7492 |
| `gpu-h100-sxm 1gpu-16vcpu-200gb` | 4.5000 | 0.7900 |
| `gpu-h200-sxm 1gpu-16vcpu-200gb` | 5.4000 | 0.7900 |
| `gpu-h100-sxm 8gpu-128vcpu-1600gb` | 36.0000 | 6.3200 |

Per-GPU list prices in the other footprints: H200 $5.40 (8-GPU in `eu-north1`, 1-GPU in `eu-west1`),
B300 $9.50 (1- and 8-GPU in `eu-west2`); spot B300 8-GPU $1.00 per GPU at 09:09:39Z.

## Capacity advisor (tenant view at pricing time)

| Region, fabric | Preset | On-demand | Preemptible | Reserved |
|---|---|---|---|---|
| `eu-north1` `fabric-7` | H200 1-GPU | HIGH (32 of 32) | HIGH (7 of 8) | LIMIT_REACHED |
| `eu-north1` `fabric-7` | H200 8-GPU | LOW (limit 4) | MEDIUM (2 of 8) | LIMIT_REACHED |
| `eu-west2` | B300 8-GPU | LOW (limit 4) | MEDIUM (3 of 8) | LIMIT_REACHED |
| `eu-west2` | B300 1-GPU | LOW (limit 32) | HIGH (8 of 8) | LIMIT_REACHED |
| `eu-west1` `fabric-5` | H200 1-GPU | MEDIUM (19 of 32) | HIGH (8 of 8) | LIMIT_REACHED |
| `eu-north1` `fabric-2` | H100 8-GPU | LOW (limit 4) | HIGH (7 of 8) | — |
| `eu-north1` `fabric-3` | H100 8-GPU | MEDIUM (1 of 4) | MEDIUM (3 of 8) | — |
| `eu-north1` `fabric-4` | H100 8-GPU | HIGH (4 of 4) | HIGH (7 of 8) | — |
| `eu-north1` `fabric-6` | H100 8-GPU | LOW (limit 4) | MEDIUM (5 of 8) | — |
| `eu-north1`, every fabric | H100 1-GPU | HIGH (32 of 32) | HIGH (7 of 8) | — |
| `eu-north1` | L40S 1-GPU | MEDIUM (8 of 32) | HIGH (7 of 8) | — |

"Reserved LIMIT_REACHED" means the tenant holds no capacity block group, not that capacity is absent.

## Token Factory model listing (09:12:58Z)

`list-models.sh --verbose` returned 25 models with real-time list prices. The S3 worked workload
(300 M input + 60 M output tokens a month) prices at $32.40 to $1,800.00 a month by model; the S8 corpus
lists at $320 on `Qwen/Qwen3-30B-A3B-Instruct-2507` and $216 on `nvidia/Nemotron-3_5-Lightning`.
Per-model selection: [S3 section 4](../../solutions/S3-llm-api-token-factory/README.md).

## Quota names (~09:05Z)

The names per area and region, as the API returned them, are tabulated in
[`solutions/README.md`](../../solutions/README.md#quota-names-observed-live). Limits were absent from
every response ([portal evidence](2026-10-11-portal-live-read-only.md#quotas)); read them in the console.
