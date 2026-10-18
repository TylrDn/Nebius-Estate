# Cost

How spend is estimated, capped, attributed and checked for every recipe. This repository never
quotes a price without its date, region, preset and source: prices are read from the console or the
calculator for the exact presets and region on the day and recorded with the date, and no estimate
here guarantees capacity, a price or commercial terms.
Observed, billed figures from prior runs are in [`docs/evidence/costs.md`](evidence/costs.md).

## Billing model

| Item | How it is billed | Source |
|---|---|---|
| Managed Kubernetes control plane | not billed; only nodes are | [MK8s pricing](https://docs.nebius.com/kubernetes/resources/pricing) |
| Nodes (CPU, GPU, RAM, boot disks) | Compute pricing; billing unit 1 s, pricing unit 1 h | [Compute pricing](https://docs.nebius.com/compute/resources/pricing) |
| Preemptible GPU | spot price; can change as often as every 15 minutes, including during use | [Pricing policy](https://docs.nebius.com/signup-billing/pricing-policy) |
| Shared filesystem, Object Storage | per GiB-hour of provisioned size | Compute / Object Storage pricing |
| Serverless endpoint / job | per second while the endpoint exists / until the job ends | `recipes/serverless/` |

Standalone GPU VM prices are not a Managed Kubernetes quote; the node is billed as a VM.

## Cost shape per recipe

Resource shape of each recipe in its sandbox sizing (`terraform/live/sandbox/<stack>/sandbox.auto.tfvars`)
and the observed rate where a prior run measured one. Multiply by hours the resources **exist**,
not hours they are busy.

| Recipe | Billable while it exists (sandbox) | Observed rate (2026-10-07/08, `uk-south1`) |
|---|---|---|
| R1 inference (`stacks/inference`) | 2 × `cpu-d3 8vcpu-32gb`; 1 × `gpu-h100-sxm 1gpu-16vcpu-200gb` (preemptible); 793 GiB Network SSD; 64 GiB shared filesystem | no H100 rate observed; a preemptible B300 1-GPU node was ≈ $4.30/h. **What ran on 2026-10-11** (`eu-north1`, run override, [`runbooks/deploy.md`](../runbooks/deploy.md)): 0 CPU nodes and 1 × `gpu-l40s-a 1gpu-8vcpu-32gb` preemptible at $0.7492/h list (0.65 GPU + 8 × 0.006 vCPU + 32 × 0.0016 GiB, `.cache/nebius-docs/compute/resources/pricing.md:267-269`), ≈ $0.78/h with disk and filesystem by the live calculator ([evidence](evidence/2026-10-11-sandbox-inference-populate.md)); estimate, not a billed figure |
| R3 training (`stacks/training`) | 2 × `cpu-d3 8vcpu-32gb`, 281 GiB SSD, 256 GiB filesystem while `gpu_node_count = 0`; after approval + 2 × 8-GPU nodes = **16 GPU-hours per wall-hour**, 2 × 1,023 GiB boot | none for 8-GPU nodes |
| R4 Soperator (`stacks/soperator`, lab profile) | 52 vCPU `cpu-d3`, 1,280 GiB Network SSD, ~280 GiB IO_M3, 448 GiB shared filesystems; no GPU | ≈ $1.89/h (1.716 compute + 0.125 SSD + 0.049 filesystems); the passing run was estimated at $1.39 for 43 min by the lab harness (not billed; the harness estimates run about 1.6× the bill, [`evidence/costs.md`](evidence/costs.md#estimated-per-run-lab-harness-not-billed-figures)) |
| R5 team namespaces (`recipes/team-platform`) | nothing beyond R1; a task uses the R1 GPU | — |
| R6 serverless (`recipes/serverless`) | the endpoint preset per second while it exists; the job until it ends | not recorded in this repository |
| R7 network (`stacks/network`) | NAT VM `cpu-d3 4vcpu-16gb` with a 50 GiB Network SSD boot disk and one public IP; staging and prod add the WireGuard bastion (same shape, one more public IP) | none |
| R8 data (`stacks/data`) | 256 GiB shared filesystem (staging 512, prod 2,048); two buckets billed by stored GiB, the checkpoint bucket including non-current versions until they expire; an optional transfer | none |
| R9 finance and governance (`recipes/finance`, `stacks/governance`) | nothing billable: pricing policies, project limits and budgets carry no price; the periodic FOCUS export bills its bucket at Object Storage prices ([export types](https://docs.nebius.com/signup-billing/usage/export#export-types)) | — (prices every other recipe: `price.py`) |
| R10 GPU VM (`stacks/gpu-vm`) | 1 × `gpu-h100-sxm 1gpu-16vcpu-200gb` (eu-north1 default; `gpu-l40s-a 1gpu-8vcpu-32gb` is the cheapest there), 200 GiB Network SSD boot disk billed running or stopped; needs R7's NAT VM for egress | calculator, eu-north1, 2026-10-11, list price: H100 preset 4.5 USD/h, L40S preset 1.5484 USD/h ([recipe](../terraform/stacks/gpu-vm/README.md#quotas-and-cost)) |
| R11 Token Factory (`recipes/token-factory`) | no AI Cloud resource. Public endpoints per token (prices per model from `list-models.sh --verbose`); dedicated endpoints per GPU-hour while a replica is ready; a separate Token Factory billing account and balance | `smoke.py` used 31 tokens on 2026-10-11, a fraction of a cent ([evidence](evidence/2026-10-11-token-factory-smoke.md); the API's price fields carry no unit) ([recipe](../recipes/token-factory/README.md#cost-model)) |
| R12 ML services (`stacks/ml-services`) | registry free; with MLflow one `medium` cluster (8 vCPU, 32 GiB, 200 GiB SSD) for its whole life; with PostgreSQL one `2vcpu-8gb` host and 96 GiB SSD; MLflow's artifact bucket until deleted | pricing pages read 2026-10-11, not the calculator: MLflow $0.48/h + disk, PostgreSQL $0.14/h a host + $0.071 per GiB per 730 h ([recipe](../terraform/stacks/ml-services/README.md#quotas-and-cost)) |
| R13 CI federation (`modules/foundation/ci-federation`) | nothing billable: IAM objects only | — |
| R14 observability (`recipes/observability`) | nothing billable: Monitoring, Logging and Tracing are in preview and free of charge ([pricing](https://docs.nebius.com/observability/resources/pricing)); a log export is stored at Object Storage prices; the in-cluster Prometheus disk is R1/R3's (`modules/o11y`) | — |
| R15 NVL72 (`stacks/nvl`) | per rack 18 × `gpu-gb300 4gpu-112vcpu-800gb` (72 GPUs; preset and rack shape from the upstream recipe, not in the cached docs) on a reservation, billed at the commitment addendum's rate for the whole term ([billing for reservations](https://docs.nebius.com/compute/virtual-machines/reservations#billing-for-reservations)); 18 × 1,024 GiB Network SSD boot disks ≈ 1.8 USD/h at $0.071 per GiB per 730 h | none: GB300 has no list price on the pricing page and the calculator was not run (mocked-only recipe) ([recipe](../terraform/stacks/nvl/README.md#quotas-and-cost)) |
| R16 team scheduling (`workloads/kueue`) | nothing beyond R3: the queues divide R3's GPU nodes, which bill while they exist; the sample job holds two 8-GPU nodes for about a minute | — |

Quota arithmetic behind the shapes: [`docs/capacity.md`](capacity.md#quotas-per-stack). Cost per
output token is a formula, not a figure: [`docs/evidence/costs.md`](evidence/costs.md).

## Estimate worksheet

Fill one per run (sandbox) or per month (staging, prod) and attach it to the spend approval.

| Input | Value | Source |
|---|---|---|
| Region | `eu-north1` (stack default) | `terraform/stacks/<stack>/variables.tf` |
| CPU preset × count | `cpu-d3 8vcpu-32gb`: 2 (sandbox, staging), 3 (prod), both stacks | `terraform/live/<stage>/<stack>/<stage>.auto.tfvars` |
| GPU preset × count | inference `1gpu-16vcpu-200gb` × 1 / 1 / 2; training `8gpu-128vcpu-1600gb` × 0 in every stage until approved | same, presets from `platform/regions.yaml` |
| Shared filesystem | inference 64 / 256 / 1,024 GiB; training 256 / 1,024 / 4,096 GiB (sandbox / staging / prod) | `filestore_size_gib` |
| Capacity type | on-demand, reserved (`gpu_reservation`) or preemptible (sandbox serving only) | [`docs/capacity.md`](capacity.md) |
| Hours the resources exist | include model download, warm-up and teardown | |
| Disks, Object Storage, public IPs, egress, tax | | console |
| Run time limit (`nip-ttl-expires`) | | set before `make plan` |
| Approved budget | | recorded in the ticket |

## Spend controls

Budgets *notify*, quotas *stop*, labels *attribute*. Each control is independent of the others,
and each answers a failure seen in prior runs ([`docs/evidence/`](evidence/README.md)): a
hand-interrupted apply orphaned ~30 resources, and a CSI disk outlived its cluster.

| # | Control | Mechanism | Where | Effect |
|---|---|---|---|---|
| 1 | Isolated project per stage, quotas sized to the stack | an apply that exceeds a quota fails instead of spending | [ADR-0009](decisions/0009-environment-and-promotion-model.md), [`docs/capacity.md`](capacity.md#quotas-per-stack) | **hard stop**, the only real cap |
| 2 | GPU node cap per stage and stack | `max_gpu_nodes` → `terraform_data.stage_policy` precondition; `conftest` caps training at 32 | [`platform/stages.yaml`](../platform/stages.yaml), `policy/` | plan-time stop |
| 3 | Smallest default footprint | training roots plan `gpu_node_count = 0`; inference roots plan 1 (sandbox, staging) or 2 (prod); Soperator one CPU worker; no bastion in the sandbox network | live tfvars, `profiles/lab.tfvars` | stop until a reviewed change |
| 4 | Written spend approval | no `apply` or `destroy` without it | [`CONTRIBUTING.md`](../CONTRIBUTING.md) ("Nothing billable without approval") | process |
| 5 | Saved-plan gate | `make plan` → review → `make apply CONFIRM=yes`; `scripts/tf-run.sh` refuses plans older than 10 h and re-checks the login; in the pipeline the apply re-plans and refuses on a digest mismatch | `Makefile`, `scripts/tf-run.sh`, [change management](change-management.md#the-path) | stop |
| 6 | Preemptible serving only where the stage allows it | `allow_preemptible_serving` precondition | `platform/stages.yaml` | cheaper, not capped |
| 7 | Run and TTL labels | label validation in the stacks (below) | `terraform/stacks/*/variables.tf` | detection |
| 8 | Destroy, then residue check | `make destroy CONFIRM=yes` (refused for prod), then `make leftovers STAGE=<stage> STACK=<stack>` (report), and `make leftovers-stage` when the whole stage is retired | [`runbooks/teardown.md`](../runbooks/teardown.md) | detection |
| 9 | Budget alert per project | console; a **Project** condition per stage; sandbox at 1 × the approved run budget, staging monthly run-rate, prod monthly run-rate + 20 %; alerts to a tenant contact | Nebius console ([budgets](https://docs.nebius.com/signup-billing/budgets#how-to-create-a-budget)) | **notifies only**; data lags by hours; tracks pay-as-you-go spend only (not commitments), excluding VAT |
| 10 | Reservation for training | STRICT in prod whenever training GPU nodes > 0 | [`docs/capacity.md`](capacity.md) | commits spend; prevents surprise on-demand |
| 11 | Ledger | spend per run in `docs/evidence/<date>-<stage>-<stack>-<what>.md` | [`docs/evidence/`](evidence/README.md) | after the fact |
| 12 | Spot price cap | a pricing policy per GPU platform: preemptible VMs pay the spot price and stop when it rises above the cap | R9 [`stacks/governance`](../terraform/stacks/governance/README.md) `spot_price_caps` → R1/R3 `gpu_spot_pricing_policy_id` ([pricing policies](https://docs.nebius.com/signup-billing/pricing-policy#pricing-policies)) | **cap** on the preemptible rate |
| 13 | Project limit on a capacity block group | `limit = 0` keeps sandbox and staging off prod's reserved GPUs | R9 `stacks/governance` `capacity_limits` ([project limits](https://docs.nebius.com/overview/limits/project-limits#how-project-limits-work)) | hard stop on reserved capacity |

Per-stage values (caps, TTL requirement, preemptible, deletion protection) are in one place:
[`platform/README.md` → Stage policy](../platform/README.md#stage-policy), generated from
`platform/stages.yaml`.

## Required labels

| Label | Set by | Required | Format |
|---|---|---|---|
| `nip-stack` | added by the stack | always | stack name: `inference`, `training`, `network`, `data`, `gpu-vm`, `ml-services`, `governance`, `nvl` |
| `nip-env` | stage tfvars; the stack fills it with the stack name when absent | yes, **deprecated**: kept for one release so tooling that reads it keeps working; read `nip-stack` first | stack name (despite the key, not the stage) |
| `nip-owner` | stage tfvars | yes (stack default) | team |
| `nip-run` | `TF_VAR_labels` (sandbox) or tfvars (staging, prod: the stage name) | **every stage**; the plan fails without it | a ticket, date or run id |
| `nip-ttl-expires` | `TF_VAR_labels` at plan time | where `require_ttl_label` is true (sandbox) | RFC 3339 UTC, e.g. `2026-10-31T18:00:00Z`, ending inside the approved run; the stage policy refuses a time already past or more than 7 days after the plan (`modules/stage-policy`, measured with `plantimestamp()`), so an apply that re-plans after the expiry is refused too; a destroy is not ([teardown](../runbooks/teardown.md#an-expired-ttl-does-not-block-teardown)) |
| `nip-region`, `nip-stage` | added by the stack | always | region, stage |
| `nip-layer` | the foundation root | optional; foundation objects only | `foundation` (separates foundation from stack spend) |
| `nip-purpose` | the network stack (R7), the GPU VM (R10) | optional; security groups only | `workload`, `nat`, `bastion`; `gpu-vm-access` |
| `nip-ci-job` | the CI federation module (R13) | optional; federated credentials only (IAM, never billed) | `apply`, `plan` |

Cost reports group by `nip-stage`, `nip-stack` and `nip-run` (`nip-run` only on directly created VMs, disks and filesystems: Managed Kubernetes node spend is split by `nip-stack` plus the run's time window, see below); `scripts/leftovers.sh` filters by
the same labels (`--stack` reads `nip-stack`, then `nip-env` on older resources) and, with
`--stage`, lists unlabelled resources in the stage's project too.

Nebius turns these labels into **cost allocation labels** (Billing → Usage, filter or group by
label; the `Tags` column of the usage export), but only for Compute billable resources: VMs,
disks, shared filesystems. Object Storage and other services are not labelled in billing
([cost allocation labels](https://docs.nebius.com/signup-billing/usage/cost-allocation-labels)).
Managed Kubernetes nodes are VMs created by the node group: the group's own `labels` are not
documented to reach them, while `template.instance_metadata.labels` is ("propagated into Compute
Instance metadata", provider 0.6.67). The inference and training stacks copy the `nip-*` set there
when `propagate_cost_labels = true`, the default for new clusters, so GPU node spend splits by
label in Billing. The per-run `nip-run` and `nip-ttl-expires` are left out of that copy (they stay
on the node group): they change every sandbox run and would otherwise recreate every node. Changing
the flag on an existing cluster, or changing any other label while it is true, still recreates every
node. Check one node VM (`nebius compute instance get <id>`)
before relying on label totals for node cost.

## What is not automated

| Gap | Why | What to do instead |
|---|---|---|
| Budgets | no Nebius provider resource for budgets at provider 0.6.67 | set one per project in the console; record the figure in `docs/evidence/` |
| Expiry enforcement (no reaper) | a job that can delete by label is itself a blast radius and needs delete rights outside the cluster it reaps | `make leftovers STAGE=<stage>` weekly ([`runbooks/maintenance.md`](../runbooks/maintenance.md)); a person deletes what is past its TTL |
| Labels on CSI-created disks | `pvc-*` disks are created by Kubernetes, not Terraform | listed separately by `scripts/leftovers.sh`; delete PVCs before destroy |
| Prices | spot prices move; list prices change | read from the console on the day; record with the date |
| Spot price cap | R9 governance creates one `nebius_billing_v1_pricing_policy` per entry of `spot_price_caps` (`terraform/stacks/governance/main.tf:19`) and outputs `pricing_policy_ids` (`outputs.tf:6`); passing the id to R1/R3 as `gpu_spot_pricing_policy_id` is still a manual step | apply governance before a preemptible plan, or create the policy in the console ([pricing policies](https://docs.nebius.com/signup-billing/manage-pricing-policy#how-to-create-a-pricing-policy)) |
