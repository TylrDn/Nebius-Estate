# Teardown checklist

Sandbox and staging, one stack at a time, in reverse deploy order: clusters (`inference`,
`training`, Soperator) → `data` → `network`. Prod: [Prod](#prod) below; `make destroy` refuses it.

- [ ] Data that must outlive the run exported first: checkpoints and datasets from the R8 buckets,
      anything only on the shared filesystem ([`data.md` → Teardown](data.md#teardown)).
- [ ] Required results saved outside the cluster (`results/*.json` scrubbed into
      `results/<date>/` with `scripts/scrub-evidence.py`, `docs/evidence/<date>-<stage>-<stack>-<what>.md`).
- [ ] Login fresh: `nebius iam get-access-token --no-browser --auth-timeout 90s` (a destroy that
      reuses a dead token fails half-way; `scripts/tf-run.sh` checks this).
- [ ] Workload PVCs deleted first when a cluster is being destroyed:
      `kubectl delete pvc --all -n inference` (and any namespace that created block PVCs).
      PVCs backed by `compute-csi` disks — Prometheus's volume, anything on the default
      class before the CSI driver was installed — are created by Kubernetes, carry **no labels**,
      and **outlive `terraform destroy`**.
- [ ] `make destroy-plan` reviewed — never delete shared customer resources; the plan must not
      touch anything outside this stage and stack's labels. It first runs
      `scripts/destroy-providers-override.sh`, which pins the Kubernetes-side providers for the plan
      ([below](#in-cluster-resources-and-the-provider-override)); an expired `nip-ttl-expires` does not
      block it ([below](#an-expired-ttl-does-not-block-teardown)).
- [ ] `make destroy CONFIRM=yes` (one Ctrl-C forwards a SIGINT and waits; never kill it: [run safety](incident.md#terraform-run-safety)).
      On success it removes `zz_destroy_override.tf`; after a failed destroy the file stays for the retry.
- [ ] One stack: `make leftovers STACK=<stack>` with `NEBIUS_PROJECT_ID` set to the stage's project (`make leftovers`
      ignores `STAGE`, `Makefile:229-230`; `scripts/leftovers.sh:13`) (`scripts/leftovers.sh --stack <stack>`, a report
      that never fails) shows this stack's labelled clusters, node groups, instances, disks, filesystems, GPU
      clusters, NVL instance groups (R15), MLflow and PostgreSQL clusters and Container Registries (R12),
      buckets, transfers and public IPs, plus every unlabelled CSI `pvc-*` disk and GPU cluster in the project — those carry no stack label, so check which
      belong to the stack you destroyed before deleting. Other stacks in the stage are expected to remain.
- [ ] Whole stage retired (every stack destroyed): `make leftovers-stage STAGE=<stage>` (`--stage <stage>
      --expect-empty`) must print nothing — it lists everything in the stage's project, labelled or not (every
      disk, whatever its name), and fails otherwise; use it as the gate. Delete deliberately what it lists (`nebius compute disk delete --id ...`); the
      state bucket is excluded on purpose.
- [ ] Local leftovers removed: `.cache/kubeconfig-<stage>-<stack>`, and in `terraform/live/<stage>/<stack>/` the saved `<stage>-<stack>.tfplan` and `destroy.tfplan`, the rendered run profile `.run-profile.tfvars.json` (`make plan PROFILE=...`),
      and `zz_destroy_override.tf` if it is still there (`make destroy` removes it only after a successful destroy;
      `scripts/destroy-providers-override.sh --dir <root> --remove` deletes it, never a hand-written file of that name).
- [ ] Actual spend recorded in `docs/evidence/<date>-<stage>-<stack>-<what>.md`.

## Safety-net teardown at the TTL

A sandbox run that should end on its own schedules the teardown when it applies:

```bash
make ttl-teardown STAGE=sandbox STACK=inference DRY=1        # prints the UTC time and the delay
make ttl-teardown STAGE=sandbox STACK=inference CONFIRM=yes  # schedules it (cancel: kill the printed pid)
```

The expiry is `TTL=<YYYY-MM-DDTHH:MM:SSZ>` when given, else the `nip-ttl-expires` of the rendered run
profile (`make plan PROFILE=...`), else the one in `TF_VAR_labels`. It is parsed as UTC whatever the local `TZ`
(`scripts/lib-time.sh`; on 2026-10-11 macOS `date -j -f` read the label as local time and the teardown
started late, [evidence](../docs/evidence/2026-10-11-sandbox-inference-populate.md)). At that time the job
runs `make destroy-plan` and `make destroy CONFIRM=yes` for that root, with the IAM token of the shell
that scheduled it (12 h). The destroy plan gets the inputs the run was planned with: `PROFILE=<name>` when
given to `make ttl-teardown`, else the root's rendered `.run-profile.tfvars.json` (`RUN_PROFILE=1`, passed
as `-var-file`) when one exists. Schedule from a fresh login, and still run the checklist above afterwards.
The log is `terraform/live/<stage>/<stack>/.terraform/ttl-teardown.log`. `tests/scripts/test-ttl-teardown.sh`
covers the time arithmetic under several local time zones.

This is a background process on the machine that starts it. A reboot, runner shutdown or expired
token can prevent deletion, and a TTL longer than the remaining token lifetime is not covered.
The manual GitHub Terraform workflow sets expiry labels only and never starts this process.
Neither the label nor a passing offline test proves autonomous cleanup. An operator must arrange
durable scheduling with credential renewal and confirm the teardown checklist after expiry.

## A running root near its TTL

The portal alert `TtlExpiresSoon` (`platform/alerts/portal/fleet.yaml`) fires when a root (stage, stack and run)
still has running resources and its earliest `nip-ttl-expires`, own or inherited from the cluster, is less than
six hours away. It is a reminder, not a teardown: nothing happens at the TTL unless a safety-net teardown was
scheduled (above), and an expired TTL only makes the root refuse a new `make plan`.

Checks (read-only):

1. Estate Explorer, quick view "TTL expired" and the root's resources: which ones run, and the TTL each carries.
2. `terraform/live/<stage>/<stack>/.terraform/ttl-teardown.log`: is a safety-net teardown scheduled, and for when?
3. Is the run's work saved (results, evidence, checkpoints in object storage)?

Then either let it end (save the results first; tear down with the checklist above), or extend it: set a new
`nip-ttl-expires` (RFC 3339 UTC, at most 7 days after the plan, `docs/cost.md`) in the run profile or
`TF_VAR_labels`, then `make plan` and `make apply` for the root, and reschedule `make ttl-teardown` if one was
scheduled. The portal never changes a label.

## In-cluster resources and the provider override

The `inference` and `training` live roots configure `helm`, `kubernetes` and `kubectl` from
`module.stack.k8s_host` and `module.stack.cluster_ca_certificate`, which come from the cluster
resource's `status`. In a destroy plan Terraform treats the cluster as being destroyed, so both
evaluate to null and the providers fall back to `http://localhost`. As soon as the state holds an
in-cluster resource (`helm_release.csi` and the two `kubernetes_annotations` of the filestore CSI
module, for example) the plan's refresh fails:

```
Error: Get "http://localhost/api?timeout=32s": connection refused
```

(seen on `live/sandbox/inference` on 2026-10-11; a state with only the cluster and node groups
plans fine). `make destroy-plan` therefore runs `scripts/destroy-providers-override.sh` first. It
reads `terraform show -json` (the root's current state) and, only when that state has a
`nebius_mk8s_v1_cluster` **and** any `helm_*`/`kubernetes_*`/`kubectl_*` resource, writes
`zz_destroy_override.tf` (mode 600, git-ignored by `*_override.tf`) whose provider blocks carry the
endpoint and the CA PEM inline (an override file cannot add locals) and keep `token = var.iam_token`.
Otherwise it writes nothing and removes a stale file it wrote before.

- **Endpoint:** the one the stack used: the state's `public_endpoint_enabled` output decides, else
  the public endpoint when present, else the private one. A private endpoint (prod's policy, or
  `public_endpoint = false`) is reachable only from inside the cluster's VPC, so the destroy plan must
  run from a bastion or the self-hosted runner; the script prints a note when it picks it.
- **By hand**, outside `make`: `scripts/destroy-providers-override.sh <stage> <stack>` before
  `terraform plan -destroy`, and `--remove` after the destroy.
- **The cluster is already gone but in-cluster resources remain in state** (a destroy that failed
  half-way after deleting the cluster): there is no endpoint to pin. `terraform state rm` those
  addresses deliberately (they went with the cluster), then re-plan.

## An expired TTL does not block teardown

The sandbox rule `ttl_window` (`modules/stage-policy`: `nip-ttl-expires` in the future and at most
7 days ahead of `plantimestamp()`) is asserted by each stack's `terraform_data.stage_policy`
precondition. Terraform 1.16 does not evaluate resource preconditions in a destroy plan or its
apply, so a root whose TTL has passed refuses `make plan` but still plans and applies its destroy.
`tests/scripts/test-ttl-destroy.sh` (in `make selftest`) proves both with the real module and an
expired label. To change anything else about such a root, set a new expiry first (`docs/cost.md`).

## Soperator (`stacks/soperator`)

The recipe's own destroy needs `python3 >= 3.11`, the `nebius` CLI and `kubectl` on the host
(its cleanup deletes the controller spool PVC disk, which is CSI-created and unlabelled).
Outside prod: `make soperator-destroy-plan STAGE=<stage>`, review it, then
`make soperator-destroy STAGE=<stage> CONFIRM=yes` (the plan's var files and keys, through
`scripts/tf-run.sh`); `make ttl-teardown STAGE=<stage> STACK=soperator TTL=<UTC> CONFIRM=yes` schedules
both at the run's expiry, since the recipe sets no `nip-ttl-expires` label. In a stage with
`require_ttl_label` (`sandbox`, `lab`) `make soperator-apply` refuses until that job is running
(`scripts/ttl-armed.sh` reads its `.terraform/ttl-teardown.pid`), so schedule it before the apply.
After the destroy: run `scripts/leftovers.sh`, remove the kube
context `nebius-nip-slurm` the recipe wrote into `~/.kube/config`
(`kubectl config delete-context nebius-nip-slurm`), and delete `login.sh` from the working copy.
A filesystem with `forbid_deletion = true` must be `terraform state rm`'d before destroy and
deleted (or kept) deliberately afterwards, as in [Prod](#prod) step 4.

## Prod

Prod is never destroyed from a laptop: `make destroy-plan`/`destroy` refuse `STAGE=prod`, and the
pipeline has no destroy action. Retiring a prod stack is a change like any other, through the
release process ([`docs/change-management.md`](../docs/change-management.md)): a ticket, a release
tag, named reviewers, and the run on the self-hosted runner inside the prod VPC (the cluster
endpoint is private).

1. **Decide and record.** Change ticket with the stacks to retire, the data owner's sign-off, the
   export destination and a rollback statement ("rebuild from the tag" is valid only if the data
   is exported). Announce a freeze: no deploys to the stack from here on.
2. **Export data first.** Copy the checkpoint and dataset buckets (current versions, and the
   noncurrent ones you are obliged to keep) and anything that lives only on the shared filesystems
   to the agreed destination; verify object counts and sizes on both sides and attach the
   evidence to the ticket. Nothing below is reversible.
3. **Stop the workloads.** Scale serving to zero, let training jobs checkpoint and finish, delete
   workload PVCs (`kubectl delete pvc --all -n <ns>`): CSI-created disks outlive the cluster.
4. **Release the `forbid_deletion` resources, reviewed.** Each prod filesystem (the stack's own,
   and R8's) carries API-level deletion protection that the stage policy keeps on, so the destroy
   plan cannot remove it. For each, in the reviewed change:
   - `terraform -chdir=terraform/live/prod/<stack> state rm '<filesystem address>'` (the address
     from `terraform state list`), so the destroy plan no longer contains it;
   - after the export is verified: `nebius compute filesystem update --id <id> --forbid-deletion=false`
     ([deletion protection](https://docs.nebius.com/compute/storage/manage#how-to-enable-or-disable-deletion-protection)),
     then `nebius compute filesystem delete --id <id>`; or keep it on purpose and record its id
     in the ticket.
5. **Destroy in reverse deploy order** (clusters, then `data`, then `network`), each with the prod CI
   identity on the self-hosted runner: `scripts/destroy-providers-override.sh prod <stack>` (a cluster
   stack with in-cluster resources needs it; prod's endpoint is private, which is why this runs on that
   runner), `terraform -chdir=terraform/live/prod/<stack> plan -destroy -out=destroy.tfplan`, reviewers read
   the plan, then `scripts/tf-run.sh terraform/live/prod/<stack> destroy.tfplan` and
   `scripts/destroy-providers-override.sh prod <stack> --remove`. One stack per approval.
6. **Gate on residue.** `make leftovers-stage STAGE=prod` must print nothing (the state bucket is
   excluded); it lists unlabelled residue too. The state bucket has `prevent_destroy` and keeps the
   history: delete it only when the whole stage is retired, by an administrator, as a separate
   ticket.
7. **Close out.** Revoke the stage's CI keys and environment secrets
   ([`credential-rotation.md`](credential-rotation.md#revocation)), disable the `prod` and
   `prod-plan` environments, record final spend in `docs/evidence/`, and add a CHANGELOG entry.
