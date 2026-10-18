# ML services runbook — R12 registry, MLflow, PostgreSQL

Create the stage's Container Registry and node pull identity, optionally a Managed MLflow tracking
server and a Managed PostgreSQL database, wire them into R1/R3, rotate their passwords, restore the
database, and remove it all. The stack is
[`terraform/stacks/ml-services`](../terraform/stacks/ml-services/). First live run:
[2026-10-11](../docs/evidence/2026-10-11-sandbox-ml-services-live-recipe.md) (services up and destroyed; validate
checks still open).

Upstream references: [pull images in MK8s](https://docs.nebius.com/kubernetes/workloads/images-container-registry),
[registry authentication](https://docs.nebius.com/container-registry/authentication),
[MLflow quickstart](https://docs.nebius.com/mlflow/quickstart),
[PostgreSQL connect](https://docs.nebius.com/postgresql/databases/connect),
[PostgreSQL backups](https://docs.nebius.com/postgresql/backups),
[services per region](https://docs.nebius.com/overview/regions#availability-of-services-per-region).

## Before you start

- Region: MLflow only in `eu-north1`, `eu-west2`, `me-west1`, `uk-south1`, `us-central1`;
  PostgreSQL only in those plus `eu-west1`. The plan names the allowed regions if you are elsewhere.
- Quotas per region: 10 clusters, 80 vCPU, 320 GiB RAM per service; Network SSD 1.95 TiB (MLflow) and
  2 TiB (PostgreSQL); 10 registries (0 in `eu-north2`). Check with
  [quotas](https://docs.nebius.com/overview/quotas#view-quotas) before a prod apply.
- The project's `mlflow-sa` exists (created at signup;
  [create MLflow](https://docs.nebius.com/mlflow/clusters/manage)), or set `mlflow.service_account_id`.
- Creating service accounts, groups and access permits needs `admin` in the project; the stage's
  apply identity has `editor`, so the first apply of this stack that creates the node identity is run
  by an administrator, or with `create_node_service_account = false`
  ([custom groups](https://docs.nebius.com/iam/authorization/groups/manage#prerequisites)).

The sandbox, staging and prod live sizing files set `create_node_service_account = false` so
the manual workflow's editor identity can deploy the default registry without changing IAM.
The standalone stack still defaults to creating the pull identity. With the live defaults,
`node_service_account_id` is null: use the project's existing `k8s-node-group-sa` after checking
its image-pull permissions, or have an administrator provision and own a dedicated identity
separately. Pass that existing ID to R1/R3 using `TF_VAR_node_service_account_id` locally or
`NIP_NODE_SERVICE_ACCOUNT_ID` in both plan/apply GitHub Environments. Do not read a null R12
output as the node identity.

For an existing R12 state that already manages the node account, group and access permit,
changing this flag to false plans their destruction. Review the state and IAM ownership with
an administrator before adopting these live defaults; do not apply that change as a routine
editor run. An administrator intentionally retaining stack-owned IAM must explicitly set
`create_node_service_account = true` in the stage sizing file and run the IAM change with admin
credentials. An environment `TF_VAR_*` cannot override the sizing file.

## Deploy

After the network (R7, [`network.md`](network.md)) when you use one; before R1/R3.

| # | Command | Expect |
|---|---|---|
| 1 | Put the passwords in SecretStash (Nebius's secrets service, formerly MysteryBox: [overview](https://docs.nebius.com/mysterybox/overview); below) and set `enable_mlflow`, `enable_postgresql`, `secret_id`, `secret_version_id` and `subnet_id` in the stage's tfvars | ids only in tfvars, never a value |
| 2 | `source scripts/bootstrap-backend.sh <stage> ml-services`; sandbox: `export TF_VAR_labels='{"nip-owner":"platform",…,"nip-ttl-expires":"…"}'` | as in [`deploy.md`](deploy.md) |
| 3 | export `TF_VAR_mlflow_admin_password` / `TF_VAR_postgresql_password` from the secret (below) | needed for the plan you apply and the apply; a reviewed-only plan runs without them |
| 4 | `make init plan STAGE=<stage> STACK=ml-services` | registry `nip-<stage>`; node IAM only with an explicit admin-owned `create_node_service_account = true`; `nip-<stage>-mlflow` / `nip-<stage>-pg` when enabled; in prod a `deletion_guard` per cluster |
| 5 | `make apply CONFIRM=yes STAGE=<stage> STACK=ml-services` | MLflow and PostgreSQL go through `Provisioning` to `Running`; outputs `registry_url`, `node_service_account_id`, `mlflow`, `postgresql` |
| 6 | before planning R1/R3: export `TF_VAR_node_service_account_id` with the existing pull identity's ID; only use R12's `node_service_account_id` output when node IAM creation is enabled | every node group runs as it; pods pull `registry_url/...` images without pull secrets when the identity has the required permissions |

Changing `node_service_account_id` on an existing R1/R3 node group changes its template; plan R1/R3
and read what it replaces before applying.

## Passwords: SecretStash, never in state

Both passwords are write-only arguments: Terraform sends them and keeps neither in the plan file nor
the state ([`docs/credentials.md`](../docs/credentials.md#secretstash)).

```bash
read -rs MLFLOW_PW; read -rs PG_PW   # MLflow: 8-64 chars, upper, lower, digit, special; PostgreSQL: 8+, upper, lower, special
nebius mysterybox secret create --name nip-<stage>-ml-services \
  --description 'R12 MLflow admin and PostgreSQL bootstrap passwords' \
  --secret-version-payload "$(jq -nc --arg m "$MLFLOW_PW" --arg p "$PG_PW" \
    '[{key: "mlflow-admin-password", string_value: $m}, {key: "postgresql-password", string_value: $p}]')"
unset MLFLOW_PW PG_PW
nebius mysterybox secret list                                   # mbsec-... -> secret_id
nebius mysterybox secret-version list --parent-id <secret ID>   # mbsecver-... -> secret_version_id

payload() {  # <secret ID> <version ID> <key>
  nebius mysterybox payload get --secret-id "$1" --version-id "$2" --format json |
    jq -er --arg k "$3" '.data[] | select(.key == $k) | .string_value'
}
export TF_VAR_mlflow_admin_password=$(payload <secret ID> <version ID> mlflow-admin-password)
export TF_VAR_postgresql_password=$(payload <secret ID> <version ID> postgresql-password)
```

Only the identity that applies needs `mysterybox.payload-viewer` on this secret; list the secret id
in the foundation's `stages.<stage>.ci_secret_ids`
([roles](https://docs.nebius.com/iam/authorization/roles#secretstash)).

**Rotate.** Add a new secret version with the new value(s), set `secret_version_id` to it, export
the variables again and plan: only `sensitive.version` changes, and the apply re-sends the
passwords. Without SecretStash, bump `secrets_version` instead. Then update every client (MLflow
`MLFLOW_TRACKING_PASSWORD`, application database secrets). **Not for MLflow:** its API has no update
(`Update is unimplemented for nebius.msp.mlflow.v1alpha1.ClusterService`, live apply 2026-10-11), so
re-sending its password fails the apply; recreate the cluster (export its data first) instead. The
PostgreSQL path has not been exercised live yet.

## Validate

First live run 2026-10-12 (the MLflow check failed, cause unknown: [below](#reaching-the-private-mlflow-endpoint-from-a-cluster)); record each check in `docs/evidence/` with the date.

**Scripted:** on an R1/R3 cluster planned with `node_service_account_id`, create the Secret, then run
the check Job ([`workloads/ml-services/check-job`](../workloads/ml-services/check-job/README.md)):

```bash
o() { terraform -chdir=terraform/live/<stage>/ml-services output -json | jq -r "$1"; }
kubectl create namespace ml-services --dry-run=client -o yaml | kubectl apply -f -
read -rs PG_PW; read -rs MLFLOW_PW   # from SecretStash (above); never on the command line
nebius iam get-access-token | kubectl -n ml-services create secret generic ml-services-check \
  --from-file=REGISTRY_TOKEN=/dev/stdin --from-literal=MLFLOW_TRACKING_PASSWORD="$MLFLOW_PW" --from-literal=PGPASSWORD="$PG_PW"
unset PG_PW MLFLOW_PW
REGISTRY_URL=$(o .registry_url.value) MLFLOW_HOST=$(o '.mlflow.value.private_tracking // empty') \
  PG_HOST=$(o '.postgresql.value.private_read_write // empty') tests/validate/ml-services.sh
kubectl -n ml-services delete secret ml-services-check
```

It passes when the registry push and pull, the MLflow run and `select 1` succeed (a service not
enabled is skipped) and a pod with no pull secret pulls the pushed digest; the result is
`results/ml-services.json`.

### Reaching the private MLflow endpoint from a cluster

`MLFLOW_HOST` is `mlflow.private_tracking`. What the docs mirror (`.cache/nebius-docs`, 2026-10-11) says,
and what it leaves open:

| Question | Answer | Source |
|---|---|---|
| Who can reach the private endpoint? | "the network where the cluster is located (for example, via a virtual machine in this network)" | `mlflow/clusters/manage.md` (Access), `mlflow/quickstart.md` |
| Are MK8s nodes and pods in that network? | nodes are VMs in the cluster's subnet; each node takes a `/24` from it for its Pods | `kubernetes/networking/requirements.md` |
| Does a **pod** (not a VM) reach it? | **unknown**: the docs name VMs only; no run has passed yet | — |
| Same network here? | MLflow attaches to the network of the ml-services `subnet_id` (output `network_id`); R1/R3 to their own `subnet_id`. Both default to the project's default subnet; with R7 both must take the network stack's subnet. Whether the 2026-10-12 run's R1 and R12 shared a network: **unknown** (not recorded) | `terraform/stacks/ml-services/variables.tf`, `terraform/stacks/inference/variables.tf` |
| DNS | VMs resolve through the network resolver `169.254.169.2`; whether the cluster's CoreDNS forwards the private-tracking name there: **unknown** (not in the docs). The probe's `dns` answers it | `vpc/dns/overview.md` |
| Firewall | the network's default security group allows all ingress and egress; a security group added to a node group can block TCP 443. The Job's NetworkPolicy allows DNS and 443 | `vpc/security-groups/overview.md`, `kubernetes/networking/security-groups.md` |
| TLS | the docs say to use the operating system's certificates; which CA signs the private endpoint: **unknown**. A failure shows as `cause: ssl` | `mlflow/quickstart.md` |

The check needs, in order: the name resolves from the pod (`probe.dns`), TCP 443 connects
(`probe.tcp`), TLS verifies and the admin credentials are accepted (the client). Its record carries
`endpoint_host`, the probe, and on failure `cause` (`name_resolution`, `connect_timeout`,
`connection_refused`, `ssl`, `http_status` with `http_status`, `read_timeout`, `other`),
`cause_class` and a bounded `error` that keeps the message's tail. On 2026-10-12 MLflow was
`RUNNING` (created 19:12Z) and the check, run 19:32Z from a pod in the R1 cluster, recorded only
`MlflowException: ... HTTPSConnectionPool(host=...` cut before the cause: why it failed is
**unknown**; the next run's `results/ml-services.json` says which layer stops it.

The manual checks behind the scripted run:

| Check | Command | Pass |
|---|---|---|
| Push | `nebius registry configure-helper`; `docker tag busybox:1.36 <registry_url>/busybox:1.36 && docker push <registry_url>/busybox:1.36` | push succeeds ([authentication](https://docs.nebius.com/container-registry/authentication#working-on-a-local-machine)) |
| Pull from nodes | on an R1/R3 cluster planned with `node_service_account_id`: `kubectl run pull-check --image=<registry_url>/busybox:1.36 --restart=Never -- true` | pod `Completed` with no `imagePullSecrets` |
| MLflow | `export MLFLOW_TRACKING_URI=https://<mlflow.private_tracking>` (from a pod or the bastion; public only in sandbox), `MLFLOW_TRACKING_USERNAME=admin`, `MLFLOW_TRACKING_PASSWORD` from the secret; `python -c 'import mlflow; mlflow.log_metric("smoke", 1)'` | run appears in the UI ([quickstart](https://docs.nebius.com/mlflow/quickstart#run-an-experiment-and-check-its-results)) |
| PostgreSQL | `psql "host=<postgresql.private_read_write> port=5432 sslmode=verify-full dbname=ml user=ml_owner"` | `select version();` returns 16.x ([connect](https://docs.nebius.com/postgresql/databases/connect#how-to-connect-to-a-database)) |
| Backups | `nebius msp postgresql v1alpha1 backup list-by-cluster --cluster-id <postgresql.id>` after the first backup window | one automatic backup per day |

## Restore PostgreSQL

A restore creates a new cluster, with disks at least as large as the source's; backups of a deleted
cluster are kept for the retention period, and point-in-time recovery reaches any moment from the
oldest backup to the newest archived WAL
([restore](https://docs.nebius.com/postgresql/backups#how-to-restore-a-cluster-from-a-backup)).
Take an on-demand backup before risky changes
([create a backup](https://docs.nebius.com/postgresql/backups#how-to-create-a-backup)):

```bash
nebius msp postgresql v1alpha1 backup create --cluster-id <postgresql.id>
nebius msp postgresql v1alpha1 backup list-by-cluster --cluster-id <postgresql.id>
read -rs PG_PW   # never on the command line history
nebius msp postgresql v1alpha1 cluster restore --backup-id <backup ID> \
  --source-cluster-id <postgresql.id> --name nip-<stage>-pg-restored \
  --bootstrap-user-password "$PG_PW" <other settings as in the create guide>
unset PG_PW
```

Point clients at the restored cluster's endpoint, then either bring it under this stack
(`terraform import`, after removing the old cluster from state) or keep it outside and retire it
later. See also [`backup-restore.md`](backup-restore.md).

## Teardown

1. Destroy or re-plan the R1/R3 node groups that run as `node_service_account_id`.
2. Registry: delete its images, or `nebius registry delete --id <registry ID> --force`; a registry
   with images cannot be deleted otherwise
   ([delete a registry](https://docs.nebius.com/container-registry/registries/manage#how-to-delete-a-registry)).
   To delete them one by one: `nebius registry image list --parent-id <registry ID> --all --format json`,
   whose items carry the image id at the top level (`.id`, `artifact-…`), not at `.metadata.id`
   ([R12-1](../docs/upstream-findings.md#2026-10-12-findings-from-this-repositorys-own-runs)), then
   `nebius registry image delete --id <image id>` for each, and list again: it must be empty.
3. MLflow: export experiments you need
   ([export data](https://docs.nebius.com/mlflow/clusters/export-data)); deleting the cluster deletes
   its data but not the artifact bucket, which keeps billing until you delete it
   ([delete MLflow](https://docs.nebius.com/mlflow/clusters/delete)).
4. PostgreSQL: take an on-demand backup if the data may be needed again.
5. `make destroy-plan STAGE=<stage> STACK=ml-services`; review the summary ([`teardown.md`](teardown.md));
   then `make destroy CONFIRM=yes STAGE=<stage> STACK=ml-services` and `make leftovers
   STACK=ml-services` with `NEBIUS_PROJECT_ID` set to the stage's project (residue by label).
6. MLflow artifact bucket (unlabelled, so step 5 does not list it): `scripts/mlflow-artifacts.sh list`
   now shows it `orphaned`; `CONFIRM=yes scripts/mlflow-artifacts.sh delete --bucket <name>` deletes it
   with its objects (`--ttl 24h` schedules the deletion instead, keeping a restore window; the bucket
   bills until purged). The script refuses while an MLflow cluster with that id exists and any bucket
   not named `mlflow-<cluster id>-artifacts` (a bucket you set in `mlflow.storage_bucket_name` is yours).

Prod: `make destroy` is refused, and each cluster has a `prevent_destroy` guard, so disabling a
service, a change that replaces a cluster, or a destroy fails at plan with "Instance cannot be
destroyed". To retire a prod cluster deliberately (a release with reviewers): take a backup, then
`terraform state rm 'terraform_data.deletion_guard["postgresql"]'` (or `["mlflow"]`) in the prod
root, set `enable_postgresql = false`, plan, and apply
([`teardown.md`](teardown.md)).
