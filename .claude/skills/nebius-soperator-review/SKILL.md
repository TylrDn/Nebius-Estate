---
name: nebius-soperator-review
description: This skill should be used when the user asks to "review Soperator", "plan a Slurm cluster on Nebius", "migrate from Slurm", "check the Soperator recipe or version", "debug sbatch jobs on Soperator", or changes terraform/stacks/soperator.
---

# Nebius Soperator review

Review Soperator (Slurm on Kubernetes) plans and changes against the pinned recipe and its
compatibility notes.

## Sources

- `docs/soperator-compatibility.md` (supported releases, how the recipe installs, recipe notes)
- `docs/decisions/0008-slurm-scheduler-and-soperator.md`, `0006-reconciler-ownership.md`
- `terraform/stacks/soperator` (wrapper around the pinned upstream recipe tag)
- `runbooks/soperator-jobs.md`; evidence `docs/evidence/2026-10-08-soperator-4.1.13-cpu.md`
- `docs/upstream-findings.md` for known upstream gaps

## Procedure

1. Confirm the recipe tag and Soperator version in `platform/versions.yaml` and that the Kubernetes
   version sits in the window in `docs/capacity.md#kubernetes-version-window`.
2. Check the stage profile (lab vs prod) against `platform/stages.yaml` and `make policy`
   (Soperator prod rules).
3. Walk the five configuration findings fixed after the 2026-10-08 runs; confirm none regressed.
4. Quotas: `docs/capacity.md` Soperator section; GPU cluster quota for InfiniBand workers.
5. Gates: `make ci-docker TARGETS="soperator-check"`; plan with `make soperator-plan STAGE=<s>` only
   when approved to read the stage backend.
6. Migration questions (from discovery): partitions, accounting, job scripts, container use,
   shared filesystem layout, login access, backups (`TF_VAR_backups_password`).

## Never without explicit approval

`make soperator-apply`, scaling workers, submitting jobs, or exec into login/worker pods. An
interrupted apply is an incident (`runbooks/incident.md`).

## Output

Version fit, configuration findings with file:line, quota needs, migration gaps, and the evidence
that exists vs what a run must still prove.
