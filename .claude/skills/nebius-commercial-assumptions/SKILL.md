---
name: nebius-commercial-assumptions
description: This skill should be used when the user asks "how much will this cost", "price this footprint", "on-demand vs preemptible vs reserved", "estimate monthly spend", "commercial assumptions", "is capacity available", or whenever a design or answer includes a price, a quota or an availability claim.
---

# Nebius commercial assumptions

Produce cost and capacity assumptions that are priced from live sources, dated, and labelled as
estimates, with the missing commercial inputs listed.

## Sources, in order of preference

1. Live calculator: `recipes/finance/price.py` (billing calculator `estimate-batch`), or the portal's
   Provisioning / Commercial live price. Contract prices need `resource.billinggroup.get` on the billing
   group, granted via tenant `viewer` (the 403 without it: `docs/evidence/2026-10-11-portal-live-read-only.md`,
   "Calculator with contract prices").
2. Capacity advisor: portal `/capacity` or `capacity/v1/resource-advice?parentId=<tenant>`
   (availability per region, fabric, platform, preset and type; counts are VMs, not GPUs).
3. Quotas: tenant quota-allowances (no limit means 0); project placeholders without id or limit draw
   on the tenant quota (`docs/evidence/2026-10-11-sandbox-inference-portal-connectors.md`, row "Quota semantics"). The API omits every limit; read limits in the console.
4. Token Factory (API-served models): `recipes/token-factory` (`list-models.sh`; usage and balance are
   console-only). Budgets and credits the owner tracks: the portal's Budgets & credits page.
5. Docs: `docs/cost.md` (billing model, estimate worksheet, spend controls, labels),
   `docs/solutions/pricing-and-billing.md`, `docs/solutions/compute-and-capacity.md`.

## Procedure

1. List the footprint: platform, preset, node count, capacity type, hours per day, storage, egress.
2. Price each line with the calculator; record the date, region, price basis (list or contract) and
   capacity type. Preemptible prices are dynamic spot prices: quote them as "from" the observed
   floor, beside the on-demand price.
3. Check availability and quota headroom for the exact region/fabric/platform/preset/type. A zero or
   "limit reached" result is a blocker, not a footnote.
4. Fill the estimate worksheet (`docs/cost.md#estimate-worksheet`): hourly, per run, monthly
   (730 h), with on-demand / preemptible / reserved side by side where they apply.
5. List missing commercial inputs: committed-use terms, reservation (capacity block group) terms,
   support tier, egress, customer discounts. These come from the Nebius account team.

## Rules

- Every figure is "an estimate, not a quote"; it does not guarantee capacity, price or terms.
- Never commit confidential contract prices, customer details or billing exports.
- Managed Kubernetes bills nodes only; the calculator cannot price the control plane spec.
- Do not invent a price, quota or availability level that no source returned; mark it missing.
