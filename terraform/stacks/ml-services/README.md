# `stacks/ml-services` — ML platform services (R12)

**Purpose.** The managed services around the GPU clusters: a Container Registry for the stage's
images with a node service account so pods pull from it without pull secrets, and, when wanted, a
Managed MLflow tracking server and a Managed PostgreSQL 16 database in the stage's VPC network.
Passwords are write-only: they never reach the plan or the state.

**Used by.** [S1](../../../solutions/S1-private-llm-serving-vpn/README.md) private LLM serving with VPN, [S9](../../../solutions/S9-data-science-notebooks/README.md) data-science notebooks ([all solutions](../../../solutions/README.md)).

## What it builds

| Resource | Notes |
|---|---|
| Container Registry `<name>-<stage>` | `enable_registry` (on). Images are addressed as `cr.<region>.nebius.cloud/<registry ID without registry->` ([manage registries](https://docs.nebius.com/container-registry/registries/manage#how-to-create-a-registry)) |
| Node service account `<name>-<stage>-node-sa` | `create_node_service_account` (on). Member of the custom group `<name>-<stage>-image-pullers`, which holds `viewer` on this registry (`node_pull_scope = "registry"`) or on the project (`"project"`). A node group running as a service account in a group with at least `viewer` pulls from Container Registry without credentials ([images in MK8s](https://docs.nebius.com/kubernetes/workloads/images-container-registry)); registries accept access permits, so the role can be scoped to one registry ([custom groups](https://docs.nebius.com/iam/authorization/groups#custom-groups), [roles](https://docs.nebius.com/iam/authorization/roles#general-roles)) |
| Managed MLflow `<name>-<stage>-mlflow` | `enable_mlflow` (off). `medium` is the only size (8 vCPU, 32 GiB RAM, 200 GiB Network SSD); runs as the project's `mlflow-sa` unless `mlflow.service_account_id` is set; artifact bucket `mlflow.storage_bucket_name` or created by the service ([create a cluster](https://docs.nebius.com/mlflow/clusters/manage)) |
| Managed PostgreSQL `<name>-<stage>-pg` | `enable_postgresql` (off). Version 16, `network-ssd` disks, preset per `postgresql.preset`, `postgresql.hosts` hosts, session or transaction pooling, a bootstrap database and user ([create clusters](https://docs.nebius.com/postgresql/clusters/manage#how-to-create-clusters)). Daily automatic backups at `backup_window_start` (UTC), kept `backup_retention_days` (7–30; also the WAL retention and the restore horizon); both are fixed once the cluster exists ([backups](https://docs.nebius.com/postgresql/backups#how-to-configure-automatic-backups)) |
| Deletion guard | where the stage requires deletion protection (prod): a `prevent_destroy` guard per cluster. The provider has no API deletion-protection field on either cluster ([MLflow schema](https://docs.nebius.com/terraform-provider/reference/resources/msp_mlflow_v1alpha1_cluster#schema), [PostgreSQL schema](https://docs.nebius.com/terraform-provider/reference/resources/msp_postgresql_v1alpha1_cluster#schema)), so Terraform refuses any plan that disables, replaces or destroys them |

Both clusters join the network of `subnet_id` (R7) or, when it is null, of the subnet
looked up by `subnet_name` (the plan refuses neither being set) ([network ID](https://docs.nebius.com/vpc/networking/resources#how-to-get-a-network-id)).

**Public endpoints.** `public_access = true` gives a cluster a public endpoint next to its private
one ([MLflow](https://docs.nebius.com/mlflow/clusters/manage),
[PostgreSQL](https://docs.nebius.com/postgresql/databases/connect#how-to-connect-to-a-database)).
Neither resource has an allowlist, and staging and prod allow a public endpoint only behind one
(`platform/stages.yaml` `require_allowed_cidrs`), so `public_access` defaults to the stage: public in
sandbox, private in staging and prod, and a public endpoint there is refused at plan time. Reach a
private endpoint from the cluster network (pods in R1/R3, the R7 bastion).

## Region availability

The stack refuses to plan a service in a region that does not offer it, naming the regions that do
([services per region](https://docs.nebius.com/overview/regions#availability-of-services-per-region), read 2026-10-11;
[`docs/solutions/regions.md`](../../../docs/solutions/regions.md#services-per-region)):

| Service | Offered | Not offered |
|---|---|---|
| Container Registry | every region | — |
| Managed MLflow | `eu-north1`, `eu-west2`, `me-west1`, `uk-south1`, `us-central1` | `eu-west1`, `eu-north2`, `eu-south1`, `uk-south2`, `us-north1` |
| Managed PostgreSQL | `eu-north1`, `eu-west1`, `eu-west2`, `me-west1`, `uk-south1`, `us-central1` | `eu-north2`, `eu-south1`, `uk-south2`, `us-north1` |

A missing service can be requested per region through support (same page). Container Registry has
a registry quota of 0 in `eu-north2` ([quotas](https://docs.nebius.com/container-registry/resources/quotas-limits)).

**PostgreSQL platform.** The create guide names `cpu-e2` as the only platform
([create clusters](https://docs.nebius.com/postgresql/clusters/manage#how-to-create-clusters)), but
`cpu-e2` exists only in `eu-north1`
([non-GPU presets](https://docs.nebius.com/compute/virtual-machines/types#presets-for-non-gpu-platforms))
while the pricing page lists Managed PostgreSQL on AMD EPYC Genoa (`cpu-d3`) in every region the
service is offered in ([hosts pricing](https://docs.nebius.com/postgresql/resources/pricing#hosts)).
`postgresql.platform = null` therefore picks `cpu-e2` in `eu-north1` and `cpu-d3` elsewhere, and
`cpu-e2` outside `eu-north1` is refused. Confirm on the first live apply outside `eu-north1`.

## Inputs that matter

| Variable | Default | Meaning |
|---|---|---|
| `subnet_id` / `subnet_name` | `null` / `null` | network for the clusters: R7's `subnet_id`, or the project default that `scripts/bootstrap-backend.sh` exports as `TF_VAR_subnet_id`; `subnet_name` only to look one up by its full name (`default-subnet-<suffix>`). Needed only with MLflow or PostgreSQL |
| `enable_registry`, `create_node_service_account`, `node_pull_scope` | `true`, `true`, `"registry"` | registry and pull identity; `"project"` when nodes also pull from registries made elsewhere. `create_node_service_account = false` = pass the project's `k8s-node-group-sa` (already in the default `viewers` group) to R1/R3 yourself |
| `enable_mlflow`, `mlflow` | `false`, `{}` | `admin_username` (`admin`), `public_access` (`null` = stage), `service_account_id` (`null` = `mlflow-sa`), `storage_bucket_name` (`null` = created by the service) |
| `enable_postgresql`, `postgresql` | `false`, `{}` | `platform` (`null` = region default), `preset` (`2vcpu-8gb`, the quickstart's), `disk_size_gibibytes` (96; can grow, never shrink), `hosts` (1), `db_name` (`ml`), `user_name` (`ml_owner`; `admin`, `repl`, `monitor`, `postgres`, `public`, `none` are reserved), `pooling_mode` (`SESSION`), `max_pool_size`, `max_connections` (100–12,800), `public_access`, `backup_window_start` (`00:02:00` UTC), `backup_retention_days` (7) |
| `forbid_deletion` | `null` = stage policy | Terraform-level guard on both clusters; prod refuses `false` |
| `secret_id`, `secret_version_id` | `null` | SecretStash (Nebius's secret store, formerly MysteryBox, API id `mysterybox`) secret (and pinned version) holding `mlflow-admin-password` and/or `postgresql-password`. A reviewed-only plan runs without the values; the plan that is applied and the apply read them into the `TF_VAR_*` below. Pinning a new version re-sends rotated passwords ([credentials](../../../docs/credentials.md#secretstash)) |
| `TF_VAR_mlflow_admin_password`, `TF_VAR_postgresql_password` | — | ephemeral and write-only (`sensitive` block): never in tfvars, plan or state. MLflow: 8–64 characters with upper, lower, digit and special; PostgreSQL: 8+ with upper, lower and special. Without `secret_id` they are required for every plan with the service |
| `secrets_version` | `"1"` | change to re-send a rotated password typed in by hand |

Sizing per stage (a starting point; size to the workload): sandbox one `2vcpu-8gb` host, 96 GiB;
staging two `4vcpu-16gb` hosts, 256 GiB; prod two or more hosts (one primary, read-only replicas:
[replication metrics](https://docs.nebius.com/postgresql/monitoring#replication)), 256 GiB or more,
14–30 days of backups. MLflow is one size everywhere.

## Outputs and composition

| Output | Feeds |
|---|---|
| `node_service_account_id` | R1/R3 `node_service_account_id` (`terraform/stacks/inference`, `terraform/stacks/training`): every node group runs as it and pulls from the registry without pull secrets |
| `registry_id`, `registry_url` | `docker push <registry_url>/<image>:<tag>` and pod specs; CI pushes with a short-lived token ([authentication](https://docs.nebius.com/container-registry/authentication#short-lived-access-token)) |
| `mlflow` | `id`, `public_tracking` / `private_tracking` (prefix `https://` for `MLFLOW_TRACKING_URI`; [quickstart](https://docs.nebius.com/mlflow/quickstart#configure-connection-to-mlflow-tracking)), `admin_username`, `artifact_bucket` |
| `postgresql` | `id`, `private_read_write`, `private_read_only`, `public_*` endpoints (port 5432, `sslmode=verify-full`; [connect](https://docs.nebius.com/postgresql/databases/connect#how-to-connect-to-a-database)), `db_name`, `user_name` |
| `network_id`, `secret`, `deletion_guarded` | the network used; the secret ids (never values); which clusters are guarded |

Apply after the network (R7) and before R1/R3, so the clusters' node groups start with the pull
identity. Workloads read the passwords from SecretStash, never from Terraform outputs.

## Quotas and cost

Default quotas per region ([MLflow](https://docs.nebius.com/mlflow/resources/quotas-limits#clusters),
[PostgreSQL](https://docs.nebius.com/postgresql/resources/quotas-limits),
[Container Registry](https://docs.nebius.com/container-registry/resources/quotas-limits)); request more
through [quotas](https://docs.nebius.com/overview/quotas#change-quotas):

| Service | Clusters / registries | vCPU | RAM | Network SSD |
|---|---|---|---|---|
| Managed MLflow | 10 | 80 | 320 GiB | 1.95 TiB (each `medium` cluster takes 8 vCPU, 32 GiB, 200 GiB for its whole life, idle or not) |
| Managed PostgreSQL | 10 | 80 | 320 GiB | 2 TiB (counted at the configured limits) |
| Container Registry | 10 registries (0 in `eu-north2`) | — | — | — |

Cost shape (list prices from the pricing pages read 2026-10-11, USD, before tax; not a quote; the
billing calculator has not been run for these services yet, so there is no dated calculator
observation):

| Item | Billed as | Example |
|---|---|---|
| Container Registry | free ([pricing](https://docs.nebius.com/container-registry/resources/pricing)) | $0 |
| MLflow `medium` | 8 × $0.03 + 32 × $0.0075 = $0.48/h compute, 200 GiB × $0.071 per 730 h disk ([pricing](https://docs.nebius.com/mlflow/resources/pricing#computing-resources)) | about $364 per 730 h, plus the artifact bucket at Object Storage prices; public access is free |
| PostgreSQL hosts | $0.034 per vCPU-h + $0.009 per GiB-h RAM, per running host ([hosts](https://docs.nebius.com/postgresql/resources/pricing#hosts)) | `2vcpu-8gb`: $0.14/h a host; `4vcpu-16gb`: $0.28/h a host |
| PostgreSQL storage | $0.071 per GiB per 730 h of disk attached to the hosts ([storage](https://docs.nebius.com/postgresql/resources/pricing#storage)) | 96 GiB: about $6.82 per 730 h |

Sandbox with both services: about $0.48 + $0.14 = $0.62/h plus disks. Delete the clusters when the
run ends; the MLflow artifact bucket keeps billing until it is deleted too
(`scripts/mlflow-artifacts.sh`).

## Validate

- Static: `terraform test` (mocked, 32 + 2 runs): default build (registry, node identity, labels),
  permit scope (registry or project), every toggle on and off, MLflow and PostgreSQL settings,
  region refusals (MLflow in `eu-west1`, PostgreSQL in `uk-south2`, `cpu-e2` outside `eu-north1`),
  passwords from either path (SecretStash or `TF_VAR_*`) including the apply refusal without them,
  public endpoints per stage, and the prod deletion guard. `tests/one-pass-apply.tftest.hcl` applies every
  service in one pass and re-plans it, failing if an argument that forced a manual step on the first
  live run returns (MLflow labels, the PostgreSQL description, a moving password version); a second
  `make plan` printing `No changes` on the next live run is the real proof.
- Teardown: `scripts/mlflow-artifacts.sh` lists the service-made artifact bucket and deletes it once
  its cluster is gone ([runbook](../../../runbooks/ml-services.md#teardown)).
- Live: [`tests/validate/ml-services.sh`](../../../tests/validate/ml-services.sh) runs
  [`workloads/ml-services/check-job`](../../../workloads/ml-services/check-job/README.md): push and pull
  an image, pull it again on a node running as `node_service_account_id` with no pull secret, log an
  MLflow run, `psql` `select 1` through the private endpoint ([runbook](../../../runbooks/ml-services.md#validate)).

## Evidence

Run live once, 2026-10-11 ([evidence](../../../docs/evidence/2026-10-11-sandbox-ml-services-live-recipe.md)): registry,
MLflow `medium` and PostgreSQL 16 (`cpu-e2` `2vcpu-8gb`, 96 GiB) reached `RUNNING` in `eu-north1` and were destroyed;
without the node identity (`create_node_service_account = false`: no IAM changes in that run). Three API facts found
live are now in the stack: the MLflow API keeps **no labels** (the cluster is sent none, and `scripts/leftovers.sh` lists
unlabelled MLflow clusters), the PostgreSQL description accepts only `^[{},":a-zA-Z0-9\s_-]*$`, and the MLflow API has
**no update** (`Update is unimplemented`), so any in-place change to the MLflow cluster, a password re-send included,
fails: replace it instead.

Run live again, 2026-10-12, with the node identity ([evidence](../../../docs/evidence/2026-10-12-sandbox-ml-services-acceptance.md)):
the second plan printed No changes; the check Job pushed and pulled an image as the IAM identity, a pod on an R1
node pulled it with no pull secret, and `select 1` ran over `sslmode=verify-full`. The MLflow check failed (cause
unknown, not diagnosed before teardown); registry images are listed with their id at `.id`
([R12-1](../../../docs/upstream-findings.md#2026-10-12-findings-from-this-repositorys-own-runs)). Not yet shown: an MLflow run.

## Teardown

Destroy R1/R3 node groups that run as `node_service_account_id` first. A registry that still holds
images cannot be deleted: delete the images (or `nebius registry delete --id <id> --force`) first
([delete a registry](https://docs.nebius.com/container-registry/registries/manage#how-to-delete-a-registry)).
Deleting the MLflow cluster deletes its data, but not the artifact bucket
([delete MLflow](https://docs.nebius.com/mlflow/clusters/delete)); export what you need first
([export data](https://docs.nebius.com/mlflow/clusters/export-data)). PostgreSQL backups outlive the
cluster for the retention period, so a deleted cluster can still be restored
([restore](https://docs.nebius.com/postgresql/backups#how-to-restore-a-cluster-from-a-backup)). Then
`make destroy-plan destroy STAGE=<stage> STACK=ml-services CONFIRM=yes`. Prod refuses `make destroy`,
and its clusters are guarded ([`runbooks/ml-services.md`](../../../runbooks/ml-services.md#teardown)).

## Upstream references

[Container Registry quickstart](https://docs.nebius.com/container-registry/quickstart) ·
[pull images in MK8s](https://docs.nebius.com/kubernetes/workloads/images-container-registry) ·
[MLflow quickstart](https://docs.nebius.com/mlflow/quickstart) ·
[PostgreSQL quickstart](https://docs.nebius.com/postgresql/quickstart) ·
[backups](https://docs.nebius.com/postgresql/backups) ·
provider resources
[`nebius_registry_v1_registry`](https://docs.nebius.com/terraform-provider/reference/resources/registry_v1_registry),
[`nebius_msp_mlflow_v1alpha1_cluster`](https://docs.nebius.com/terraform-provider/reference/resources/msp_mlflow_v1alpha1_cluster#nested-schema-for-sensitive),
[`nebius_msp_postgresql_v1alpha1_cluster`](https://docs.nebius.com/terraform-provider/reference/resources/msp_postgresql_v1alpha1_cluster#nested-schema-for-sensitivebootstrap),
[`nebius_iam_v1_access_permit`](https://docs.nebius.com/terraform-provider/reference/resources/iam_v1_access_permit).
