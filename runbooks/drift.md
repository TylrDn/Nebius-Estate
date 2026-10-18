# Drift runbook

1. `terraform -chdir=terraform/live/<stage>/<stack> plan -detailed-exitcode` (exit code 2 = changes/drift). Needs the same shell as `source scripts/bootstrap-backend.sh <stage> <stack>`.
2. Identify the source: manual console change, another reconciler, or provider upgrade. Expected: every
   `~`/`-/+` line in the plan is attributed to one of the three (an attribute the provider now
   returns differently after a version bump in `platform/versions.yaml` is an upgrade, not drift).
3. Decide: codify the change in Terraform, or revert it with `make plan` and `make apply CONFIRM=yes`.
   Expected: step 1 run again exits 0 (no changes).
4. Record what drifted and why in this file's log below.

## Drift log

| Date | Resource | Cause | Resolution |
|---|---|---|---|
