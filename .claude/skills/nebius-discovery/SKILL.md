---
name: nebius-discovery
description: This skill should be used when starting a Nebius customer engagement or scoping a new workload, e.g. "first call with a customer", "discovery questions", "scope this workload on Nebius", "what do we need to know before designing", or when a request names a workload without scale, targets, budget or ownership.
---

# Nebius discovery

Turn a customer request into a discovery note that separates verified facts, assumptions and open
questions before any design work starts.

## Procedure

1. Read the customer request and any prior notes. Classify the workload: inference serving,
   training/fine-tuning, batch inference, notebooks/data science, Slurm migration, or API-only.
2. Map it to candidate scenarios in `docs/solutions/use-cases.md` and to recipes in
   `docs/building-blocks.md` (R1–R16) and solutions S1–S9 in
   `solutions/README.md`. Name candidates; do not pick one yet.
3. Ask the first-call questions below that the request leaves open. Ask only what changes the design.
4. Gather read-only evidence about the customer's tenant only when credentials exist for it
   (`recipes/observability/metrics.sh coverage` shows which signals already flow):
   `make env-status`, the portal (`/capacity`, `/estate`) or `nebius ... list` commands. Never
   create, scale or delete anything during discovery.
5. Write the discovery note (template below). Every fact cites its source: a docs page anchor from
   `docs/reference/nebius-docs.md`, a repo file, or a read-only command output with its date.

## First-call questions

| Area | Question |
|---|---|
| Workload | Model(s) and size, framework, serving engine or training stack, data volume |
| Scale | GPUs or nodes now and in 6 months; burst vs steady; multi-node with InfiniBand needed? |
| Targets | Latency (TTFT/TPOT p50/p99) or throughput (tokens/s, samples/s); time-to-train |
| Availability | Uptime goal, tolerance for preemption, regions, DR expectation (`docs/dr.md`) |
| Security | Data residency, private connectivity (VPN, no public endpoints), identity provider, audit |
| Budget | Monthly ceiling, commitment appetite, on-demand vs preemptible vs reserved |
| Ownership | Who runs day 2: customer platform team, SA-led PoC, managed services |
| Constraints | Existing Slurm/Kubernetes, CI system, registries, data location today |

## Discovery note template

```markdown
# Discovery: <customer> / <workload> — <date>
## Verified facts      (each with source)
## Assumptions         (each with how to verify and who owns it)
## Open questions      (each with why it changes the design)
## Candidate recipes / solutions
## Capacity and quota signals   (read-only; region, platform, availability level, quota headroom)
## Next step           (design via nebius-reference-architecture, or more discovery)
```

## Guardrails

- Do not invent quotas, prices, GPU availability or API names. Mark unknowns as open questions.
- Quota semantics: a tenant quota-allowance with no limit means 0; a project entry with no id and no
  limit is a placeholder that draws on the tenant quota, not a cap (`docs/evidence/2026-10-11-sandbox-inference-portal-connectors.md`, row "Quota semantics").
  The API omits every limit (`docs/evidence/2026-10-11-portal-live-read-only.md`, Quotas); read limits in the console.
- Hand off to `nebius-commercial-assumptions` for any number with a currency.
