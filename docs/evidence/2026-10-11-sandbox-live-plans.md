# sandbox live plans, no apply (R9 governance, R7 network, R3 training, R4 Soperator, R13 foundation) — 2026-10-11

- **Kind:** run of this repository: `make plan` against the real API (refresh and data-source reads), never
  applied; every saved plan deleted afterwards. $0.
- **Date / region:** 2026-10-11, 17:51–18:00 UTC, `eu-north1` sandbox project.
- **Versions:** provider `nebius/nebius` 0.6.67, Terraform 1.16.3; Soperator recipe `soperator-v4.1.13-2`.
- **Method:** per root, `source scripts/bootstrap-backend.sh sandbox <stack>` and a git-ignored run override with
  labels (`nip-run=live-recipe-<stack>-2026-10-11`, 3 h TTL), then `make init plan` (`make soperator-plan` for R4).
  Governance with `spot_price_caps = {gpu-l40s-a = "1.000"}` and two `quota_watch` names; network with the
  committed sizing (NAT on); training with the committed sizing (`gpu_node_count = 0`). The foundation with
  `ci_federation` (this repository's ids) and the sandbox stage `ci = true`, against a scratch local backend
  (`*_override.tf`, removed after), so bootstrapping the foundation's own state made no IAM change.

## Results

| Root | Plan | Notes |
|---|---|---|
| governance (R9) | `2 to add` (pricing policy, stage policy); **the apply later failed on the pricing policy**: the API accepts spot caps only for H100 (eu-north1) and H200 (eu-north1, eu-north2, eu-west1, us-central1), not `gpu-l40s-a`; the plan cannot see that, so the stack now refuses it at plan (`spot_price_cap` in `platform/regions.yaml`) | quota data sources read: `quota_usage` for `compute.instance.gpu.l40s` reported no usage and no limit **while a preemptible L40S VM ran**: a preemptible VM counts only against `compute.instance.preemptible.count` (tenant usage 1); watch that quota for preemptible sandboxes |
| network (R7) | `18 to add` | plans cleanly; its NAT VM (`cpu-d3` `4vcpu-16gb`) would fail at apply on the non-GPU vCPU quota of 0, which the plan cannot see |
| training (R3) | `12 to add` | cluster, CPU node group (2 × CPU, quota-blocked at apply), filesystem and add-ons; no GPU nodes |
| Soperator (R4) | **failed twice, fixed**, then `44 to add` | (1) `No value for required variable` × 5 (`iam_tenant_id`, `iam_project_id`, `o11y_iam_tenant_id`, `o11y_profile`, `vpc_subnet_id`): the recipe's `.envrc` sets them and `bootstrap-backend.sh` (which replaces it) did not; now exported for `soperator`. (2) `SSH public keys must not be empty strings`: the recipe's `terraform.tfvars` sets `slurm_login_ssh_root_public_keys = [""]` and a `-var-file` beats `TF_VAR_*`, so the documented export never reached the plan; `make soperator-plan` now passes an exported list as `-var`. Plan: MK8s cluster, 5 node groups, 3 filesystems, 1 allocation, 3 Helm releases |
| foundation + `ci_federation` (R13) | `21 to add` | two federated credentials with `sub` `repo:<owner>/<repo>:repository_owner_id:<id>:repository_id:<id>:environment:sandbox` and `…:environment:sandbox-plan`, issuer `https://token.actions.githubusercontent.com`; plus the CI, state and state-reader identities. Its state bucket and `nip-tfstate-sandbox` already exist (created by the bootstrap), so an apply needs `adopt_bootstrap` (as `terraform.tfvars.example` says) or fails on the names |

## What this does and does not show

- Shows: every root plans against the real API in `eu-north1`; two Soperator plan-path defects fixed
  (`tests/scripts/test-bootstrap-backend.sh`, `tests/scripts/test-soperator-plan-vars.sh`).
- Does not show: any apply. Network, training and Soperator stay blocked at apply by the non-GPU vCPU quota of 0.
