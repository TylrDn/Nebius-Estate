output "service_account_id" {
  description = "NIP_SA_ID for scripts/ci-token.sh."
  value       = nebius_iam_v1_service_account.this.id
}

output "public_key_id" {
  description = "NIP_SA_KEY_ID for scripts/ci-token.sh when Terraform registered the key; null otherwise (the key id is the .metadata.id printed by `nebius iam auth-public-key create`)."
  value       = try(nebius_iam_v1_auth_public_key.this[0].id, null)
}

output "role" {
  description = "Project role the identity holds (editor = apply, viewer = plan)."
  value       = nebius_iam_v1_access_permit.project.role
}
