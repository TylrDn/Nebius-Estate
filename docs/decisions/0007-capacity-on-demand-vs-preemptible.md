# ADR 0007: On-demand vs. interruptible (preemptible) capacity

- **Status:** accepted
- **Date:** 2026-10-09
- **Owner:** platform

## Context
Every node group in this repo exposes `preemptible` (`modules/node-group`, set to `{}` on the
Nebius API when enabled), and the serverless cookbook's templates default to
`preemptible=true`. Nebius's pricing policy states spot GPU prices can change as often as
every 15 minutes, including while a VM runs; GPU compute is billed per second. The
node-group docs add: "Set one of the spot pricing settings" with `preemptible` — a
`spot_pricing_policy` (a price cap) or `follows_spot_price` (pay whatever the spot price is).
The upstream recipe sets neither; the API accepted that on the live run of 2026-10-08, with
no documented behaviour for a node group that has no pricing setting.

## Options considered
1. On-demand for everything.
2. Preemptible for everything.
3. Preemptible only where the workload is restartable and the cost of an interruption is bounded.

## Decision and rationale
Option 3:

| Workload | Capacity | Why |
|---|---|---|
| `stacks/inference` serving node | **staging and prod: on-demand** (`gpu_preemptible = false`; `allow_preemptible_serving: false` in `platform/stages.yaml` refuses anything else). **Sandbox: preemptible** (`live/sandbox/inference/sandbox.auto.tfvars` sets `gpu_preemptible = true`) for smoke tests; set it to `false` for any run whose numbers are recorded as evidence | serving SLOs need stable capacity; a benchmark interrupted mid-run is not evidence |
| `stacks/training` GPU nodes | on-demand by default; preemptible allowed when the job checkpoints to Filestore at least every N minutes and uses `--requeue`-style restart | interruption cost = work since last checkpoint |
| Soperator workers | upstream default (`preemptible = null`), optionally `{}` per nodeset | Slurm handles node loss; still needs checkpoints |
| Serverless endpoints/jobs for the comparison | **on-demand** for the measured run, preemptible noted as the cookbook default | price variability would contaminate the comparison |

Whenever `preemptible` is on, `modules/node-group` also sets a pricing setting:
`spot_pricing_policy = { id }` when `spot_pricing_policy_id` is given (a cap, the safer choice
for a budgeted sandbox run), otherwise `follows_spot_price = {}`. `recovery_policy` is **not** set: it is
a Compute VM field, not a node-group template field.

No cost claim is made for either mode; the per-run rate observed in the console at run
time goes into `docs/evidence/<date>-<stage>-<stack>-<what>.md`, with the 15-minute volatility noted.

## Evidence
`nebius_mk8s_v1_node_group.template.{preemptible,spot_pricing_policy,follows_spot_price}`
schema (provider 0.6.67); https://docs.nebius.com/kubernetes/node-groups/manage (spot pricing
settings, verified 2026-10-09); pricing policy page
(https://docs.nebius.com/signup-billing/pricing-policy); cookbook templates
`preemptible=true` @ 6c150ce.

## Security and cost consequences
Preemption looks like a node failure: alerts must distinguish it (node condition / event) from
hardware faults. Savings are real only if restarts are cheap; otherwise on-demand is cheaper.

## Failure modes and recovery
Interrupted training → restart from checkpoint; interrupted serving → pod rescheduled when
capacity returns, so never run a single-replica production endpoint preemptible.

## Portability constraints
Spot semantics differ per cloud; keep the checkpoint discipline, not the flag.

## Review trigger
Nebius changes the spot price cadence. Capacity reservations (`reservation_policy`,
reservation IDs) already exist on node groups and are the subject of the production model
(ADR-0009): committed training uses `STRICT` reservations, burst uses `AUTO`, preemptible is
for checkpointed sweeps only.

## Note 2026-10-11 (docs sweep)
The decision is unchanged. Spot pricing applies to B300, B200, H200, H100 and RTX PRO 6000 from
2026-10-08 (changelog week of 2026-09-21). Provider 0.6.67 includes
`nebius_billing_v1_pricing_policy` (a per-project price cap for one region and platform), so the
cap can move into Terraform instead of an id created in the console. Since adopted: R9 governance
creates one per entry of `spot_price_caps` (`terraform/stacks/governance/main.tf:19`) and outputs
`pricing_policy_ids` (`outputs.tf:6`); passing the id to R1/R3 stays manual (`docs/cost.md`, "What is
not automated"). Node-group drain now defaults to 10 minutes before a
forced drain, which bounds how long a preempted or replaced node waits for a checkpoint.
Sources: https://docs.nebius.com/signup-billing/manage-pricing-policy#how-to-create-a-pricing-policy,
https://docs.nebius.com/kubernetes/node-groups/manage#deployment-strategy-and-quotas.
