output "id" {
  description = "Bucket ID (the resource a state-identity permit is scoped to)."
  value       = nebius_storage_v1_bucket.this.id
}

output "name" {
  description = "Bucket name for backend.hcl."
  value       = nebius_storage_v1_bucket.this.name
}
