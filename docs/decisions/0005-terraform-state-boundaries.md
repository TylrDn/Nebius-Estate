# ADR 0005: Terraform state boundaries

- **Status:** accepted
- **Date:** 2026-10-09
- **Owner:** platform
- **Note (2026-10-11):** the one-day key below is the local path (`scripts/bootstrap-backend.sh`). The
  disabled pipeline uses a long-lived state key held as a GitHub Environment secret, created with an
  expiry and rotated by [`runbooks/credential-rotation.md`](../../runbooks/credential-rotation.md); per-job
  minting needs IAM permissions the docs do not describe. The state bucket now carries `prevent_destroy`.

## Context
Terraform state is a snapshot of the infrastructure and can contain sensitive
values (P3). Fewer, larger states are simpler but raise blast radius; many
small states limit risk but add dependency wiring.
Nebius's own recipes keep one state per solution root in a versioned Object
Storage bucket created by `environment.sh`.

## Options considered
1. One state for everything.
2. One state per root (today: per stage × stack live root), one bucket per project.
3. One state per layer per environment (network / cluster / platform / workload).

## Decision and rationale
Option 2, refined by ADR-0009: each live root `terraform/live/<stage>/<stack>` is an ownership
boundary with its own state key (`stages/<stage>/<stack>.tfstate`) in one versioned bucket per
stage project (`tfstate-nip-<stage>-<md5(tenant-project)[:12]>`). It is the upstream pattern plus the docs'
`use_lockfile` and AWS-check opt-outs and a bucket-scoped identity (below), so customers
who already use the solution library see little new, and it means
destroying one stack or stage can never touch another's state.
Option 3 was rejected for now: the platform layer is installed by the same
apply that creates the cluster (ADR-0006), so splitting it would only add
`terraform_remote_state` wiring without reducing risk.

## Evidence
- `nebius-solutions-library/k8s-training/environment.sh` @ `soperator-v4.1.13-2` (`d1c15ca`): bucket, SA, 1-day key, S3 backend override.
- Terraform S3 backend (>= 1.11; CI pins 1.16.5, `platform/versions.yaml`) with `use_lockfile = true` for locking without DynamoDB.

## Security and cost consequences
- Bucket versioning gives state history and recovery; the access key expires after one day.
- Credentials never land in git: `backend.hcl` holds bucket/key/endpoint only and is git-ignored.
- **State identity is scoped to the bucket** (changed 2026-10-09; the upstream `environment.sh` puts
  its service account in the tenant `editors` group, which is tenant-wide write). Per environment,
  `scripts/bootstrap-backend.sh` creates a custom group *in the project*, makes the service account
  its member, and grants the group `storage.object-editor` by an access permit scoped to the state
  bucket. Buckets are a permit-capable resource type and custom groups may live in a project
  (docs: `iam/authorization/groups`, `iam/authorization/roles`), so a project admin can do this
  without tenant-level IAM, which some tenants deny. If the API refuses the bucket scope the
  script **stops**; it never widens on its own. `NIP_STATE_PERMIT_SCOPE=project` is an explicit
  opt-in that grants `storage.object-editor` on every bucket in the project, and
  `tenant-editors` reproduces the upstream tenant-wide grant.
- Blast radius of a leaked 1-day key, by scope: **bucket** (default) — the state objects in this
  one bucket, recoverable from object versions; **project** — every object in every bucket of
  the project (not the buckets themselves, not compute); **tenant-editors** — every project
  resource. `docs/security.md` reports the default; a run with a wider scope must be recorded in
  the evidence file for that environment.
- Cost: one small bucket; negligible.

## Failure modes and recovery
- Lost lock file: `terraform force-unlock` after confirming no apply is running.
- Corrupted state: restore a previous object version from the bucket.
- Expired key mid-session: re-source `scripts/bootstrap-backend.sh`.

## Portability constraints
Any S3-compatible store works with the same `backend.tf`; only `backend.hcl` changes.

## Review trigger
Move the platform layer to GitOps (ADR-0006). The environment axis is now ADR-0009's.
