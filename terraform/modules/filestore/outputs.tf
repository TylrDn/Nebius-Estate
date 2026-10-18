output "id" {
  value = local.id
}

output "name" {
  description = "Name of the created filesystem (null when an existing one is reused)."
  value       = var.existing_filesystem_id == null ? var.name : null
}

output "attachment" {
  description = "Pass to modules/node-group `filesystem`."
  value = {
    id         = local.id
    mount_tag  = var.mount_tag
    mount_path = var.mount_path
  }
}


output "forbid_deletion" {
  description = "API-level deletion protection on the created filesystem (false for a reused one)."
  value       = var.existing_filesystem_id == null ? one(nebius_compute_v1_filesystem.this).forbid_deletion : false
}
