variable "stage" {
  description = "Lifecycle stage this root belongs to (platform/stages.yaml): sandbox, staging or prod. Selects the policy the stack enforces at plan time (ADR-0009)."
  type        = string

  validation {
    condition     = contains(keys(yamldecode(file("${path.module}/../../../platform/stages.yaml")).stages), var.stage)
    error_message = "stage must be one of the stages in platform/stages.yaml (sandbox, staging, prod)."
  }
}

variable "parent_id" {
  description = "Nebius project ID that owns the registry, the clusters and the node service account (project-...)."
  type        = string

  validation {
    condition     = startswith(var.parent_id, "project-")
    error_message = "parent_id must be a Nebius project ID (project-...)."
  }
}

variable "region" {
  description = "Nebius region of parent_id (platform/regions.yaml). Managed MLflow and Managed PostgreSQL are not offered everywhere: the clusters refuse to plan where the docs list them as unavailable (overview/regions#availability-of-services-per-region)."
  type        = string
  default     = "eu-north1"

  validation {
    condition     = contains(keys(yamldecode(file("${path.module}/../../../platform/regions.yaml")).regions), var.region)
    error_message = "region is not in platform/regions.yaml."
  }
}

variable "name" {
  description = "Name prefix: resources are <name>-<stage>-<role> (registry, mlflow, pg, node-sa, image-pullers)."
  type        = string
  default     = "nip"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,19}$", var.name))
    error_message = "name must be lowercase letters, digits and hyphens, starting with a letter, at most 20 characters."
  }
}

# ---- network --------------------------------------------------------------------------------

variable "subnet_id" {
  description = "Existing VPC subnet whose network hosts the MLflow and PostgreSQL clusters (with R7: the network stack's subnet_id). Both services attach to the subnet's network (network_id). null = the project's default subnet, looked up by subnet_name."
  type        = string
  default     = null
}

variable "subnet_name" {
  description = "Name of the existing subnet to look up when subnet_id is null. No default: real default subnets are named default-subnet-<suffix>, so pass subnet_id (scripts/bootstrap-backend.sh exports the project default as TF_VAR_subnet_id; R7 outputs subnet_id). Needed only with enable_mlflow or enable_postgresql."
  type        = string
  default     = null
}

# ---- Container Registry and the node pull identity --------------------------------------------

variable "enable_registry" {
  description = "Create a Container Registry for this stage's images (free of charge; 10 registries per region by default, 0 in eu-north2)."
  type        = bool
  default     = true
}

variable "create_node_service_account" {
  description = "Create a service account for Managed Kubernetes node groups and grant it viewer through a custom group, so pods pull from Container Registry without pull secrets. Its id is the node_service_account_id output for R1/R3. false = use the project's k8s-node-group-sa (already in the default viewers group) and pass its id to R1/R3 yourself."
  type        = bool
  default     = true
}

variable "node_pull_scope" {
  description = "Where the node service account's viewer permit applies: \"registry\" (only this stack's registry; least privilege, needs enable_registry) or \"project\" (every registry and every other viewable resource in the project, e.g. registries made outside this stack)."
  type        = string
  default     = "registry"

  validation {
    condition     = contains(["registry", "project"], var.node_pull_scope)
    error_message = "node_pull_scope must be \"registry\" or \"project\"."
  }
}

# ---- Managed MLflow ----------------------------------------------------------------------------

variable "enable_mlflow" {
  description = "Create a Managed MLflow tracking cluster (one medium cluster: 8 vCPU, 32 GiB RAM, 200 GiB Network SSD). Not offered in every region."
  type        = bool
  default     = false
}

variable "mlflow" {
  description = "MLflow cluster settings. public_access null = the stage default (public in sandbox only; see README). service_account_id null = the project's mlflow-sa, looked up by name. storage_bucket_name null = the service creates the artifact bucket, which outlives the cluster and is billed until deleted. The admin password is never here: TF_VAR_mlflow_admin_password (write-only) or the SecretStash secret secret_id."
  type = object({
    size                = optional(string, "medium")
    admin_username      = optional(string, "admin")
    public_access       = optional(bool)
    service_account_id  = optional(string)
    storage_bucket_name = optional(string)
  })
  default = {}

  validation {
    condition     = var.mlflow.size == "medium"
    error_message = "mlflow.size must be \"medium\": the only size that can be created (small is no longer supported since October 2025; mlflow/resources/pricing)."
  }
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]{1,63}$", var.mlflow.admin_username))
    error_message = "mlflow.admin_username must be 1-63 letters, digits, '.', '_' or '-'."
  }
}

# ---- Managed PostgreSQL ------------------------------------------------------------------------

variable "enable_postgresql" {
  description = "Create a Managed PostgreSQL 16 cluster. Not offered in every region."
  type        = bool
  default     = false
}

variable "postgresql" {
  description = "PostgreSQL cluster settings. platform null = cpu-e2 in eu-north1 (the documented platform), cpu-d3 elsewhere (the platform priced for the other regions; see README). Backup window and retention cannot be changed after creation. The bootstrap password is never here: TF_VAR_postgresql_password (write-only) or the SecretStash secret secret_id."
  type = object({
    platform              = optional(string)
    preset                = optional(string, "2vcpu-8gb")
    disk_size_gibibytes   = optional(number, 96)
    hosts                 = optional(number, 1)
    db_name               = optional(string, "ml")
    user_name             = optional(string, "ml_owner")
    pooling_mode          = optional(string, "SESSION")
    max_pool_size         = optional(number)
    max_connections       = optional(number)
    public_access         = optional(bool)
    backup_window_start   = optional(string, "00:02:00")
    backup_retention_days = optional(number, 7)
  })
  default = {}

  validation {
    condition     = var.postgresql.platform == null || contains(["cpu-e2", "cpu-d3"], coalesce(var.postgresql.platform, "cpu-e2"))
    error_message = "postgresql.platform must be cpu-e2 (Intel Ice Lake, eu-north1 only), cpu-d3 (AMD EPYC Genoa) or null (region default)."
  }
  validation {
    condition     = can(regex("^[0-9]+vcpu-[0-9]+gb$", var.postgresql.preset))
    error_message = "postgresql.preset must be a non-GPU preset such as 2vcpu-8gb or 4vcpu-16gb (compute/virtual-machines/types#presets-for-non-gpu-platforms)."
  }
  validation {
    condition     = var.postgresql.disk_size_gibibytes >= 1 && floor(var.postgresql.disk_size_gibibytes) == var.postgresql.disk_size_gibibytes
    error_message = "postgresql.disk_size_gibibytes must be a whole number of GiB. It can grow later but never shrink."
  }
  validation {
    condition     = var.postgresql.hosts >= 1 && floor(var.postgresql.hosts) == var.postgresql.hosts
    error_message = "postgresql.hosts must be a whole number, at least 1."
  }
  validation {
    condition     = can(regex("^[A-Za-z_][A-Za-z0-9_]{0,62}$", var.postgresql.db_name))
    error_message = "postgresql.db_name must be 1-63 characters: letters, digits and underscores, not starting with a digit."
  }
  validation {
    condition     = can(regex("^[A-Za-z_][A-Za-z0-9_]{0,62}$", var.postgresql.user_name)) && !contains(["admin", "repl", "monitor", "postgres", "public", "none"], lower(var.postgresql.user_name))
    error_message = "postgresql.user_name must be a valid identifier and not a reserved name (admin, repl, monitor, postgres, public, none)."
  }
  validation {
    condition     = contains(["SESSION", "TRANSACTION"], var.postgresql.pooling_mode)
    error_message = "postgresql.pooling_mode must be SESSION (default, every client works) or TRANSACTION (many idle connections; not every client supports it)."
  }
  validation {
    condition     = var.postgresql.max_connections == null || (coalesce(var.postgresql.max_connections, 100) >= 100 && coalesce(var.postgresql.max_connections, 100) <= 12800)
    error_message = "postgresql.max_connections must be 100-12800."
  }
  validation {
    condition     = can(regex("^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$", var.postgresql.backup_window_start))
    error_message = "postgresql.backup_window_start must be HH:MM:SS in UTC, e.g. 00:02:00."
  }
  validation {
    condition     = var.postgresql.backup_retention_days >= 7 && var.postgresql.backup_retention_days <= 30 && floor(var.postgresql.backup_retention_days) == var.postgresql.backup_retention_days
    error_message = "postgresql.backup_retention_days must be 7-30 whole days (postgresql/backups#how-to-configure-automatic-backups)."
  }
}

variable "forbid_deletion" {
  description = "Terraform-level deletion guard on the MLflow and PostgreSQL clusters (the provider exposes no API deletion protection for them); null = the stage policy (on in prod)."
  type        = bool
  default     = null
}

# ---- secrets: write-only, from SecretStash or typed in -----------------------------------------

variable "mlflow_admin_password" {
  description = "MLflow admin password (write-only: never stored in state or plan). 8-64 characters with an uppercase letter, a lowercase letter, a digit and a special character. With secret_id: the secret's mlflow-admin-password entry, needed for the plan that is applied and for the apply."
  type        = string
  default     = null
  sensitive   = true
  ephemeral   = true

  validation {
    condition = var.mlflow_admin_password == null || (
      length(coalesce(var.mlflow_admin_password, "x")) >= 8 && length(coalesce(var.mlflow_admin_password, "x")) <= 64 &&
      can(regex("[A-Z]", coalesce(var.mlflow_admin_password, "x"))) && can(regex("[a-z]", coalesce(var.mlflow_admin_password, "x"))) &&
      can(regex("[0-9]", coalesce(var.mlflow_admin_password, "x"))) && can(regex("[^A-Za-z0-9]", coalesce(var.mlflow_admin_password, "x")))
    )
    error_message = "mlflow_admin_password must be 8-64 characters with at least one uppercase letter, one lowercase letter, one digit and one special character (mlflow/clusters/manage)."
  }
}

variable "postgresql_password" {
  description = "Password of the PostgreSQL bootstrap user (write-only). At least 8 characters with a lowercase letter, an uppercase letter and a special character. With secret_id: the secret's postgresql-password entry, needed for the plan that is applied and for the apply."
  type        = string
  default     = null
  sensitive   = true
  ephemeral   = true

  validation {
    condition = var.postgresql_password == null || (
      length(coalesce(var.postgresql_password, "x")) >= 8 &&
      can(regex("[A-Z]", coalesce(var.postgresql_password, "x"))) && can(regex("[a-z]", coalesce(var.postgresql_password, "x"))) &&
      can(regex("[^A-Za-z0-9]", coalesce(var.postgresql_password, "x")))
    )
    error_message = "postgresql_password must be at least 8 characters with one lowercase letter, one uppercase letter and one special character (postgresql/clusters/manage)."
  }
}

variable "secret_id" {
  description = "SecretStash secret (mbsec-...) holding mlflow-admin-password and/or postgresql-password (docs/credentials.md#secretstash). Set: a reviewed-only plan runs without the passwords; the plan that is applied, and the apply, read them from the secret into TF_VAR_mlflow_admin_password / TF_VAR_postgresql_password, so only the apply identity needs mysterybox.payload-viewer on it. null = the TF_VAR_* passwords set by hand, required for plans too."
  type        = string
  default     = null

  validation {
    condition     = var.secret_id == null || can(regex("^mbsec-[a-z0-9]+$", var.secret_id))
    error_message = "secret_id must be a SecretStash secret ID (mbsec-...)."
  }
}

variable "secret_version_id" {
  description = "SecretStash version (mbsecver-...) the passwords were read from; part of each cluster's sensitive.version, so pinning a new version re-sends the rotated passwords. null = the primary version (bump secrets_version to re-send instead)."
  type        = string
  default     = null

  validation {
    condition     = var.secret_version_id == null || can(regex("^mbsecver-[a-z0-9]+$", var.secret_version_id))
    error_message = "secret_version_id must be a SecretStash version ID (mbsecver-...)."
  }
}

variable "secrets_version" {
  description = "Version tag of the write-only passwords (stored in state; never a secret). Change it to re-send a rotated password typed into TF_VAR_*."
  type        = string
  default     = "1"
}

variable "labels" {
  description = "Labels applied to every resource (docs/cost.md). nip-run is required; nip-ttl-expires where the stage requires it; nip-region, nip-stage and nip-stack are added automatically (nip-env, deprecated, defaults to the stack)."
  type        = map(string)
  default = {
    "nip-env"   = "ml-services"
    "nip-owner" = "platform"
  }

  validation {
    condition     = try(length(var.labels["nip-run"]) > 0, false)
    error_message = "labels must carry nip-run (a ticket, date or run id) so leftovers can be attributed (docs/cost.md)."
  }
  validation {
    condition     = !yamldecode(file("${path.module}/../../../platform/stages.yaml")).stages[var.stage].policy.require_ttl_label || (can(regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$", lookup(var.labels, "nip-ttl-expires", ""))) && can(formatdate("YYYY", lookup(var.labels, "nip-ttl-expires", ""))))
    error_message = "this stage requires labels[\"nip-ttl-expires\"] as an RFC 3339 UTC timestamp, e.g. 2026-10-31T18:00:00Z (docs/cost.md)."
  }
}
