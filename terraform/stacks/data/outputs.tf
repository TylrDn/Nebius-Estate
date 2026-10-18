output "stage" {
  description = "Stage this root was planned for."
  value       = var.stage
}

output "dataset_bucket" {
  description = "Dataset bucket name (read-mostly; workloads/data/copy-job stages a prefix onto the shared filesystem)."
  value       = nebius_storage_v1_bucket.datasets.name
}

output "checkpoint_bucket" {
  description = "Versioned checkpoint bucket name; replaced versions expire after checkpoint_noncurrent_days."
  value       = nebius_storage_v1_bucket.checkpoints.name
}

output "filesystem_id" {
  description = "Shared filesystem; pass to R1/R3 as existing_filesystem_id (null when enable_filesystem = false)."
  value       = var.enable_filesystem ? module.filesystem[0].id : null
}

output "filesystem_bucket" {
  description = "Filesystem bucket name (S3 view of the shared filesystem at /datasets); null unless filesystem_bucket = true."
  value       = one(nebius_storage_v1_bucket.filesystem[*].name)
}

output "s3_endpoint" {
  description = "S3 endpoint for this region (aws CLI, rclone, boto3)."
  value       = "https://storage.${var.region}.nebius.cloud"
}
