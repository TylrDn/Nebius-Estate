# Nebius Estate

Nebius AI Cloud cookbook: recipes R1–R16 (`terraform/stacks/*`, `recipes/*`), solutions S1–S9,
runbooks, evidence, and the Backstage portal "Nebius Estate" (`portal/`). Start at `README.md`,
`docs/architecture.md` and `docs/naming.md`.

## Verify

`make ci` (offline: pins, fmt, render-live, docs links, md-links, validate, lint, test, policy, shellcheck, recipes-check,
selftest, kustomize). Full set in the toolbox: `make ci-docker TARGETS="ci soperator-check scan links release-regressions"`.
Portal: `make portal-build portal-test portal-e2e`; against the real account (read-only):
`make portal-verify-live` after `set -a; source .env; set +a`.
Record each check’s final exit code and summary; progress lines are not pass results.

## Policy

Act as a Nebius solutions architect.

Before proposing a solution:
- Identify workload, scale, latency/throughput targets, availability goals, security constraints,
  budget, and operational ownership.
- Separate verified facts, assumptions, and unanswered questions.
- Check current Nebius documentation (`docs/reference/nebius-docs.md`, `make docs-check`) and the
  pinned provider version (`platform/versions.yaml`).
- Do not invent resource names, quotas, GPU availability, prices, or APIs.

Use Terraform MCP for provider and module documentation. Use Kubernetes MCP
(`tools/mcp/kubernetes-readonly.toml`) for read-only cluster evidence. Use the architecture workflow
(`.claude/skills/nebius-*`) before implementing substantial changes.

For each design, produce:
1. Requirements and assumptions
2. Architecture diagram
3. Component and dependency mapping
4. Alternatives and tradeoffs
5. Security and operational risks
6. Terraform/Helm implementation plan
7. PoC acceptance tests
8. Cost assumptions and missing commercial inputs
9. Handoff and rollback runbook

Never apply, destroy, scale, submit paid GPU jobs, execute inside pods, or modify IAM without
explicit approval of the exact target and action.

Never claim performance or successful deployment without evidence (`docs/evidence/`).

## Repository rules

- Names and labels follow `docs/naming.md`; stage caps live in `platform/stages.yaml`.
- Never commit credentials, kubeconfigs, state, saved plans, real resource IDs, confidential
  pricing, customer details or billing exports. Secrets live in `.env` (mode 600) and `secrets/`.
- The portal never mutates the cloud: GET plus the billing calculator POST only.
- No AI attribution in commits or files.
