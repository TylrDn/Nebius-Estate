# R12: ML platform services (docs.nebius.com/container-registry, /mlflow, /postgresql).
# A Container Registry for the stage's images, a service account that Managed Kubernetes node groups
# run as so pods pull from that registry without pull secrets (R1/R3 node_service_account_id), and
# two optional managed services in the stage's VPC network: a Managed MLflow tracking cluster and a
# Managed PostgreSQL 16 cluster with daily backups. Passwords reach the API only through write-only
# arguments (never plan or state), from ephemeral variables filled by hand or from SecretStash.

locals {
  labels = merge({ "nip-env" = "ml-services" }, var.labels, { "nip-region" = var.region, "nip-stage" = var.stage, "nip-stack" = "ml-services" })
  prefix = "${var.name}-${var.stage}"

  # Regions that offer each managed service (https://docs.nebius.com/overview/regions#availability-of-services-per-region,
  # read 2026-10-11). Container Registry is offered in every region.
  mlflow_regions     = ["eu-north1", "eu-west2", "me-west1", "uk-south1", "us-central1"]
  postgresql_regions = ["eu-north1", "eu-west1", "eu-west2", "me-west1", "uk-south1", "us-central1"]

  # Managed PostgreSQL documents cpu-e2 as its only platform (postgresql/clusters/manage), but cpu-e2
  # exists only in eu-north1 (compute/virtual-machines/types) while the service is priced on cpu-d3
  # (AMD EPYC Genoa) in every other region it is offered in (postgresql/resources/pricing#hosts).
  postgresql_platform = coalesce(var.postgresql.platform, var.region == "eu-north1" ? "cpu-e2" : "cpu-d3")

  # Public endpoints. The stage policy allows a public endpoint only behind an allowlist where
  # require_allowed_cidrs is set (staging, prod); neither service has an allowlist field
  # (provider 0.6.67 schema), so outside sandbox the default is private only.
  policy            = module.stage_policy.policy
  public_default    = module.stage_policy.public_endpoint && !local.policy.require_allowed_cidrs
  mlflow_public     = var.mlflow.public_access == null ? local.public_default : var.mlflow.public_access
  postgresql_public = var.postgresql.public_access == null ? local.public_default : var.postgresql.public_access

  needs_network = var.enable_mlflow || var.enable_postgresql

  # Secrets: SecretStash (secret_id) or TF_VAR_* by hand. sensitive.version must not carry a secret:
  # with SecretStash it names the secret and the pinned version, so pinning a new version re-sends
  # the rotated passwords; by hand, bump secrets_version.
  from_secret     = var.secret_id != null
  secrets_version = local.from_secret ? join("/", compact([var.secrets_version, var.secret_id, var.secret_version_id])) : var.secrets_version

  mlflow_service_account_id = var.mlflow.service_account_id != null ? var.mlflow.service_account_id : one(data.nebius_iam_v1_service_account.mlflow[*].id)
}

module "stage_policy" {
  source = "../../modules/stage-policy"

  stage                       = var.stage
  ttl_expires                 = lookup(var.labels, "nip-ttl-expires", null)
  stack                       = "ml-services"
  has_cluster                 = false
  has_public_endpoint_control = false
  forbid_deletion             = var.forbid_deletion
}

resource "terraform_data" "stage_policy" {
  lifecycle {
    precondition {
      condition     = length(module.stage_policy.violations) == 0
      error_message = "stage ${var.stage} policy (platform/stages.yaml): ${join("; ", module.stage_policy.violations)}."
    }
    precondition {
      condition     = !(var.enable_mlflow && local.mlflow_public && local.policy.require_allowed_cidrs) && !(var.enable_postgresql && local.postgresql_public && local.policy.require_allowed_cidrs)
      error_message = "stage ${var.stage} allows public endpoints only behind allowed_cidrs (policy.require_allowed_cidrs), and Managed MLflow / PostgreSQL endpoints have no allowlist: keep mlflow.public_access and postgresql.public_access false and connect from inside the VPC (R7 bastion or a cluster in the same network)."
    }
    precondition {
      condition     = !var.create_node_service_account || var.node_pull_scope == "project" || var.enable_registry
      error_message = "node_pull_scope = \"registry\" needs enable_registry = true; with an existing registry, set node_pull_scope = \"project\"."
    }
    # Passwords come from exactly one path: SecretStash (secret_id; the values are read from the
    # secret into the same ephemeral variables before the plan that is applied), or TF_VAR_* by
    # hand. With SecretStash a reviewed-only plan may run without them; an apply may not.
    precondition {
      condition     = !var.enable_mlflow || local.from_secret || var.mlflow_admin_password != null
      error_message = "enable_mlflow needs secret_id (SecretStash) or TF_VAR_mlflow_admin_password."
    }
    precondition {
      condition     = !var.enable_postgresql || local.from_secret || var.postgresql_password != null
      error_message = "enable_postgresql needs secret_id (SecretStash) or TF_VAR_postgresql_password."
    }
    precondition {
      condition     = var.secret_id == null || var.enable_mlflow || var.enable_postgresql
      error_message = "secret_id is set but neither enable_mlflow nor enable_postgresql is: there is no password to read it for."
    }
    precondition {
      condition     = (var.mlflow_admin_password == null || var.enable_mlflow) && (var.postgresql_password == null || var.enable_postgresql)
      error_message = "a password is set for a service that is not enabled (mlflow_admin_password needs enable_mlflow, postgresql_password needs enable_postgresql)."
    }
    precondition {
      condition     = !local.from_secret || !terraform.applying || ((!var.enable_mlflow || var.mlflow_admin_password != null) && (!var.enable_postgresql || var.postgresql_password != null))
      error_message = "secret_id is set: export TF_VAR_mlflow_admin_password and/or TF_VAR_postgresql_password from that secret before the plan you apply (docs/credentials.md#secretstash)."
    }
  }
}

# ---- Container Registry and the node pull identity ----------------------------------------------

resource "nebius_registry_v1_registry" "this" {
  count       = var.enable_registry ? 1 : 0
  parent_id   = var.parent_id
  name        = local.prefix
  description = "Images for ${var.stage} workloads (R12). Nodes pull with ${local.prefix}-node-sa."
  labels      = local.labels
}

# Nodes whose node group runs as a service account in a group with at least viewer pull from
# Container Registry without credentials (kubernetes/workloads/images-container-registry). A custom
# group in the project holds the permit; registries accept access permits, so "registry" scopes the
# role to this registry only (iam/authorization/groups#custom-groups).
resource "nebius_iam_v1_service_account" "node" {
  count       = var.create_node_service_account ? 1 : 0
  parent_id   = var.parent_id
  name        = "${local.prefix}-node-sa"
  description = "Managed Kubernetes node groups (R1/R3 node_service_account_id): pulls images from Container Registry"
  labels      = local.labels
}

resource "nebius_iam_v1_group" "image_pullers" {
  count     = var.create_node_service_account ? 1 : 0
  parent_id = var.parent_id
  name      = "${local.prefix}-image-pullers"
  labels    = local.labels
}

resource "nebius_iam_v1_group_membership" "node" {
  count     = var.create_node_service_account ? 1 : 0
  parent_id = nebius_iam_v1_group.image_pullers[0].id
  member_id = nebius_iam_v1_service_account.node[0].id
}

resource "nebius_iam_v1_access_permit" "image_pull" {
  count     = var.create_node_service_account ? 1 : 0
  parent_id = nebius_iam_v1_group.image_pullers[0].id
  # A registry scope without the registry is refused by terraform_data.stage_policy.
  resource_id = var.node_pull_scope == "registry" && var.enable_registry ? nebius_registry_v1_registry.this[0].id : var.parent_id
  role        = "viewer"
}

# ---- network for the managed services ----------------------------------------------------------

module "network" {
  source = "../../modules/network"
  count  = local.needs_network ? 1 : 0

  parent_id   = var.parent_id
  subnet_id   = var.subnet_id
  subnet_name = var.subnet_name
}

# ---- Managed MLflow ----------------------------------------------------------------------------

# The project ships with mlflow-sa for Managed MLflow (mlflow/clusters/manage); it reads and writes
# the artifact bucket, and creates it when storage_bucket_name is null.
data "nebius_iam_v1_service_account" "mlflow" {
  count     = var.enable_mlflow && var.mlflow.service_account_id == null ? 1 : 0
  parent_id = var.parent_id
  name      = "mlflow-sa"
}

resource "nebius_msp_mlflow_v1alpha1_cluster" "this" {
  count               = var.enable_mlflow ? 1 : 0
  parent_id           = var.parent_id
  name                = "${local.prefix}-mlflow"
  description         = "MLflow tracking for ${var.stage} (R12)"
  network_id          = module.network[0].network_id
  size                = var.mlflow.size
  public_access       = local.mlflow_public
  admin_username      = var.mlflow.admin_username
  service_account_id  = local.mlflow_service_account_id
  storage_bucket_name = var.mlflow.storage_bucket_name
  # No labels: the MLflow API (v1alpha1, provider 0.6.67) keeps none, so labels here fail every apply
  # with "inconsistent result after apply" (live apply 2026-10-11). The cluster is found by its name
  # (<prefix>-mlflow) instead; scripts/leftovers.sh --stage lists it unlabelled.
  labels = null

  # Write-only: the password is sent to the API and kept in neither plan nor state.
  sensitive = {
    admin_password = var.mlflow_admin_password
    version        = local.secrets_version
  }

  lifecycle {
    precondition {
      condition     = contains(local.mlflow_regions, var.region)
      error_message = "Managed MLflow is not available in ${var.region}; it is offered in ${join(", ", local.mlflow_regions)} (https://docs.nebius.com/overview/regions#availability-of-services-per-region). Set enable_mlflow = false here, deploy it in one of those regions, or request the service for this region through support."
    }
  }
}

# ---- Managed PostgreSQL ------------------------------------------------------------------------

resource "nebius_msp_postgresql_v1alpha1_cluster" "this" {
  count     = var.enable_postgresql ? 1 : 0
  parent_id = var.parent_id
  name      = "${local.prefix}-pg"
  # The API accepts only ^[{},":a-zA-Z0-9\s_-]*$ here (no parentheses or dots; live apply 2026-10-11).
  description = "PostgreSQL for ${var.stage} ML services - R12"
  network_id  = module.network[0].network_id
  labels      = local.labels

  config = {
    version       = "16" # the only version the service offers
    public_access = local.postgresql_public
    pooler_config = {
      pooling_mode  = var.postgresql.pooling_mode
      max_pool_size = var.postgresql.max_pool_size
    }
    template = {
      resources = {
        platform = local.postgresql_platform
        preset   = var.postgresql.preset
      }
      disk = {
        type           = "network-ssd" # the only disk type the service offers
        size_gibibytes = var.postgresql.disk_size_gibibytes
      }
      hosts = { count = var.postgresql.hosts }
    }
    postgresql_config_16 = var.postgresql.max_connections == null ? null : { max_connections = var.postgresql.max_connections }
  }

  bootstrap = {
    db_name   = var.postgresql.db_name
    user_name = var.postgresql.user_name
  }

  # Write-only: the bootstrap password is kept in neither plan nor state.
  sensitive = {
    bootstrap = { user_password = var.postgresql_password }
    version   = local.secrets_version
  }

  # Daily automatic backups; window and retention (7-30 days, also the WAL retention and how far
  # back a restore can go) are fixed at creation (postgresql/backups).
  backup = {
    backup_window_start = var.postgresql.backup_window_start
    retention_policy    = "${var.postgresql.backup_retention_days}d"
  }

  lifecycle {
    precondition {
      condition     = contains(local.postgresql_regions, var.region)
      error_message = "Managed PostgreSQL is not available in ${var.region}; it is offered in ${join(", ", local.postgresql_regions)} (https://docs.nebius.com/overview/regions#availability-of-services-per-region). Set enable_postgresql = false here, deploy it in one of those regions, or request the service for this region through support."
    }
    precondition {
      condition     = local.postgresql_platform != "cpu-e2" || var.region == "eu-north1"
      error_message = "postgresql.platform cpu-e2 (Intel Ice Lake) exists only in eu-north1; use cpu-d3 or leave platform null."
    }
  }
}

# ---- deletion guard ----------------------------------------------------------------------------

# Neither managed cluster has an API deletion-protection field (provider 0.6.67), so where the stage
# requires deletion protection (prod) Terraform refuses to destroy or replace them: a guard with
# prevent_destroy follows each cluster's id. Disabling a service, replacing a cluster, or a full
# destroy then fails at plan. To retire one deliberately: `terraform state rm` its guard first
# (runbooks/ml-services.md#teardown).
resource "terraform_data" "deletion_guard" {
  for_each = module.stage_policy.forbid_deletion ? merge(
    var.enable_mlflow ? { mlflow = one(nebius_msp_mlflow_v1alpha1_cluster.this[*].id) } : {},
    var.enable_postgresql ? { postgresql = one(nebius_msp_postgresql_v1alpha1_cluster.this[*].id) } : {},
  ) : {}

  triggers_replace = each.value

  lifecycle {
    prevent_destroy = true
  }
}
