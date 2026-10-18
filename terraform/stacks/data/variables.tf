variable "stage" {
  description = "Lifecycle stage this root belongs to (platform/stages.yaml): sandbox, staging or prod. Selects the policy the stack enforces at plan time (ADR-0009)."
  type        = string

  validation {
    condition     = contains(keys(yamldecode(file("${path.module}/../../../platform/stages.yaml")).stages), var.stage)
    error_message = "stage must be one of the stages in platform/stages.yaml (sandbox, staging, prod)."
  }
}

variable "parent_id" {
  description = "Nebius project ID that owns the buckets and the filesystem (project-...)."
  type        = string

  validation {
    condition     = startswith(var.parent_id, "project-")
    error_message = "parent_id must be a Nebius project ID (project-...)."
  }
}

variable "region" {
  description = "Nebius region (platform/regions.yaml)."
  type        = string
  default     = "eu-north1"

  validation {
    condition     = contains(keys(yamldecode(file("${path.module}/../../../platform/regions.yaml")).regions), var.region)
    error_message = "region is not in platform/regions.yaml."
  }
}

variable "name" {
  description = "Name prefix for the buckets and the shared filesystem. Bucket names are unique per region across all tenants (object-storage/overview#naming): the prefix plus the project id suffix keeps them unique."
  type        = string
  default     = "nip"

  validation {
    # <name>-<stage>-checkpoints-<12-char suffix> must stay within the 63-character S3 bucket name limit.
    condition     = can(regex("^[a-z][a-z0-9-]{0,19}$", var.name))
    error_message = "name must be lowercase letters, digits and hyphens, starting with a letter, at most 20 characters (bucket names are DNS labels of at most 63 characters)."
  }
}

variable "checkpoint_noncurrent_days" {
  description = "Days a replaced checkpoint version is kept before expiry (Object Storage lifecycle rule). Versioning lets a bad save be rolled back."
  type        = number
  default     = 14

  validation {
    condition     = var.checkpoint_noncurrent_days >= 1 && var.checkpoint_noncurrent_days <= 365
    error_message = "checkpoint_noncurrent_days must be 1-365."
  }
}

variable "dataset_storage_class" {
  description = "Default storage class for the dataset bucket: STANDARD, ENHANCED_THROUGHPUT (high-throughput training reads) or INTELLIGENT. null = the region's first offered class (platform/regions.yaml object_storage_classes): STANDARD, or ENHANCED_THROUGHPUT where STANDARD is not offered (uk-south1, uk-south2, eu-south1, eu-west2, us-north1). ENHANCED_THROUGHPUT's default quota is 1 TiB per region."
  type        = string
  default     = null

  validation {
    condition     = var.dataset_storage_class == null || contains(["STANDARD", "ENHANCED_THROUGHPUT", "INTELLIGENT"], coalesce(var.dataset_storage_class, "STANDARD"))
    error_message = "dataset_storage_class must be STANDARD, ENHANCED_THROUGHPUT, INTELLIGENT or null (the region default)."
  }
}

variable "enable_filesystem" {
  description = "Create a shared filesystem that R1/R3 attach through existing_filesystem_id, so staged data outlives any one cluster."
  type        = bool
  default     = true
}

variable "filesystem_size_gib" {
  description = "Shared filesystem size (GiB). Size for the working set staged from the dataset bucket, not the whole bucket."
  type        = number
  default     = 256
}

variable "filesystem_type" {
  description = "Shared filesystem type. NETWORK_SSD is the only type the docs offer (compute/storage/types#filesystem-specifications); the provider enum's NETWORK_HDD, WEKA and VAST are not self-service."
  type        = string
  default     = "NETWORK_SSD"

  validation {
    condition     = var.filesystem_type == "NETWORK_SSD"
    error_message = "filesystem_type must be NETWORK_SSD (the only documented shared filesystem type)."
  }
}

variable "filesystem_bucket" {
  description = "Also expose the shared filesystem through an Object Storage filesystem bucket rooted at /datasets, so S3 tools or the data transfer write straight onto the filesystem (object-storage/buckets/filesystem-buckets). Preview: no SLA, no lifecycle rules or versioning. Needs enable_filesystem."
  type        = bool
  default     = false
}

variable "forbid_deletion" {
  description = "API-level deletion protection on the shared filesystem; null = the stage policy (on in prod)."
  type        = bool
  default     = null
}

variable "transfer" {
  description = "Optional one-off copy (one iteration) from an external S3-compatible bucket into the dataset bucket (object-storage/transfer). The destination key needs storage.object-editor on the dataset bucket (object-storage/transfer/access). Secrets never go in tfvars: TF_VAR_transfer_source_secret_key / TF_VAR_transfer_destination_secret_key (write-only), set by hand or read from the SecretStash secret transfer_secret_id."
  type = object({
    source_endpoint            = string
    source_region              = string
    source_bucket              = string
    source_prefix              = optional(string, "")
    source_access_key_id       = optional(string) # null = anonymous (public bucket)
    destination_access_key_id  = string           # access key of a service account with write access to the dataset bucket
    destination_prefix         = optional(string, "")
    overwrite_strategy         = optional(string, "NEVER")
    bandwidth_bytes_per_second = optional(number)      # null = service default (50 GiB/s)
    requests_per_second        = optional(number)      # null = service default (4000/s); lower it for rate-limited sources
    to_filesystem              = optional(bool, false) # write into the filesystem bucket (filesystem_bucket = true) instead of the dataset bucket
    secrets_version            = optional(string, "1") # change to re-send rotated secret keys
  })
  default = null

  validation {
    condition     = var.transfer == null || contains(["NEVER", "IF_NEWER"], try(var.transfer.overwrite_strategy, "NEVER"))
    error_message = "transfer.overwrite_strategy must be NEVER (safest) or IF_NEWER (incremental sync)."
  }
  validation {
    condition     = var.transfer == null || can(regex("^https://\\S+[^/]$", try(var.transfer.source_endpoint, "")))
    error_message = "transfer.source_endpoint must be an https:// URL without a trailing slash (object-storage/transfer/requirements)."
  }
}

variable "transfer_source_secret_key" {
  description = "Secret key for transfer.source_access_key_id (write-only: never stored in state or plan). With transfer_secret_id: the secret's source-secret-access-key entry, needed for the plan that is applied and for the apply."
  type        = string
  default     = null
  sensitive   = true
  ephemeral   = true
}

variable "transfer_destination_secret_key" {
  description = "Secret key for transfer.destination_access_key_id (write-only). With transfer_secret_id: the secret's destination-secret-access-key entry, needed for the plan that is applied and for the apply."
  type        = string
  default     = null
  sensitive   = true
  ephemeral   = true
}

variable "transfer_secret_id" {
  description = "SecretStash secret (mbsec-...) holding the transfer's secret keys under destination-secret-access-key and, for a keyed source, source-secret-access-key (docs/credentials.md#secretstash). Set: a reviewed-only plan runs without the keys; the plan that is applied, and the apply, read them from the secret into TF_VAR_transfer_*_secret_key, so only the apply identity needs mysterybox.payload-viewer on it. null = TF_VAR_transfer_*_secret_key set by hand, required for plans too."
  type        = string
  default     = null

  validation {
    condition     = var.transfer_secret_id == null || can(regex("^mbsec-[a-z0-9]+$", var.transfer_secret_id))
    error_message = "transfer_secret_id must be a SecretStash secret ID (mbsec-...)."
  }
}

variable "transfer_secret_version_id" {
  description = "SecretStash version (mbsecver-...) the keys were read from; part of the transfer's sensitive.version, so pinning a new version re-sends rotated keys. null = the primary version (bump transfer.secrets_version to re-send instead)."
  type        = string
  default     = null

  validation {
    condition     = var.transfer_secret_version_id == null || can(regex("^mbsecver-[a-z0-9]+$", var.transfer_secret_version_id))
    error_message = "transfer_secret_version_id must be a SecretStash version ID (mbsecver-...)."
  }
}

variable "labels" {
  description = "Labels applied to every resource (docs/cost.md). nip-run is required; nip-ttl-expires where the stage requires it; nip-region, nip-stage and nip-stack are added automatically (nip-env, deprecated, defaults to the stack)."
  type        = map(string)
  default = {
    "nip-env"   = "data"
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
