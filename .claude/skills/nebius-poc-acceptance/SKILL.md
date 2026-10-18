---
name: nebius-poc-acceptance
description: This skill should be used when the user asks to "define PoC acceptance criteria", "write acceptance tests", "prove the deployment works", "record evidence", "is the PoC done", or before claiming any performance figure or successful deployment.
---

# Nebius PoC acceptance

Define acceptance criteria a customer can sign, prove them with commands, and record the evidence.
No result is claimed without an evidence file.

## Procedure

1. Derive criteria from the design's targets (discovery note) and `docs/slo.md`. Each criterion:
   metric, threshold, method, command, owner. Prefer the existing validators:
   `tests/validate/00-nodes.sh` … `05-load.sh`, `network.sh`, `data.sh`, `run-all.sh`,
   `run-training.sh`.
2. Security acceptance: the checklist in `docs/security.md#security-acceptance-checklist`.
   Portal demos: `docs/portal/acceptance-checklist.md`.
3. Before a run: spend approval with the exact stack, presets, count and TTL; quotas checked
   (`nebius-gpu-workload-triage` step 1). The run itself needs explicit approval.
4. After a run: write `docs/evidence/<date>-<stage>-<stack>-<what>.md` with the header from
   `docs/evidence/README.md` (kind, date/region/platform/presets, versions, method, cost), a results
   table, and "what this does and does not show". Add its row to `docs/evidence/README.md`.
   Machine-readable results go to `results/*.json`.
5. Teardown proof: `make leftovers-stage STAGE=<s>` (`scripts/leftovers.sh --stage <s> --expect-empty`,
   with `NEBIUS_PROJECT_ID` set to the stage's project; `make leftovers` ignores `STAGE`) prints
   nothing; quote the destroy summary line.

## Rules

- A single GPU cannot show bus bandwidth; a warm cache is not storage throughput; one run is not a
  p99. Say what the method cannot show.
- Prior upstream runs (2026-10-07/08) prove patterns, not this repository's defaults.
- Never round up, extrapolate or reuse a figure from another platform or region.
