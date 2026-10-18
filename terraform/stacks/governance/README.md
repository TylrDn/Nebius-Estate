# `stacks/governance` — Spend and capacity controls per stage project (R9)

**Purpose.** The part of [R9 finance and governance](../../../recipes/finance/README.md) that
the Nebius provider can hold: spot price caps, project limits on capacity block groups, and
read-only quota usage, one root per stage project. Budgets and the periodic FOCUS export have no
provider resource at 0.6.67 and stay console steps in the recipe.

**Used by.** [S2](../../../solutions/S2-fine-tune-70b-two-weeks/README.md) 70B fine-tune (project limits), [S4](../../../solutions/S4-burst-training-preemptible/README.md) burst training on preemptible (spot price cap) ([all solutions](../../../solutions/README.md)).

A capacity block group (CBG) reserves a number of GPUs of one platform in one region, created by a
Nebius manager (`.cache/nebius-docs/overview/limits/capacity-block-groups.md:7-9`); every project in the
tenant may use it up to its size unless a project limit caps that project's share
(`overview/limits/project-limits.md:7`).

## What it builds

| Resource | Notes |
|---|---|
| `nebius_billing_v1_pricing_policy` per entry of `spot_price_caps` | `<name>-<stage>-spot-<platform>`; max price per GPU-hour; a cap below the current spot price is accepted but blocks scheduling ([resource](https://docs.nebius.com/terraform-provider/reference/resources/billing_v1_pricing_policy#nested-schema-for-pricingmax_price_v1)) |
| `nebius_capacity_v1_capacity_allowance` per entry of `capacity_limits` | `<name>-<stage>-cbg-<key>`; GPUs this project may take from one capacity block group; `0` disables CBG use ([project limits](https://docs.nebius.com/overview/limits/project-limits#how-project-limits-work)) |
| `data.nebius_quotas_v1_quota_allowance` per `quota_watch` name | read only, by name and region ([data source](https://docs.nebius.com/terraform-provider/reference/data-sources/quotas_v1_quota_allowance#nested-schema-for-by_name_in_region)) |

Every resource carries the `nip-*` labels with `nip-stage` and `nip-region` added. These labels
do not reach billing: cost allocation labels exist only for Compute billable resources
([labels](https://docs.nebius.com/signup-billing/usage/cost-allocation-labels)). With the defaults
(empty maps) the root plans nothing.

## Inputs that matter

| Variable | Default | Meaning |
|---|---|---|
| `parent_id` | — | the stage project; pricing policies and project limits are project-level |
| `region` | `eu-north1` | the project's region; capped platforms must be listed for it in `platform/regions.yaml` |
| `spot_price_caps` | `{}` | `{ "gpu-h100-sxm" = "2.500" }`: decimal string, at most 3 decimals; only platforms marked `spot_price_cap: true` for the region in `platform/regions.yaml` (H100, H200; the API refuses L40S, live run 2026-10-11) |
| `capacity_limits` | `{}` | `{ <key> = { capacity_block_group_id, limit } }`; `limit` is required (the provider reads an omitted limit as unlimited, [resource](https://docs.nebius.com/terraform-provider/reference/resources/capacity_v1_capacity_allowance#optional)), whole GPUs ≥ 0 and ≤ the stage ceiling |
| `quota_watch` | `[]` | quota names, e.g. `compute.instance.gpu.h100` |
| `labels` | `nip-owner = platform` (plus the deprecated `nip-env = governance`, [`docs/naming.md`](../../../docs/naming.md#5-labels)); the stack adds `nip-stack = governance`, `nip-stage` and `nip-region` (`main.tf:10`), never passed by hand | `nip-run` required; `nip-ttl-expires` where the stage requires it |

The **stage ceiling** is the sum of `max_gpu_nodes` across stacks × 8 GPUs per node from
`platform/stages.yaml` (sandbox 56, staging 88, prod 320: inference, training and gpu-vm caps). A larger project limit fails the plan:
raise the stage policy first.

## Outputs and composition

`pricing_policy_ids[<platform>]` → R1/R3 `gpu_spot_pricing_policy_id` (apply this root first).
`pricing_policy_states` shows `SCHEDULING_STATE_BLOCKED` when a cap sits below the spot price.
`capacity_allowances` (id, limit, usage) and `quota_usage` (usage, and the limit exactly as the
API returned it) feed [`runbooks/finance.md`](../../../runbooks/finance.md).

## Quotas and cost

No compute, storage or network; no quota needed. Roles: `editor` in the project for pricing
policies ([prerequisites](https://docs.nebius.com/signup-billing/manage-pricing-policy#prerequisites));
`admin` in the tenant for project limits ([prerequisites](https://docs.nebius.com/overview/limits/manage-project-limits#prerequisites)).
The CI identity of a stage usually has neither at tenant level: plan `capacity_limits` from an
admin identity, or leave them to the console.

## Validate

- Static: `terraform test` (mocked, 11 runs): names and labels, parent, price format and precision, platform
  per region, GPU-only caps, whole-GPU limits, stage ceiling (sandbox and prod), limit 0 kept,
  quota usage with a missing limit, TTL and `nip-run` labels.
- Live: first run: sandbox, one cap at or above the current spot price, `limit = 0` on a test CBG if
  the tenant has one; record it in `docs/evidence/`.

## Evidence

None of this root yet: **not applied**. The recipe's `price.py` ran live on 2026-10-11
([R9 evidence](../../../recipes/finance/README.md#evidence)); that run created nothing here.

## Teardown

`make destroy-plan destroy STAGE=<stage> STACK=governance CONFIRM=yes`, after the stacks whose
preemptible node groups use the policies: deleting a policy can stop the resources that use it
([delete](https://docs.nebius.com/signup-billing/manage-pricing-policy#how-to-delete-a-pricing-policy)),
and a policy with running VMs refuses deletion ([status](https://docs.nebius.com/terraform-provider/reference/resources/billing_v1_pricing_policy#nested-schema-for-status)).
Removing a project limit makes the effective limit the CBG size again
([remove](https://docs.nebius.com/overview/limits/manage-project-limits#how-to-remove-a-project-limit)).

## Upstream references

[Spot pricing and pricing policies](https://docs.nebius.com/signup-billing/pricing-policy) ·
[managing pricing policies](https://docs.nebius.com/signup-billing/manage-pricing-policy) ·
[project limits](https://docs.nebius.com/overview/limits/project-limits) ·
[managing project limits](https://docs.nebius.com/overview/limits/manage-project-limits) ·
[quotas](https://docs.nebius.com/overview/quotas).
