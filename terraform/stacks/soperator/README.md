# `stacks/soperator` — Slurm on Kubernetes (R4)

**Purpose.** Slurm (controller, login and workers as pods on a shared "jail" filesystem: Soperator's shared root filesystem, mounted as `/` on every login and worker node, [primer](../../../docs/nebius-primer.md)) on Managed
Kubernetes for researchers who depend on `sbatch`/`srun`. It **wraps the upstream Soperator recipe
at a pinned tag**, never re-implements it; fixes are `*_override.tf` files laid over the vendored
module ([ADR-0008](../../../docs/decisions/0008-slurm-scheduler-and-soperator.md)), with one
deviation: a single patch, below ([Patches](#patches)). Kubernetes-native
jobs belong in [R3](../training/README.md).

**Used by.** [S5](../../../solutions/S5-slurm-migration/README.md) Slurm migration ([all solutions](../../../solutions/README.md)).

| Pin | Value |
|---|---|
| Recipe | `nebius/nebius-solutions-library` tag `soperator-v4.1.13-2` (`d1c15ca`), `soperator/installations/example`, plus [`patches/0001`](patches/0001-drop-iam-v1-data-sources.diff) |
| Soperator / Kubernetes | `4.1.13` / `1.35` (the release supports 1.32–1.35) |
| Terraform | `>= 1.12` (the recipe's requirement) |

## What it builds (lab profile)

MK8s cluster; system nodeset 3 × `cpu-d3 8vcpu-32gb`; controller 1 × `4vcpu-16gb`; login
1 × `16vcpu-64gb` with a public IP; one CPU worker; jail 256 GiB, `/data` 64 GiB and controller
spool 128 GiB filesystems; Flux and the Soperator HelmReleases (Flux owns them,
[ADR-0006](../../../docs/decisions/0006-reconciler-ownership.md)). No GPU cluster until a GPU nodeset
is approved.

## Inputs that matter

Var files apply in order: the recipe's `terraform.tfvars`, [`profiles/lab.tfvars`](profiles/lab.tfvars)
(the smallest shape the recipe accepts, with the reason for each setting), then
`terraform/live/<stage>/soperator/stage.tfvars` (last wins). Prod sets `production = true`, 2,048 GiB
deletion-protected jail and `/data`, and backups on (policy `soperator_prod`).
`slurm_login_ssh_root_public_keys` comes from `TF_VAR_` at plan time.

## Outputs and composition

The recipe's own outputs. It creates its own cluster and filesystems
and does not consume R7/R8 at this tag. Release facts and doc conflicts:
[`docs/soperator-compatibility.md`](../../../docs/soperator-compatibility.md).

## Quotas and cost

52 non-GPU vCPU, 1,280 GiB SSD, ~280 GiB IO_M3 (CSI spool PVC), 448 GiB filesystems, 6 VMs,
1 public IP ([`docs/capacity.md`](../../../docs/capacity.md#stackssoperator-lab-profile-every-stage));
≈ $1.89/h at unit rates on the `uk-south1` bill, 2026-10-07/08 (list, not a quote): 1.716 for 52 vCPU +
208 GiB `cpu-d3`, 0.125 for 1,280 GiB SSD, 0.049 for 448 GiB filesystems
([`docs/evidence/costs.md`](../../../docs/evidence/costs.md#observed-unit-costs)).

The 52 vCPU are non-GPU vCPU, whose default quota is **0** in `eu-north1` and `us-central1`
(`.cache/nebius-docs/compute/resources/quotas-limits.md:41`): raise `compute.instance.non-gpu.vcpu` before a plan there (a CPU node group was refused
for exactly this on 2026-10-11, [evidence](../../../docs/evidence/2026-10-11-sandbox-inference-portal-connectors.md)).

## Patches

The one deviation from "wrapped, not forked" (ADR-0008, owner decision 2026-10-13,
[options](../../../docs/plans/2026-10-13-soperator-options.md)):
[`patches/0001-drop-iam-v1-data-sources.diff`](patches/0001-drop-iam-v1-data-sources.diff) removes
`data.nebius_iam_v1_project` and `data.nebius_iam_v1_tenant` from `installations/example`, whose v1 APIs
are supported until 2026-12-16 ([R4-14](../../../docs/upstream-findings.md#r4-soperator)); after that date
the unpatched recipe cannot plan. The five reads of `data.nebius_iam_v1_project.this.id` become
`var.iam_project_id` (the same string the data source was looked up by); the tenant data source was never
read. 2 files, 5 lines changed, 7 removed. Side effect: a wrong project id no longer fails at the data
source read; the first resource that uses it fails instead.

- **How it is applied.** `scripts/fetch-soperator.sh` applies `patches/*.diff` in name order to the
  pinned commit, after the sparse checkout and before the overrides: `git apply --check`, then `git apply`.
  A patch that no longer applies stops the fetch, names the patch and removes the checkout. A reused
  checkout must be exactly the pinned commit plus the patch set: the script compares `git diff` with the
  diff it recorded when it applied the patches, and the patch set with the one it applied; a local edit,
  a missing or a changed patch re-fetches.
- **What checks it.** `make soperator-check` fails if the patched tree still declares or reads either
  data source, then validates and runs the mocked plan for `sandbox`, `staging`, `prod` and `lab`;
  `tests/scripts/test-fetch-soperator-patches.sh` (`make selftest`) covers the apply, reuse, dirty-tree
  and stale-patch paths against a fake upstream.
- **When to drop it.** At the first upstream tag that no longer declares either data source (upstream
  issue drafted: [2026-10-13 upstream issue](../../../docs/plans/2026-10-13-soperator-upstream-issue.md)).
  Re-pinning to such a tag makes `git apply --check` fail on `0001`, which is the cue: delete the patch,
  re-run `make soperator-check`, update R4-14. Any other re-pin re-reviews the patch the same way
  ([`runbooks/upgrade.md`](../../../runbooks/upgrade.md#soperator)).
- **Not yet live.** No live plan or apply has run with the patch; run 4's R4 in `lab` is the first.

## Run and validate

- Static: `make soperator-check`: the recipe at the tag plus [`patches/`](#patches), `fmt`, no v1 IAM
  data source left, `validate`, and a mocked plan per stage with all three var files ([`tests/overrides.tftest.hcl`](tests/overrides.tftest.hcl)).
- Run: `make soperator-plan STAGE=<stage>`, review (6 VMs, 3 filesystems, no GPU cluster), then
  `make soperator-apply STAGE=<stage> CONFIRM=yes` (in `sandbox` and `lab` only while
  `make ttl-teardown STAGE=<stage> STACK=soperator TTL=<UTC> CONFIRM=yes` is running: the recipe sets no
  TTL label, `scripts/ttl-armed.sh`); exact commands in
  `terraform/live/<stage>/soperator/README.generated.md`.
- Live: [`runbooks/soperator-jobs.md`](../../../runbooks/soperator-jobs.md) (`sinfo`, `sbatch`, NCCL
  across workers). Evidence: [`2026-10-08-soperator-4.1.13-cpu.md`](../../../docs/evidence/2026-10-08-soperator-4.1.13-cpu.md)
  (the recipe with this profile ran `sbatch` to `COMPLETED` on a CPU worker; not GPU workers,
  InfiniBand or this wrapper's live roots).

## Evidence

| Date | What | Result |
|---|---|---|
| 2026-10-07/08 | upstream recipe at `soperator-v4.1.13-2`, CPU worker, `uk-south1` ([evidence](../../../docs/evidence/2026-10-08-soperator-4.1.13-cpu.md)) | `sbatch` `COMPLETED` on run 7 of 7; a prior run of the upstream recipe, not of this wrapper |
| — | `make soperator-apply` of this wrapper's live roots; GPU workers; NCCL over InfiniBand | **not yet run** |

## Teardown

[`runbooks/teardown.md`](../../../runbooks/teardown.md#soperator-stackssoperator) (CSI disk cleanup
needs python3 ≥ 3.11).

## Upstream references

[Soperator](https://github.com/nebius/soperator) ·
[recipe](https://github.com/nebius/nebius-solutions-library/tree/soperator-v4.1.13-2/soperator) ·
[Soperator docs](https://docs.nebius.com/slurm-soperator) ·
findings [R4-1 … R4-14](../../../docs/upstream-findings.md#r4-soperator).
