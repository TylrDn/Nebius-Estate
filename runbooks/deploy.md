# Deploy runbook

The one deploy sequence: prerequisites, then the sandbox inference stack end to end, then what
changes for training, Soperator, staging and prod. All commands run from the repository root;
`make` acts on `terraform/live/$(STAGE)/$(STACK)` and defaults to `STAGE=sandbox STACK=inference`.

## Prerequisites

- [ ] A Nebius tenant and a project per stage, with an `admin` who can change quotas and IAM
      (or the foundation applied: [`terraform/README.md`](../terraform/README.md#foundation)).
- [ ] Quotas requested for the stack and stage: [`docs/capacity.md`](../docs/capacity.md#quotas-per-stack).
      `eu-north1` grants 0 non-GPU vCPU by default; until it is raised, deploy with `cpu_node_count = 0`
      (the GPU node then hosts the system add-ons; [stack inputs](../terraform/stacks/inference/README.md)):
      see [GPU-only sandbox](#gpu-only-sandbox-cpu_node_count--0) below.
- [ ] Estimate filled in and a **written spend approval** recorded in the ticket:
      [`docs/cost.md`](../docs/cost.md#estimate-worksheet).
- [ ] Tools installed: [`CONTRIBUTING.md`](../CONTRIBUTING.md#local-tooling); `make ci` green.
- [ ] `NEBIUS_TENANT_ID`, `NEBIUS_PROJECT_ID`, `NEBIUS_REGION` exported, and
      `nebius iam get-access-token --no-browser --auth-timeout 90s` succeeds (user tokens last ~12 h;
      a login that expires mid-apply fails the apply).

## First serving-only sandbox

After prerequisites and explicit spend approval, use `PROFILE=l40s-serving` for the first
inference plan and apply sequence below. Pass the same profile to `preflight`, `plan` and
`destroy-plan`. It renders one preemptible L40S, no CPU nodes, a 64 GiB filesystem and
**no optional observability**. The shape is based on the October 13 retry, not a new
live validation of the current code. Check current quota/capacity before planning.

The full observability path previously hung on an Alertmanager PVC that inherited the
filesystem StorageClass. The module now selects block storage explicitly, but that change
still needs a separately approved live acceptance run. The pinned Nebius release resource
does not expose a custom installation timeout; do not add an unsupported `timeouts` block
or force-kill Terraform. Use [run safety](incident.md#terraform-run-safety) on interruption.
Enable optional observability only as a subsequent reviewed change after serving works.

Start workload validation without `WITH_LOAD=1`. The in-cluster load generator downloads a
tokenizer and previously failed reaching Hugging Face. If it fails, retain that failure;
do not report the serving deployment as benchmarked or claim in-cluster latency. A working
operator-host fallback is documented in [the load method](../tests/load/README.md#operator-host-fallback).
It uses a different measurement vantage and needs separate results.

## Sandbox inference, end to end

| # | Command | Expect |
|---|---|---|
| 1 | `source scripts/bootstrap-backend.sh sandbox inference` | `TF_VAR_iam_token`, a versioned state bucket, a 1-day state key and `terraform/live/sandbox/inference/backend.hcl` ([state and auth](../terraform/README.md#remote-state)) |
| 2 | `export TF_VAR_labels='{"nip-owner":"platform","nip-run":"<ticket>","nip-ttl-expires":"<RFC 3339 UTC>"}'` | the sandbox plan fails without `nip-run` and `nip-ttl-expires` ([labels](../docs/cost.md#required-labels)); the stack sets `nip-stage`, `nip-region` and `nip-stack` itself, and `nip-env` is deprecated ([naming §5](../docs/naming.md#5-labels)) |
| 3 | `make init` | backend initialised against the stage bucket |
| 4 | `make preflight`, then `make plan` (with a run profile: both with `PROFILE=<name>`) | preflight prints `GO`: key expiries, this plan's quota demand against the effective limits, the capacity advice for the GPU shape, region/platform and spot-cap pairs, stage caps and the TTL ([below](#preflight)); then `sandbox-inference.tfplan` and a `Plan:` line. Review: the cluster, `-ng-cpu` (`cpu_node_count` nodes, 2 in `sandbox.auto.tfvars`; absent when it is 0, [below](#gpu-only-sandbox-cpu_node_count--0)), `-ng-gpu` (1 node, only when `gpu_node_count > 0`; tainted `nvidia.com/gpu` only when CPU nodes exist), the shared filesystem, the CSI Helm release and the Marketplace releases (device plugin, Prometheus/Grafana, Nebius agent); nothing outside the stage's project |
| 5 | `make apply CONFIRM=yes` | runs `scripts/tf-run.sh`: refuses a plan older than 10 h, re-checks the login, forwards one Ctrl-C and waits. **Never kill an apply** ([run safety](incident.md#terraform-run-safety)); if it fails half-way, fix the cause and `make plan` again |
| 6 | `make kubeconfig`, then the printed `export KUBECONFIG=…` | `.cache/kubeconfig-sandbox-inference`; `~/.kube/config` is never touched |
| 7 | `tests/validate/00-nodes.sh`, `01-gpu.sh`, `02-interconnect.sh`, `03-storage.sh`, in order | each prints and writes `results/<step>.json` with `"status": "pass"` (`tests/validate/lib.sh` `record`) and exits 0; stop at the first `fail`. Pass conditions per step: [`tests/README.md`](../tests/README.md). If `01-gpu.sh` finds 0 allocatable `nvidia.com/gpu`: [troubleshooting](../docs/solutions/troubleshooting.md), [`incident.md`](incident.md) |
| 8 | `kubectl apply -k workloads/inference/overlays/qwen2.5-1.5b` and `kubectl -n inference rollout status deploy/vllm --timeout=15m` | first start downloads the model into the shared filesystem ([`workloads/inference`](../workloads/inference/README.md)) |
| 9 | `make validate-cluster` first; opt into `WITH_LOAD=1` only when the load generator's tokenizer egress is available | inspect each status in `results/summary.json`; a skipped load step is not a passing performance benchmark. A load run additionally writes `results/05-load.json` |
| 10 | record `docs/evidence/<date>-sandbox-inference-validate.md` | results, versions from [`docs/compatibility-matrix.md`](../docs/compatibility-matrix.md), actual spend ([template](../docs/evidence/README.md)) |
| 11 | `make destroy-plan` (with `PROFILE=<name>` when step 4 planned with a run profile, so the destroy plan sees the same inputs), `make destroy CONFIRM=yes`, `make leftovers STACK=inference` (the project is `NEBIUS_PROJECT_ID`; `make leftovers` reads only `STACK`, `Makefile:229-230`) | residue report lists nothing for `inference` (and no `pvc-*` disk or GPU cluster it created); retiring the whole sandbox: `make leftovers-stage STAGE=sandbox` prints nothing ([`runbooks/teardown.md`](teardown.md)) |

### Preflight

`make preflight STAGE=<stage> STACK=<stack> [PROFILE=<name>]` (`scripts/preflight.py`) runs before every
plan and prints one line per check, then `GO` or `NO-GO` (exit 1):

| Check | Refuses when |
|---|---|
| `keys` | `scripts/env-status.sh --live` fails, or a CI key in [`platform/ci-keys.yaml`](../platform/ci-keys.yaml) has expired (warns 14 days ahead) |
| `region-platform` | the region or the GPU platform is not a pair in `platform/regions.yaml` (an unlisted preset warns) |
| `spot-cap` | a spot price cap is asked for on a pair without `spot_price_cap: true` |
| `stage-caps` | GPU nodes above `max_gpu_nodes`, or preemptible nodes where the stage forbids them (`platform/stages.yaml`) |
| `ttl` | sandbox without `nip-run`, or `nip-ttl-expires` past or more than 7 days ahead |
| `quota` | this plan needs more of a quota than its effective limit in the region leaves: min(tenant limit, the project's real cap), less the usage the allowance reports; the line names the quota, demand and limit, and the fix (request from Nebius, or align the cap with `scripts/quota-plan.py --plan-align`). Every other `quota-plan.py` finding (caps below the tenant, tenant zeros for quotas this plan does not need) and every quota it cannot derive or the service does not list (`not checked`) warns |
| `capacity` | the capacity advice for the platform, preset and offer is `LIMIT_REACHED` or below the node count (no advice, or none for that offer, warns; skipped with `gpu_node_count = 0`) |

It resolves the inputs as Terraform does (variable defaults, `TF_VAR_*`, `<stage>.auto.tfvars`, the
profile; `--set name=value` for a what-if). The quota demand comes from those inputs, with the arithmetic of
[`docs/capacity.md`, Quotas per stack](../docs/capacity.md#quotas-per-stack): GPUs by model, preemptible
VMs, non-GPU vCPU (CPU nodes, NAT and bastion VMs), VMs, Network SSD disk and filesystem sizes, MK8s
clusters, a GPU cluster only for training with GPU nodes, public addresses and buckets; stacks without a
model (`soperator`, `governance`, `ml-services`, `nvl`) warn `not checked`. The allowances are read with
`scripts/quota-plan.py --json` for the target project (`TF_VAR_parent_id`, else `NEBIUS_PROJECT_ID`);
`make quota-check` stays the tenant-wide audit (`--strict` exits 3 on any cap or zero). `OFFLINE=1` makes no cloud call and says that quota and
capacity were not checked; `FIXTURES=<dir>` reads them from recorded files
(`tests/scripts/fixtures/preflight`, used by `tests/scripts/test-preflight.sh`). The advice needs
`NEBIUS_TENANT_ID` and a tenant-level read role; without them it warns.

Optional, before step 11: the rollback drill ([`runbooks/rollback.md`](rollback.md)).

### GPU-only sandbox (`cpu_node_count = 0`)

For a project whose non-GPU vCPU quota is 0 (the `eu-north1` default). `sandbox.auto.tfvars` sets
`cpu_node_count = 2`, and Terraform gives `*.auto.tfvars` files precedence over `TF_VAR_*` environment
variables, so `export TF_VAR_cpu_node_count=0` is silently overridden. Plan with the committed run profile
instead; a `-var-file` on the command line wins over the auto files (Terraform's documented variable
precedence):

```bash
python3 scripts/run-profile.py --list                                  # committed profiles
make plan STAGE=sandbox STACK=inference PROFILE=l40s-gpu-only RUN=<ticket>   # TTL_HOURS=<1-24>, default 3
```

[`platform/profiles/inference/l40s-gpu-only.json`](../platform/profiles/inference/l40s-gpu-only.json) is
the shape of the 2026-10-11 runs: `gpu-l40s-a` / `1gpu-8vcpu-32gb` × 1, preemptible, `cpu_node_count = 0`,
64 GiB shared filesystem ([populate evidence](../docs/evidence/2026-10-11-sandbox-inference-populate.md),
Method). `scripts/run-profile.py` renders it with `nip-run` (`RUN=`, else `<profile>-<UTC time>`) and
`nip-ttl-expires` (now + `TTL_HOURS`, UTC) added to `TF_VAR_labels`, into the git-ignored
`terraform/live/sandbox/inference/.run-profile.tfvars.json`; `make plan` passes it as `-var-file`, and
`make destroy-plan PROFILE=l40s-gpu-only` reuses it. Step 2 is then not needed. Nothing is auto-loaded, so
a later plan without `PROFILE` does not inherit it (the git-ignored `zz-run.auto.tfvars.json` of the
2026-10-11 runs did). `tests/scripts/test-run-profile.sh` proves the rendered inputs; the mocked plan
`run_profile_l40s_gpu_only_plans_in_sandbox` (`terraform/stacks/inference/tests/lab.tftest.hcl`) proves they
pass the sandbox policy. Schedule the safety-net teardown at the TTL with `make ttl-teardown`
([teardown](teardown.md#safety-net-teardown-at-the-ttl)).

- **Expect at step 4:** 12 creates, no CPU node group, an untainted GPU node group (as planned and
  applied on 2026-10-11: `Resources: 12 added`, [populate evidence](../docs/evidence/2026-10-11-sandbox-inference-populate.md),
  Results). The stack drops the CPU module and the GPU taint when `cpu_node_count = 0`
  (`terraform/stacks/inference/main.tf:36`, `:133-136`; tests `zero_cpus_create_no_cpu_node_group_and_untaint_gpu`
  and `cpu_nodes_keep_the_gpu_taint` in `tests/lab.tftest.hcl`).
- **At step 7:** `nvidia.com/gpu` allocatable = 1 on the single node, taints 0. A tainted GPU node with
  no CPU node showed 0 allocatable on the earlier 2026-10-11 run ([troubleshooting](../docs/solutions/troubleshooting.md)).
- **After the run:** delete `.run-profile.tfvars.json` with the other local leftovers ([teardown](teardown.md)).

Any later change to a node group's template (SSH key, filesystem, taints, labels, boot disk, drivers
preset, preset, instance metadata labels) replaces every node in it, one at a time with a 10-minute
drain; scaling a count does not. Checkpoint first: [blast radius](../docs/change-management.md#kinds-of-change-and-their-blast-radius),
[upgrade](upgrade.md). A regular GPU group without `gpu_reservation` is sent `reservation_policy = FORBID`
so it never draws on a capacity block group by accident ([capacity types](../docs/capacity.md#capacity-types)).

## Training stack (`STACK=training`)

Same steps with `source scripts/bootstrap-backend.sh sandbox training` and `make … STACK=training`.
The root plans with `gpu_node_count = 0`: the first apply creates the CPU layer and **no GPU
cluster**. After a separate spend approval and GPU-cluster quota ≥ 1, set `gpu_node_count = 2`
in `terraform/live/sandbox/training/sandbox.auto.tfvars`, `make plan STACK=training` (expect
exactly two 8-GPU nodes and one GPU cluster added), apply, `make kubeconfig STACK=training` and export the printed `KUBECONFIG`, install the Kubeflow Training
Operator (`workloads/training/install-training-operator.sh`: the `MPIJob`/`PyTorchJob` CRDs the NCCL and DDP
jobs need), then `tests/validate/run-training.sh`.
Set it back to 0 and apply before keeping the control plane between runs. Details:
[`stacks/training`](../terraform/stacks/training/README.md), [`runbooks/capacity-request.md`](capacity-request.md).

## Soperator (`stacks/soperator`)

The upstream recipe at the pinned tag, driven through `make`:
`source scripts/bootstrap-backend.sh <stage> soperator`, then `make soperator-plan STAGE=<stage>`
(fetches the recipe, writes the stage backend, saves `soperator-<stage>.tfplan`; prod also needs
`MR_URL=<merge request url>`) and, after review, `make soperator-apply CONFIRM=yes STAGE=<stage>`
(through `scripts/tf-run.sh`, like every apply). In `sandbox` and `lab` (`require_ttl_label`) the apply
refuses until `make ttl-teardown STAGE=<stage> STACK=soperator TTL=<UTC> CONFIRM=yes` is running: the
recipe sets no `nip-ttl-expires` label ([teardown](teardown.md#soperator-stackssoperator)). Recipe details: [`stacks/soperator`](../terraform/stacks/soperator/README.md)
and `terraform/live/<stage>/soperator/README.generated.md`; jobs: [`runbooks/soperator-jobs.md`](soperator-jobs.md).

## Private network and data plane (`STACK=network`, `STACK=data`)

Optional, and deployed **before** the cluster they serve: network (R7) → data (R8) → inference or
training. The cluster root takes their outputs through `TF_VAR_subnet_id`,
`TF_VAR_security_group_ids` and `TF_VAR_existing_filesystem_id`. Steps, verification and
teardown: [`network.md`](network.md), [`data.md`](data.md).

## Staging and prod

The same module version applied through `terraform/live/staging/<stack>` (dispatched from
`main`) and `terraform/live/prod/<stack>` (dispatched from a release tag, required reviewers),
each with its own project, state bucket and identities. The stage policy is enforced at plan
time ([Stage policy](../platform/README.md#stage-policy)); `make destroy` refuses `STAGE=prod`. Prod serving
uses the `workloads/inference/overlays/qwen2.5-7b-prod` overlay (`RollingUpdate`, one replica per GPU node).
Path, gates and enabling the pipeline: [`docs/change-management.md`](../docs/change-management.md).
