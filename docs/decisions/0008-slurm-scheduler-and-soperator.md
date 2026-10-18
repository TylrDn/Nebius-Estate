# ADR 0008: Scheduler choice for HPC-style users (Slurm via Soperator)

- **Status:** proposed (needs per-customer identity/partition answers)
- **Date:** 2026-10-09
- **Owner:** platform

## Context
Research teams that already live in Slurm want `sbatch`/`srun`, a shared environment and
a queue, while the platform team wants Kubernetes-based infrastructure (Recipe 4).
Nebius provides Soperator (Slurm controller and workers as Kubernetes pods, shared "jail"
filesystem) and a Terraform recipe for it in the solution library.

## Options considered
1. Kubernetes-native batch (Kueue / Volcano / Kubeflow jobs, as in `stacks/training`).
2. Soperator: Slurm on managed Kubernetes, pinned release, Terraform recipe wrapped as-is.
3. Slurm on plain VMs (no Kubernetes).

## Decision and rationale
Option 2 **when the users already depend on Slurm**, with three gates before any commitment:
pin the release (4.1.13) and read its limitations; confirm identity (no LDAP in the operator
doc) and partition needs against `docs/soperator-compatibility.md`; demonstrate scale-down
and a worker failure (`runbooks/soperator-jobs.md`). Otherwise option 1, which reuses
`stacks/training` with no extra operator.

The recipe is **wrapped, not rewritten** (`terraform/stacks/soperator`): it is a large,
release-coupled root maintained by Nebius with its own Terraform/provider requirements
(`>= 1.12`, `helm < 3`). A fork would drift and lose upstream CI coverage.

## Evidence
`docs/soperator-compatibility.md` (README vs limitations conflicts on CPU-only support and
CUDA version at 4.1.13). No job throughput or queue-latency numbers exist until the runbook runs.

## Security and cost consequences
Login nodes with public IPs and root SSH keys are the exposure surface; keep
`slurm_login_ssh_root_public_keys` to named operators and prefer Tailscale/VPN
(`tailscale_enabled`) for customers. The recipe's GPU workers default to **size 0** (this
repo's `profiles/lab.tfvars` runs one CPU worker and no GPU worker); a 2-worker 8-GPU H100 cluster
costs ~16 GPU-hours per hour of wall time.

## Failure modes and recovery
Scale-down leaves ghost nodes in `sinfo` (operator limitation) → `scontrol update
NodeName=... State=FUTURE` / delete. Jail overwrite when attaching an existing filesystem →
use submounts. Flux/HelmRelease drift → never edit releases outside the recipe.

## Portability constraints
Slurm job scripts port; the operator and recipe are Nebius-specific.

## Notes

- 2026-10-11: a fourth option to weigh with the customer is **Managed Service for Soperator**
  (console-deployed; visible and hidden partitions with priority tiers are configurable there,
  unlike the single user partition of self-deployed 4.1.13). Constraints from the docs: GPU
  worker nodes only with a capacity block group, not offered in `us-north1` or `uk-south2`, and
  every cluster adds service nodes (2 controllers, 1 accounting, 3–5 system nodes: at least
  48 non-GPU vCPU) ([deploy options](https://docs.nebius.com/slurm-soperator/deploy/overview#managed-service-for-soperator),
  [service nodes](https://docs.nebius.com/slurm-soperator/managed-soperator/service-nodes)).
  Ephemeral nodes (Soperator ≥ 3.0, enabled by Nebius) can move reserved GPUs to an MK8s
  inference node group on the same capacity block group
  ([ephemeral nodes](https://docs.nebius.com/slurm-soperator/capacity/ephemeral-nodes#slurm-power-management-commands)).

- 2026-10-13: **one deviation from "wrapped, not forked"**, by owner decision
  ([options](../plans/2026-10-13-soperator-options.md), "B patch + A issue"). The recipe at
  `soperator-v4.1.13-2` declares `data.nebius_iam_v1_project` and `data.nebius_iam_v1_tenant`, whose v1
  APIs are supported until 2026-12-16, and no newer tag drops them
  ([R4-14](../upstream-findings.md#r4-soperator)). Overrides cannot remove a data source, so
  `terraform/stacks/soperator/patches/0001-drop-iam-v1-data-sources.diff` (2 files, 12 lines) is applied
  by `scripts/fetch-soperator.sh` to the pinned commit before the overrides; a patch that stops applying
  stops the fetch. It is the only patch: further fixes stay `*_override.tf`. Drop it at the first
  upstream tag without both data sources (an upstream issue is drafted:
  [upstream issue](../plans/2026-10-13-soperator-upstream-issue.md));
  [`terraform/stacks/soperator/README.md`](../../terraform/stacks/soperator/README.md#patches).

## Review trigger
Soperator release with multi-partition or LDAP support; customer identity requirements; an upstream
tag without the v1 IAM data sources (drop `patches/0001`).
