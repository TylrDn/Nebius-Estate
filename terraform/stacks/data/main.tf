# R8: dataset and checkpoint data plane (docs.nebius.com/object-storage, /compute/storage).
# Two buckets with different lifecycles (datasets: read-mostly, no versioning; checkpoints:
# versioned so a bad save can be rolled back, old versions expire), a shared filesystem that R1/R3
# attach through existing_filesystem_id so staged data outlives any one cluster, and an optional
# Object Storage data transfer that pulls an external S3-compatible bucket into the dataset bucket.

locals {
  labels = merge({ "nip-env" = "data" }, var.labels, { "nip-region" = var.region, "nip-stage" = var.stage, "nip-stack" = "data" })
  # Bucket names are unique per region across all tenants (object-storage/overview#naming); the
  # project id suffix keeps one per project and stage.
  suffix = substr(replace(var.parent_id, "project-", ""), 0, 12)
  # Abandoned multipart uploads (interrupted dataset copies) are billed until aborted. Explicit,
  # because only buckets created on or after 2026-11-09 get the 30-day default (object-storage/objects/lifecycles).
  abort_multipart = { id = "abort-incomplete-multipart", status = "ENABLED", abort_incomplete_multipart_upload = { days_after_initiation = 7 } }
  # Where the stage requires audit logs (platform/stages.yaml), every write and delete is logged.
  object_audit_logging = module.stage_policy.audit_logs ? "MUTATE_ONLY" : null
  # Classes this region offers (platform/regions.yaml, object-storage/storage-classes): STANDARD and
  # INTELLIGENT are absent in uk-south1, uk-south2, eu-south1, eu-west2 and us-north1.
  storage_classes       = try(yamldecode(file("${path.module}/../../../platform/regions.yaml")).regions[var.region].object_storage_classes, ["STANDARD", "ENHANCED_THROUGHPUT", "INTELLIGENT"])
  dataset_storage_class = coalesce(var.dataset_storage_class, local.storage_classes[0])
  filesystem_bucket     = var.enable_filesystem && var.filesystem_bucket
  transfer_from_secret  = var.transfer != null && var.transfer_secret_id != null
  # sensitive.version must not carry a secret: with SecretStash it names the secret and the
  # pinned version, so pinning a new version re-sends the rotated keys.
  transfer_secrets_version = var.transfer == null ? null : (local.transfer_from_secret ? join("/", compact([var.transfer.secrets_version, var.transfer_secret_id, var.transfer_secret_version_id])) : var.transfer.secrets_version)
}

module "stage_policy" {
  source = "../../modules/stage-policy"

  stage                       = var.stage
  ttl_expires                 = lookup(var.labels, "nip-ttl-expires", null)
  stack                       = "data"
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
    # Transfer secret keys come from exactly one path: SecretStash (transfer_secret_id; the
    # values are read from the secret into the same ephemeral variables before the plan that is
    # applied), or TF_VAR_transfer_*_secret_key set by hand. With SecretStash a reviewed-only plan
    # may run without them, because the plan identity cannot read payloads; an apply may not.
    precondition {
      condition     = var.transfer == null || local.transfer_from_secret || var.transfer_destination_secret_key != null
      error_message = "transfer needs transfer_secret_id (SecretStash) or TF_VAR_transfer_destination_secret_key."
    }
    precondition {
      condition     = try(var.transfer.source_access_key_id, null) == null || local.transfer_from_secret || var.transfer_source_secret_key != null
      error_message = "transfer.source_access_key_id needs transfer_secret_id (SecretStash) or TF_VAR_transfer_source_secret_key (leave the key id null for a public source)."
    }
    precondition {
      condition     = var.transfer_secret_id == null || var.transfer != null
      error_message = "transfer_secret_id is set but there is no transfer to read it for."
    }
    precondition {
      condition     = !local.transfer_from_secret || !terraform.applying || (var.transfer_destination_secret_key != null && (try(var.transfer.source_access_key_id, null) == null || var.transfer_source_secret_key != null))
      error_message = "transfer_secret_id is set: export TF_VAR_transfer_destination_secret_key (and TF_VAR_transfer_source_secret_key for a keyed source) from that secret before the plan you apply (docs/credentials.md#secretstash)."
    }
    precondition {
      condition     = !var.filesystem_bucket || var.enable_filesystem
      error_message = "filesystem_bucket needs enable_filesystem = true."
    }
    precondition {
      condition     = !try(var.transfer.to_filesystem, false) || local.filesystem_bucket
      error_message = "transfer.to_filesystem needs filesystem_bucket = true (and enable_filesystem)."
    }
  }
}

resource "nebius_storage_v1_bucket" "datasets" {
  parent_id               = var.parent_id
  name                    = "${var.name}-${var.stage}-datasets-${local.suffix}"
  versioning_policy       = "DISABLED"
  default_storage_class   = local.dataset_storage_class
  object_audit_logging    = local.object_audit_logging
  lifecycle_configuration = { rules = [local.abort_multipart] }
  labels                  = local.labels

  lifecycle {
    precondition {
      condition     = contains(local.storage_classes, local.dataset_storage_class)
      error_message = "dataset_storage_class ${local.dataset_storage_class} is not offered in ${var.region}; use one of ${join(", ", local.storage_classes)} (platform/regions.yaml, object-storage/storage-classes)."
    }
  }
}

resource "nebius_storage_v1_bucket" "checkpoints" {
  parent_id         = var.parent_id
  name              = "${var.name}-${var.stage}-checkpoints-${local.suffix}"
  versioning_policy = "ENABLED"
  # Explicit: the provider falls back to STANDARD, which some regions do not offer.
  default_storage_class = local.storage_classes[0]
  object_audit_logging  = local.object_audit_logging
  lifecycle_configuration = {
    rules = [
      local.abort_multipart,
      {
        id                            = "expire-replaced-checkpoints"
        status                        = "ENABLED"
        noncurrent_version_expiration = { noncurrent_days = var.checkpoint_noncurrent_days }
      },
      # Once a deleted checkpoint's old versions have expired, its delete marker is all that is
      # left; remove it so listings and request counts stay clean.
      {
        id         = "remove-orphan-delete-markers"
        status     = "ENABLED"
        expiration = { expired_object_delete_marker = true }
      },
    ]
  }
  labels = local.labels
}

module "filesystem" {
  source = "../../modules/filestore"
  count  = var.enable_filesystem ? 1 : 0

  parent_id       = var.parent_id
  name            = "${var.name}-${var.stage}-data"
  type            = var.filesystem_type
  size_gib        = var.filesystem_size_gib
  forbid_deletion = module.stage_policy.forbid_deletion
  labels          = local.labels
}

# Optional S3 view of the shared filesystem (preview, no SLA): files under /datasets are objects, and
# objects written here (aws s3, rclone, the transfer below) land on the filesystem without a copy Job.
# No lifecycle rules or versioning on this bucket type (object-storage/buckets/filesystem-buckets).
resource "nebius_storage_v1_bucket" "filesystem" {
  count                = local.filesystem_bucket ? 1 : 0
  parent_id            = var.parent_id
  name                 = "${var.name}-${var.stage}-fs-${local.suffix}"
  object_audit_logging = local.object_audit_logging
  labels               = local.labels

  filesystem_bucket = {
    filesystem_id = module.filesystem[0].id
    directory     = "/datasets"
  }
}

# One-off pull: stops after one full iteration. Secrets are write-only (never in state or plan),
# from ephemeral variables filled by hand or from a SecretStash secret (transfer_secret_id). The
# docs' ephemeral `nebius_mysterybox_v1_secret_payload_entry` resource is not used here because
# `terraform test` mock providers reject any configuration that contains an ephemeral resource.
resource "nebius_storage_v1_transfer" "ingest" {
  count     = var.transfer == null ? 0 : 1
  parent_id = var.parent_id
  name      = "${var.name}-${var.stage}-ingest"

  source = {
    prefix = var.transfer.source_prefix
    s3_compatible = {
      endpoint    = var.transfer.source_endpoint
      region      = var.transfer.source_region
      bucket_name = var.transfer.source_bucket
      access_key  = var.transfer.source_access_key_id == null ? null : { access_key_id = var.transfer.source_access_key_id }
      anonymous   = var.transfer.source_access_key_id == null ? {} : null
    }
  }
  destination = {
    prefix = var.transfer.destination_prefix
    nebius = {
      # to_filesystem without the filesystem bucket is refused by terraform_data.stage_policy.
      bucket_name = try(var.transfer.to_filesystem, false) && local.filesystem_bucket ? one(nebius_storage_v1_bucket.filesystem[*].name) : nebius_storage_v1_bucket.datasets.name
      region      = var.region
      access_key  = { access_key_id = var.transfer.destination_access_key_id }
    }
  }
  sensitive = {
    source = var.transfer.source_access_key_id == null ? null : {
      s3_compatible = { access_key = { secret_access_key = var.transfer_source_secret_key } }
    }
    destination = { nebius = { access_key = { secret_access_key = var.transfer_destination_secret_key } } }
    # Change to re-send rotated secrets (stored in state; never a secret itself).
    version = local.transfer_secrets_version
  }
  overwrite_strategy  = var.transfer.overwrite_strategy
  after_one_iteration = {}
  limiters = var.transfer.bandwidth_bytes_per_second == null && var.transfer.requests_per_second == null ? null : {
    bandwidth_bytes_per_second = var.transfer.bandwidth_bytes_per_second
    requests_per_second        = var.transfer.requests_per_second
  }
  labels = local.labels
}
