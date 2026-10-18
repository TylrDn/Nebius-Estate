# Change management

How a change travels from a branch to a customer-facing cluster, what each hop requires, and the
blast radius of each kind of change. The model is
[ADR-0009](decisions/0009-environment-and-promotion-model.md): a **stack** is promoted by applying the
*same module version* in the next **stage** with that stage's tfvars.

## The path

| Hop | Trigger | Gate | Who |
|---|---|---|---|
| branch → PR | open a PR against `main` | `make ci` (or `make ci-docker`) locally; CI runs the same targets in the toolbox image plus `soperator-check`, `scan` and `links`; review threads resolved | author |
| PR → sandbox | `make plan` → review → `make apply CONFIRM=yes` locally, or a pipeline dispatch from any ref | run and TTL labels, a written spend approval (CONTRIBUTING "Nothing billable without approval") | author |
| PR → `main` | merge (CI green) | reviewer approval; every thread resolved | reviewer |
| `main` → staging | **manual dispatch** of `.github/workflows/terraform.yml` from `main` (the gate refuses any other ref) | plan job (environment `staging-plan`, read-only state key, no state lock) writes the resource-change digest, counts and addresses to the job summary; apply job (environment `staging`) re-plans at the same commit, **refuses unless the digest matches**, then applies through `scripts/tf-run.sh`; `tests/validate` evidence in `docs/evidence/` | operator |
| staging → prod | **manual dispatch** from a release tag `vX.Y.Z` (the gate refuses branches) on the [self-hosted runner](#runners) | reviewers read the plan summary and digest (and, for attribute values, `make plan show-plan` at the same commit with their own credentials), then approve the `prod` environment (required reviewers, wait timer, tag-only rule); staging evidence from the **same commit**; CHANGELOG entry | release manager + reviewers |

Nothing is applied by a merge or a tag on its own: promotion is a deliberate dispatch, and the workflow's
`gate` job enforces which ref and which runner each stage accepts. The pipeline ships **disabled**
(`NIP_TERRAFORM_ENABLED` unset), so the repository never spends money by itself. The hop requirements are
also recorded in `platform/stages.yaml` → `promotion`.

**Why a digest and not the saved plan.** A saved plan embeds prior state and variable values, so it is
never uploaded as an artifact, and its text is not published either: the job summary holds the digest,
the counts per action and the resource addresses (`make plan-summary`), never attribute values, and the
plan step keeps its diff out of the log (`PLAN_LOG=false`). Reviewers approve that summary and a sha256
over the plan's resource changes (`make plan-digest`); to read values, run `make plan show-plan` at the
same commit with your own credentials. The apply job builds a fresh plan and stops if anything changed
in between (a merge, drift, a provider response). Dispatch again to review the new plan.

**Why the plan job takes no state lock.** The `<stage>-plan` environment holds a **read-only** state key
(`storage.object-viewer` on the bucket, foundation output `ci_plan_state_identities`), so a plan from any
ref the environment admits can read state but never rewrite it. A read-only key cannot write Terraform's
lock file either, so the plan job runs `make plan PLAN_LOCK=false`. That is a real gap, stated plainly: a
plan without the lock can read state while another run is writing it. The workflow's concurrency group
serialises its own runs per stage and stack; a run from elsewhere (a laptop) is not excluded. The apply
job closes the gap: it holds the read-write key, re-plans **under the lock** and refuses unless the digest
equals the approved one, so a plan computed from a torn read can never be applied.

**Scope.** The pipeline drives seven stacks, the `stack` choices of `.github/workflows/terraform.yml`:
`network`, `data`, `inference`, `training`, `gpu-vm`, `ml-services` and `governance` (`nvl` has no live
root until a stage raises `max_gpu_nodes.nvl`). Soperator (R4) stays outside the pipeline and the stage
policy: it is planned and applied locally with `make soperator-plan` and `make soperator-apply CONFIRM=yes`,
which fetch the recipe and run through `scripts/tf-run.sh`
([`stacks/soperator`](../terraform/stacks/soperator/README.md)). The foundation is applied once by an
administrator ([`terraform/README.md`](../terraform/README.md#foundation)); its state bucket is the one
resource with `prevent_destroy` (`terraform/modules/foundation/state-bucket/main.tf`), the stacks do not
use it ([`dr.md`](dr.md#where-prevent_destroy-is-used-and-where-it-is-not)). Recorded in ADR-0009's
2026-10-11 note.

## Dispatch inputs

| Input | Values | Effect |
|---|---|---|
| `stage`, `stack` | as above | the live root `terraform/live/<stage>/<stack>` |
| `action` | `plan` (default), `apply` | `apply` adds the approved apply job after the plan job |
| `runner` | `github-hosted` (default), `self-hosted` | see [Runners](#runners) |
| `run` | ticket or run id; empty → `gh-<run id>` | the `nip-run` label where the stage's sizing file does not set one |
| `ttl` | 1–24 hours (sandbox only) | the `nip-ttl-expires` label the sandbox policy requires |

The workflow writes the TTL label but does not schedule teardown. A successful apply can leave
billable resources running after expiry. Before enabling sandbox applies, assign an operator and
a durable cleanup process with credential renewal; a background process on an ephemeral GitHub
runner will not survive the job. The local [TTL safety net](../runbooks/teardown.md#safety-net-teardown-at-the-ttl)
also depends on its host and token lifetime and is not a durable CI scheduler.

## Runners

A GitHub-hosted runner reaches only public endpoints. Any stage whose cluster endpoint is private
(`public_endpoint: false` in [`platform/stages.yaml`](../platform/stages.yaml), today **prod**) must be
planned and applied from a **self-hosted runner in the cluster's subnet** (the docs allow private-endpoint
access only from a VM in the same region and subnet: [connect](https://docs.nebius.com/kubernetes/connect)); the gate refuses
`runner=github-hosted` for such a stage, because the Kubernetes and Helm providers could not reach the
API and the plan would fail half-way through refreshing in-cluster resources.

The self-hosted runner needs:

- the labels `self-hosted` and `nip-stage-vpc`, registered to this repository only;
- placement in the cluster's subnet (with R7: the workload subnet, not the edge subnet), with egress to the
  Nebius API, Object Storage, the container registries in `platform/versions.yaml` and GitHub;
- Docker on linux/amd64, since every step runs in the pinned toolbox image (`make ci-docker`);
- no other workloads and no other repositories: it holds the stage's CI credentials while a job runs.

Building the runner VM is not automated here; treat it as part of the stage's foundation and record it
in the CHANGELOG when the pipeline is enabled.

## Enabling the pipeline

Enabling it is itself a reviewed change (CONTRIBUTING "No apply from CI, no credentials in git"),
recorded in `CHANGELOG.md`:

1. Apply `terraform/live/foundation`; note the `ci_identities.<stage>` and `ci_plan_identities.<stage>`
   outputs and the state bucket.
2. Create two GitHub Environments per stage, `<stage>-plan` (no reviewers) and `<stage>` (apply).
   Both hold `NEBIUS_TENANT_ID`, `NEBIUS_PROJECT_ID`, `NIP_STATE_ACCESS_KEY_ID` and
   `NIP_STATE_SECRET_ACCESS_KEY`, but **not the same state key**: `<stage>-plan` holds a key of the
   read-only state account (`ci_plan_state_identities.<stage>`, `storage.object-viewer`), `<stage>` a key
   of the read-write one (`state_identities.<stage>`, `storage.object-editor`)
   ([rotation runbook](../runbooks/credential-rotation.md#rotating-the-ci-state-access-keys)). The CI
   identity differs too: `<stage>-plan` holds the plan account
   (`ci_plan_identities.<stage>`, `viewer`) and `<stage>` the apply account (`ci_identities.<stage>`,
   `editor`), each as `NIP_SA_ID` plus, on the key path, `NIP_SA_KEY_ID` and `NIP_SA_PRIVATE_KEY`.
   On the federated path (R13, foundation `ci_federation`) an environment holds `NIP_SA_ID` only and
   the job swaps its GitHub OIDC token for a Nebius token ([`runbooks/identity.md`](../runbooks/identity.md)).
   Variables: `NEBIUS_REGION`; where the stage needs an allowlist, `NIP_ALLOWED_CIDRS` (a JSON list of
   real egress CIDRs; documentation ranges are refused); `NIP_SUBNET_ID` (the project's default subnet
   or R7's `subnet_id`: the stacks have no default subnet name); for R10 `NIP_SSH_PUBLIC_KEY` (a public
   key, not a secret; exported for `STACK=gpu-vm` only, because on a cluster stack it would become a
   `NOPASSWD` sudo user on every node). Each is exported as its `TF_VAR_*` only when set
   ([security](security.md)).
   With R7, set `NIP_SERVICE_CIDR` to the network root's `service_cidr` output and
   `NIP_SECURITY_GROUP_IDS` to its `security_group_ids` output as a JSON list, together with
   `NIP_SUBNET_ID`. The service range is forwarded to inference/training; security groups to
   inference/training/gpu-vm. Passing only the R7 subnet leaves the Kubernetes default service
   range too large and omits the intended workload security groups. Set the same values in both
   plan and apply Environments, and check sizing files for overrides (`*.auto.tfvars` outrank
   `TF_VAR_*`). For inference/training, `NIP_NODE_SERVICE_ACCOUNT_ID` forwards an existing node
   pull identity. The live ml-services sizing files disable node IAM creation so the editor CI
   account does not need admin; provision that identity separately and follow
   [the R12 handoff](../runbooks/ml-services.md#before-you-start).
3. The state keys are long-lived environment secrets: create each with an expiry and rotate them with
   the CI key ([`runbooks/credential-rotation.md`](../runbooks/credential-rotation.md)).
4. Deployment rules mirroring the gate: `staging`/`staging-plan` → branch `main` only;
   `prod`/`prod-plan` → tags `v*.*.*` only. `prod`: required reviewers (not the dispatcher) and a wait timer.
   `sandbox-plan` and `sandbox` admit any ref by design (the gate does too). Because `sandbox-plan` has no
   reviewers, anyone who can push a branch can run a sandbox plan as the sandbox `viewer` account with the
   read-only state key: it can read the sandbox project and its state, never change them. If that is too
   wide for your team, add a deployment branch rule on `sandbox-plan` (for example `main` and
   `sandbox/*`) and the same pattern on `sandbox`.
5. For prod, register the [self-hosted runner](#runners).
6. Set a budget alert per stage project ([cost](cost.md#spend-controls), control 9), then set the
   repository variables `NIP_STATE_BUCKET` and `NIP_TERRAFORM_ENABLED=true`.

## What may differ between stages

Size, capacity type, exposure and protection flags: `terraform/live/<stage>/<stack>/<stage>.auto.tfvars`
and the [stage policy](../platform/README.md#stage-policy). What may **not** differ: the stack's module
graph, provider versions, chart versions and images (`platform/versions.yaml`). A fix that only works in
one stage is a fix to the stack, not to the stage.

## Kinds of change and their blast radius

| Change | Example | Rolls nodes? | Downtime | Rehearse in |
|---|---|---|---|---|
| Sizing | `gpu_node_count`, `cpu_node_count`, `gpu_autoscaling` bounds | no (scale only) | none | sandbox |
| Node template | SSH key, cloud-init, filesystem attachment, taints, node labels, `drivers_preset`, preset, boot disk | **yes, every node in the group**: cordon, drain, delete, create, one at a time (`max_unavailable` 1, `max_surge` 0, 10-min drain); `gpu_rollout_surge = true` creates the replacement first and needs quota for one extra GPU node | a single-GPU group loses its GPU node for the duration; serving loses one replica per node | staging |
| Kubernetes version | `k8s_version` | **yes**: one `k8s_version` goes to the control plane and every node group, so the same apply upgrades the control plane and rolls every group | API blips during the control-plane upgrade, then as a template change | staging, per [`runbooks/upgrade.md`](../runbooks/upgrade.md) |
| Platform layer | chart or Marketplace release version | no; pods restart | brief o11y/CSI gaps | staging |
| Policy | `platform/stages.yaml` | no | none, but every stage re-plans | `make policy` + mocked tests |
| Workload | overlay image, model or engine args | no; new ReplicaSet | one replica rebuild (`Recreate`), or none with the prod overlay's `RollingUpdate` when capacity allows | sandbox |

Reverting a template change is another full replace. For a group you cannot afford to replace in place:
create a new group with the corrected template, drain the old one, then remove it; never switch an existing
GPU group between driver paths ([ADR-0003](decisions/0003-gpu-driver-ownership.md)).
After the drain timeout (default 10 minutes, [deployment strategy](https://docs.nebius.com/kubernetes/node-groups/manage#deployment-strategy-and-quotas))
a node is force-drained and deleted, so checkpoint long training jobs first or set the module's
`strategy.drain_timeout`. The provider reference says taint and node-label edits reach only nodes created
afterwards, while the MK8s docs describe any template edit as a rolling update: plan for the replace.

## Rules

1. One PR per change kind; a sizing change does not ride with a template change.
2. A human reviews the plan before every apply, in every stage: the saved plan locally
   ([`runbooks/deploy.md`](../runbooks/deploy.md)), the summary and digest in the pipeline. `scripts/tf-run.sh`
   refuses a saved plan older than 10 hours.
3. Roll back by re-applying the previous module version with the same tfvars
   ([`runbooks/rollback.md`](../runbooks/rollback.md)); never by editing state.
4. Record what changed in prod in `CHANGELOG.md` under the release tag.
