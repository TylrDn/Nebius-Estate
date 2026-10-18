# ADR 0009: Environment and promotion model

- **Status:** accepted
- **Date:** 2026-10-10
- **Owner:** platform
- **Supersedes:** the "add a fourth environment root" review trigger of ADR-0005
- **Later changes (2026-10-11), recorded here instead of rewriting the decision:**
  - Stacks: `network` (R7) and `data` (R8) joined `inference` and `training`; all four share the
    `modules/stage-policy` check and are driven by `make` and the pipeline.
  - Soperator: planned and applied with `make soperator-plan` / `make soperator-apply`, which fetch the
    recipe and run through `scripts/tf-run.sh`; it is still outside the pipeline and the stage policy.
  - `prevent_destroy` is now set on the state bucket only, the one resource every stage wants
    protected ([`docs/dr.md`](../dr.md)); the stacks still do not use it.
  - Pipeline: the apply job re-plans and must match the resource-change digest reviewers approved; no
    saved plan is uploaded. Private-endpoint stages need a self-hosted runner
    ([change management](../change-management.md#runners)).
  - Current state (docs audit 2026-10-11), superseding the stack and Soperator wording in this file
    where they differ: the pipeline offers seven stacks (`network`, `data`, `inference`, `training`,
    `gpu-vm`, `ml-services`, `governance`; `.github/workflows/terraform.yml:52`), so a **Stack** below
    is any of those, not only `<inference|training>`; Soperator runs through `make soperator-plan` /
    `make soperator-apply` (`Makefile:235,240`), not plain `terraform`, and stays outside the pipeline;
    the line "`prevent_destroy` is deliberately not used" below now holds for the stacks only: the state
    bucket sets it (`terraform/modules/foundation/state-bucket/main.tf:12`, [`docs/dr.md`](../dr.md)).
  - Credentials: two CI identities per stage instead of one: `viewer` for the plan job (`<stage>-plan`
    environment) and `editor` for the apply job (`<stage>`); their first authorized keys are registered
    with the CLI. The CI state key is a long-lived environment secret held by both
    ([security](../security.md), [credentials](../credentials.md#ci-service-account-keys)).
- **Later change (2026-10-12): a fourth stage, `lab`** (this ADR's review trigger). The sandbox project's
  region (`eu-north1`) has a non-GPU vCPU quota of 0, which blocks every CPU-only stack (R4 Soperator,
  R7's NAT VM). `lab` is a fourth project, a new one created for it (`nip-lab`, in `uk-south1`; no
  existing project is reused), with sandbox rules (TTL labels, single
  etcd, public endpoint) and **no GPUs** (`max_gpu_nodes` 0 everywhere); its `stacks:` list in
  `platform/stages.yaml` renders only `network` and `soperator` roots, and `policy/stages.rego` keeps it
  CPU-only with `require_ttl_label` (for the stage named `lab` even without its `stacks:` key). The TTL is
  enforced per stack: `network` by `modules/stage-policy` at plan time (a `nip-ttl-expires` label is
  required); the Soperator recipe labels nothing, so `make soperator-apply` refuses in a TTL-bound stage
  until its `make ttl-teardown STACK=soperator` job is running (`scripts/ttl-armed.sh`). `lab` has no
  per-stage budget (it is outside the foundation), so that TTL is its spend guard. It is never promoted, is outside the pipeline and the foundation
  (`adopt_bootstrap` stays sandbox/staging/prod), and gets its state bucket and identity from
  `scripts/bootstrap-backend.sh lab <stack>` with `NIP_BOOTSTRAP_NEW_STAGE=1`, which binds it to its
  project and region like any stage and refuses a project already bound to another stage. Rejected: re-binding `sandbox` to a second project or region
  (breaks one project per stage, the per-stage budget and the tenant-unique `nip-sandbox-*` names), and
  a per-run region override (the same, per run, and nothing to stop it drifting into GPU stacks).

## Context
Until now the repository's "environments" were recipe roots (`lab`, `training`, `soperator`)
sharing one project, one state bucket and one tenant-wide identity, applied by a person with a
12-hour user token. That is a lab shape, not a lifecycle: nothing distinguished a disposable
experiment from a customer-facing cluster, quotas and blast radius were shared, and nothing
said how a change travels from "tried once" to "running for customers". Nebius quotas, budgets and IAM
are per project (https://docs.nebius.com/overview/quotas), which makes the project the natural
stage boundary.

## Options considered
1. Keep recipe roots; document a manual promotion process.
2. Workspaces per stage inside each root (one state bucket, `terraform workspace`).
3. **Two axes: stage × stack.** A stack is a stage-agnostic root module; a stage is a project
   with its own state, identities and policy; a live root per (stage, stack) wires the two.

## Decision and rationale
Option 3.

| Term | Meaning here |
|---|---|
| **Stack** | `terraform/stacks/<inference\|training>`: the root module a stage promotes. It reads `platform/stages.yaml` and enforces that stage's policy as plan-time preconditions; `make STAGE=<stage> STACK=<stack>` and the pipeline drive it. `terraform/stacks/soperator` is different: it wraps the upstream recipe (fetched at the pinned tag by `scripts/fetch-soperator.sh`) and layers `profiles/lab.tfvars` and the stage's `stage.tfvars`; it is run with plain `terraform` from the fetched recipe directory (`terraform/live/<stage>/soperator/README.generated.md`) and checked by `make soperator-check`, not by the `make` stack targets or the pipeline. |
| **Stage** | `sandbox` (disposable, TTL-labelled, budget-capped), `staging` (production shape at reduced size, applied by a manual dispatch from `main`), `prod` (customer-facing, applied by a manual dispatch from a release tag through a protected environment). Each is its own Nebius project, state bucket and pair of identities. |
| **Live root** | `terraform/live/<stage>/<stack>`: backend, providers, one `module "stack"` call, the stage's `*.auto.tfvars`. Generated by `scripts/render-live-roots.py`; CI fails when stale. For Soperator the directory holds only `stage.tfvars` and the generated command sheet. |
| **Foundation** | `terraform/live/foundation`: the tenant-level objects a stage needs — project (optional), versioned state bucket with a retention rule, the bucket-scoped state identity (ADR-0005), the CI service account with `editor` on that project only. Applied once by an administrator, never by the identities it creates. |

Promotion is the same module version applied in the next stage with that stage's tfvars:
`sandbox` → `staging` by a manual dispatch of `.github/workflows/terraform.yml` from `main` once
the change is merged with CI green; `staging` → `prod` by a manual dispatch from a release tag,
with staging's `validate-cluster` evidence from the same commit and required reviewers on the
`prod` environment. Nothing is applied by a merge or a tag on its own (`platform/stages.yaml` → `promotion`). What may differ between stages is
size, capacity type, exposure and protection flags; what may not differ is the module.

The policy a stage imposes lives in `platform/stages.yaml`, enforced by
`terraform_data.stage_policy` and the `stage`-aware variable validations in each stack; the
values are rendered once, in [Stage policy](../../platform/README.md#stage-policy). The shape:
sandbox trades protection for speed (single etcd member allowed, public endpoint, TTL label
required, preemptible serving allowed); staging is production shape at reduced size; prod adds
a private endpoint, deletion protection, STRICT reservations for training and refuses
`make destroy`.

Why not workspaces: one bucket and one identity per stage is the point — a leaked sandbox key
must not reach prod state. Why generated live roots: the pass-through variables would otherwise
drift from the stack in three places; the generator makes the stack the single source and CI
proves it.

### Stage-governed flags
`platform/stages.yaml` also fixes, per stage: `audit_logs`, `alertmanager`, `k8s_version_pinned`
and `k8s_version_offset` (prod runs N-1), `require_allowed_cidrs` (a public endpoint only behind an
allowlist), `forbid_deletion` (filesystems, jails) and `require_strict_reservation` (prod training on
reserved capacity). The stacks expose the matching inputs (`allowed_cidrs`, `security_group_ids`,
`audit_logs`, `filestore_forbid_deletion`, `gpu_reservation`, `alertmanager_enabled`) and enforce the
policy in `terraform_data.stage_policy`; `policy/*.rego` (conftest) guards the policy file and the prod
sizing files at review time. Terraform's `prevent_destroy` is deliberately not used
([`docs/dr.md`](../dr.md)).

### Credentials
Every live root takes `iam_token` as an ephemeral variable: a user login locally, the stage's CI
service account in the pipeline (shipped disabled), one token for every provider. Paths and
precedence: [`terraform/README.md`](../../terraform/README.md#authentication).

## Evidence
- Quotas, budgets and IAM scoped per project: https://docs.nebius.com/overview/quotas,
  https://docs.nebius.com/signup-billing/budgets, https://docs.nebius.com/iam/authorization/groups.
- User tokens are for local development; service-account auth for automation; a user token
  present alongside SA credentials wins: https://docs.nebius.com/terraform-provider/authentication.
- Buckets accept resource-scoped access permits; custom groups may be created in a project
  (ADR-0005 evidence).
- Mocked plans: `terraform/live/foundation/tests`, `terraform/live/*/*/tests/stage.tftest.hcl`,
  the stage-policy runs in `terraform/stacks/*/tests`.

## Security and cost consequences
Blast radius per stage: a sandbox identity can touch sandbox state and the sandbox project only.
Costs separate by project, so a stage's budget alert is meaningful. The foundation needs an
administrator once; tenants that deny tenant-level IAM pass existing project IDs
(`create_projects = false`), which is the default.

## Failure modes and recovery
A stale live root (stack changed, roots not regenerated) fails CI, not an apply. A prod plan
with sandbox settings fails the stage policy before any credential is used. A stage whose
project quota is too small fails the apply mid-way, which the per-stack quota tables in
`docs/capacity.md` exist to prevent.

## Portability constraints
Stage = project is Nebius-specific; the stack/live split and the policy file are not.

## Review trigger
A fourth stage, a second region per stage, a stack that must span projects, or a Nebius provider
release that adds budgets or `prevent_destroy`-equivalent protection as resources.
