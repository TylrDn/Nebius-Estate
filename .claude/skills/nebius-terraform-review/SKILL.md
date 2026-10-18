---
name: nebius-terraform-review
description: This skill should be used when the user asks to "review this Terraform", "check a stack change", "review a plan", "is this safe to apply", "add a new stack or module", or before any change under terraform/ is called done.
---

# Nebius Terraform review

Review a Terraform change in this repository for correctness, safety and convention, using only
offline checks and saved plans. Never run apply or destroy as part of a review.

## Procedure

1. Scope: `git diff --stat -- terraform/ platform/ scripts/`. List the roots touched
   (`terraform/stacks/*`, `terraform/modules/*`, `terraform/live/<stage>/<stack>`, foundation).
2. Provider facts: confirm every resource and argument with Terraform MCP against the version pinned
   in `platform/versions.yaml` (provider `nebius/nebius`). Flag arguments the docs do not list.
3. Run the checklist below.
4. Run the gates: `make fmt-check validate test render-live-check docs-links`, then
   `make ci-docker TARGETS="lint policy"` (toolbox; Docker is permission-prompted).
5. With a saved plan only: `make show-plan STAGE=<s> STACK=<k>` and `make plan-digest`. Report the
   `Plan:` line, every replace (`-/+`) and every destroy, and why each happens.
6. Report findings ranked by severity with file:line. State which gates ran and their results.

## Checklist

- Naming and labels match `docs/naming.md`; the stack sets `nip-stage`, `nip-region`, `nip-stack`.
- Stage caps respected (`platform/stages.yaml`); prod sizing and Soperator prod pass `make policy`.
- Node group template changes (presets, drivers preset, filesystem, taints, instance metadata labels)
  replace every node: call it out with a checkpoint plan (`docs/change-management.md`).
- `propagate_cost_labels` copies `nip-*` into node metadata except per-run `nip-run`/`nip-ttl-expires`.
- Regular GPU groups without `gpu_reservation` get `FORBID` (`docs/capacity.md#capacity-types`).
- Secrets: sensitive variables or SecretStash, never tfvars in git; no real IDs committed.
- Quotas the change needs are listed against `docs/capacity.md#quotas-per-stack`.
- Mocked `terraform test` covers each new input, precondition and output; live roots are re-rendered
  with `scripts/render-live-roots.py`.
- Every docs link cites an anchor present in `docs/reference/nebius-docs.json`.

## Never

Apply, destroy, import, `state rm`, or change IAM during a review. Those need explicit approval of
the exact target and action, then `runbooks/deploy.md` or `runbooks/teardown.md`.
