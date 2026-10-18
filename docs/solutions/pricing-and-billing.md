# Pricing and billing

How Nebius bills, where current prices live, and the cost levers an SA can pull. All links read
on **2026-10-11**.

> **Caveat.** List prices below are the public pay-as-you-go prices shown on the linked pages on
> 2026-10-11, in USD, excluding taxes. They change (the Compute page lists changes on 2026-10-01
> and 2026-10-08). They are not a quote, do not reserve capacity, and do not reflect commitment
> discounts or contract terms. Before using a number with a customer, re-read the page and the
> console (**Billing → Payments → List prices**), and state the date.

## Billing model

| Topic | Fact | Source |
|---|---|---|
| Models | PAYG (default; individuals and companies) and commitment discounts (companies only); can be combined | [Billing models](https://docs.nebius.com/signup-billing/billing-models/overview) |
| Units | Compute: billing unit 1 s, pricing unit 1 h; volumes: 1 byte per 1 s, priced per GiB per 730 h | [Compute pricing](https://docs.nebius.com/compute/resources/pricing) |
| Stopped VMs | GPUs/vCPU/RAM not charged; disks and filesystems still charged | same |
| Volumes | charged by provisioned size, attached or not | same |
| Managed Kubernetes | nodes and disks at Compute prices; no separate control-plane line on the pricing page | [MK8s pricing](https://docs.nebius.com/kubernetes/resources/pricing) |
| Managed Soperator | nodes and filesystems at Compute prices, buckets at Object Storage prices | [Soperator pricing](https://docs.nebius.com/slurm-soperator/managed-soperator/resources/pricing) |
| Serverless AI | Compute prices while running; stopped endpoint not billed; stopped Devlab bills its container disk | [Serverless pricing](https://docs.nebius.com/serverless/pricing-quotas) |
| Free services | Container Registry, Virtual Networks; Audit Logs, SecretStash, Monitoring, Logging while in preview | [PAYG](https://docs.nebius.com/signup-billing/billing-models/payg) |
| Currency | USD for all customers except companies from Israel (ILS) | [Compute pricing](https://docs.nebius.com/compute/resources/pricing) |
| Card payments | Charged monthly and when the balance reaches a billing threshold; a failed threshold charge can suspend the account | [Threshold](https://docs.nebius.com/signup-billing/payments/threshold) |
| Suspension | Resources and data in a suspended tenant are deleted after 60 days | [Data deletion](https://docs.nebius.com/overview/data-deletion) |

### Spot pricing (preemptible)

Source: [Spot pricing and pricing policies](https://docs.nebius.com/signup-billing/pricing-policy).

| Fact | Detail |
|---|---|
| Since | 2026-10-08 for B300, B200, H200, H100 and RTX PRO 6000; the price table shows the **minimum** spot price ([Compute pricing](https://docs.nebius.com/compute/resources/pricing#price-changes-in-october-2026)) |
| Changes | as often as every 15 min, including while running; charged per interval |
| Ceiling | highest preemptible price is one cent below the current PAYG on-demand rate |
| Pricing policy | per project, per GPU platform, max price per GPU-hour; above max, resources stop; a blocked policy prevents start |
| Follow spot price | no max; not stopped for price, still preemptible for capacity |
| Visibility | current and historical prices under Billing → Pricing → Pricing history; FOCUS export has the effective hourly price |
| Applies to | preemptible VMs, container VMs, MK8s preemptible node groups, Serverless AI on preemptible VMs |
| Terraform | [`billing_v1_pricing_policy`](https://docs.nebius.com/terraform-provider/reference/resources/billing_v1_pricing_policy) resource |

L40S preemptible is still a fixed price on the pricing page.

### Commitment discounts and reservations

| Fact | Source |
|---|---|
| Commit to resource types, amounts and duration (GPUs, vCPU, RAM, disks, filesystems); usage outside the commitment is PAYG | [Commitment discounts](https://docs.nebius.com/signup-billing/billing-models/committed-usage) |
| Generally prepaid, on agreed dates; orders in the console carry the addendum number | same |
| Extending is subject to capacity; shortening/cancelling only as the addendum allows, may incur fees | same |
| Capacity block groups (reservations) come with an addendum for commitment-discount billing | [Capacity block groups](https://docs.nebius.com/overview/limits/capacity-block-groups) |
| Discount levels: docs silent; via sales | [contact sales](https://nebius.com/prices) |

## List prices (USD, PAYG, from 2026-10-08)

Source: [Compute pricing](https://docs.nebius.com/compute/resources/pricing). GPU-platform prices are
per GPU-hour; the page lists separate vCPU and RAM prices only for L40S and non-GPU platforms.
Whether the GPU-hour price includes the preset's vCPU and RAM on B300/B200/H200/H100/RTX PRO 6000
is not stated explicitly; the page shows only a GPU-hour line for them.

| Platform | On-demand per GPU-hour | Preemptible | Before 2026-10-01 on-demand |
|---|---|---|---|
| B300 `gpu-b300-sxm` | $9.50 | spot, from $0.99 | $7.85 |
| B200 `gpu-b200-sxm`, `gpu-b200-sxm-a` | $8.50 | spot, from $0.99 | $7.15 |
| H200 `gpu-h200-sxm` | $5.40 | spot, from $0.79 | $4.50 |
| H100 `gpu-h100-sxm` | $4.50 | spot, from $0.79 | $3.85 |
| RTX PRO 6000 `gpu-rtx6000`, `-a` | $1.80 | spot, from $0.79 | — |
| L40S `gpu-l40s-a`, `-d` | $1.35 GPU + vCPU ($0.012 / $0.01 per vCPU-h) + RAM ($0.0032 per GiB-h) | $0.65 GPU (fixed) | — |
| Non-GPU `cpu-d3` | $0.015 per vCPU-h, $0.0045 per GiB-h RAM | — | $0.012, $0.0032 |
| Non-GPU `cpu-e2` | $0.012 per vCPU-h, $0.0045 per GiB-h RAM | — | $0.012, $0.0032 |

Cross-check through the API: the billing calculator returned **$4.50/h** for `gpu-h100-sxm`
`1gpu-16vcpu-200gb` in `eu-north1` on 2026-10-11 ([evidence](../evidence/2026-10-11-portal-live-read-only.md)), the same as the H100 GPU-hour
line above. That suggests the GPU-hour price covers the 1-GPU preset's vCPU and RAM, for that preset
only. It is the list price observed at that moment, not a quote.

| Storage (per GiB per 730 h) | Price | Source |
|---|---|---|
| Network SSD | $0.071 | [Compute pricing](https://docs.nebius.com/compute/resources/pricing#volumes) |
| Network SSD Non-replicated | $0.053 | same |
| Network SSD IO M3 | $0.118 | same |
| Shared filesystem (SSD) | $0.08 | same |
| Local SSD | $0.065 | same |
| Disk snapshot | $0.071 | same |
| Object Storage Standard | $0.0147; requests A $0.0034 / B $0.00028 per 1000; egress $0.015/GiB | [Object Storage pricing](https://docs.nebius.com/object-storage/resources/pricing) |
| Object Storage Enhanced Throughput | $0.11; requests and egress free | same |
| Object Storage Intelligent | Warm $0.03, Cold $0.01; requests free; egress free up to 3× monthly average stored, then $0.05/GiB | same |
| Same-region Object Storage egress | free | same |

Not found in the docs: a price for VM internet egress or public IPs (Virtual Networks is free),
and a price list for Token Factory (the product page links no pricing page; check the Token
Factory console). Dedicated endpoints are "per GPU/hour, billed with per-minute granularity"
([dedicated endpoints](https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/overview)).

### Worked example

Arithmetic only, using the list prices above on 2026-10-11:

| Run | GPU-hours | On-demand list | Notes |
|---|---|---|---|
| 2 × 8 × H200 for 14 days | 2 × 8 × 24 × 14 = 5,376 | 5,376 × $5.40 = **$29,030** | plus boot disks, filesystem, CPU nodes; a reservation or commitment changes the rate |
| 1 × H200 serving 24/7 for 30 days | 720 | 720 × $5.40 = **$3,888** | an 8-GPU node is 8 × this |
| 4 TiB shared filesystem for 30 days | — | 4096 × $0.08 × (720/730) = **$323** | bandwidth scales with size ([storage-and-data.md](storage-and-data.md#shared-filesystems)) |

Present such numbers as "list-price estimate on <date>", never as a quote. The repository's own
rule is to read prices from the console on the day ([`docs/cost.md`](../cost.md)).

## Controls and reporting

| Control | What it does | What it does not do | Source |
|---|---|---|---|
| Quotas | hard cap per project per region; a quota decrease is the documented way to limit usage | does not plan capacity; reservations bypass GPU quotas; **the API returns usage but no limit** (`spec.limit` omitted, observed 2026-10-11, [gaps](gaps-and-discrepancies.md#docs-silent)), so read limits in the console | [Quotas](https://docs.nebius.com/overview/quotas#view-quotas) |
| Project limits on capacity block groups | cap GPUs a project takes from a reservation | — | [Project limits](https://docs.nebius.com/overview/limits/project-limits) |
| Budgets | email alerts on PAYG spend (daily/monthly/quarterly/yearly), scoped by region, project, service or product | **do not stop or cap usage**; data updates every few hours; no forecast alerts; exclude VAT; PAYG only | [Budgets](https://docs.nebius.com/signup-billing/budgets) |
| Cost allocation labels | filter/group costs by label on Billing → Usage | **Compute billable resources only**; labels on other resources are not in the billing report | [Labels](https://docs.nebius.com/signup-billing/usage/cost-allocation-labels) |
| Usage export | CSV in FOCUS 1.2, hourly detail; one-time or periodic (hourly to a bucket; one active periodic export per contract) | FOCUS gaps: no availability zones, capacity-reservation or sub-account capability; conformance still says **Tags: No**, but `Tags` now carries cost allocation labels for Compute rows ([gaps](gaps-and-discrepancies.md)); commitment purchases not modeled as `Purchase` rows | [Export](https://docs.nebius.com/signup-billing/usage/export), [FOCUS conformance](https://docs.nebius.com/signup-billing/usage/focus-conformance), [fields](https://docs.nebius.com/signup-billing/usage/focus-fields) |
| Pricing policies | cap spot price per platform; per project; Terraform resource `nebius_billing_v1_pricing_policy` at provider 0.6.67 | no availability guarantee | [Pricing policy](https://docs.nebius.com/signup-billing/pricing-policy), [manage](https://docs.nebius.com/signup-billing/manage-pricing-policy) |
| Billing calculator API | `billing/v1alpha1/calculator estimate` exists in the CLI/API reference. On 2026-10-11 `POST /billing/v1/calculator/estimate-batch` with a `CreateInstanceRequest` spec returned list prices to a project `viewer` ([evidence](../evidence/2026-10-11-portal-live-read-only.md)) | alpha; not documented as a guide; contract (discounted) prices need `resource.billinggroup.get` on the billing group (403 otherwise); pricing policies take a project parent (a tenant parent answers 400) | [CLI reference](https://docs.nebius.com/cli/reference/billing/v1alpha1/calculator/estimate) |

The portal's FOCUS cost reporting in this repo reads this export ([`portal/README.md`](../../portal/README.md)).

## Cost levers to discuss

| Lever | Effect | Trade-off | Where |
|---|---|---|---|
| Right GPU for memory need | fewer GPUs per replica | only 1- and 8-GPU presets on most platforms | [compute-and-capacity.md](compute-and-capacity.md#sizing-arithmetic) |
| Quantize (FP8) | halves weight memory vs BF16 | quality must be validated | same |
| Preemptible for interruptible work | spot price below PAYG | 60 s notice, no availability guarantee; not for recorded benchmarks (ADR-0007) | [ADR-0007](../decisions/0007-capacity-on-demand-vs-preemptible.md) |
| Reservation + commitment for steady load | committed rate and guaranteed GPUs | prepaid, hard to shorten | above |
| Delete, don't stop | stopped VMs still bill disks and hold quota | restart needs capacity | [Compute pricing](https://docs.nebius.com/compute/resources/pricing) |
| Autoscale GPU node groups with a CPU node group for system pods | GPU nodes can scale down | cold starts | [autoscaling](https://docs.nebius.com/kubernetes/node-groups/autoscaling) |
| Enhanced Throughput for hot data, Intelligent for cold | free ops/egress vs cheapest at rest | class availability varies by region | [storage classes](https://docs.nebius.com/object-storage/storage-classes) |
| Lifecycle rules (expire non-current versions, abort uploads) | stops paying for invisible data | — | [lifecycles](https://docs.nebius.com/object-storage/objects/lifecycles) |
| Token Factory instead of self-hosting for low/variable volume | per-token billing | region not guaranteed on public endpoints | [platforms.md](platforms.md#token-factory) |
