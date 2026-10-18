# One versioned Terraform-state bucket per stage (ADR-0005, ADR-0009). Versioning is the
# recovery mechanism; the lifecycle rule bounds how many old state versions are kept.

resource "nebius_storage_v1_bucket" "this" {
  parent_id         = var.project_id
  name              = var.name
  versioning_policy = "ENABLED"
  labels            = var.labels

  # State is the recovery point for every stage (ADR-0005): Terraform refuses to plan its deletion.
  lifecycle {
    prevent_destroy = true
  }

  lifecycle_configuration = {
    rules = [{
      id     = "expire-noncurrent-state-versions"
      status = "ENABLED"
      noncurrent_version_expiration = {
        noncurrent_days           = var.noncurrent_version_days
        newer_noncurrent_versions = var.keep_noncurrent_versions
      }
    }]
  }
}
