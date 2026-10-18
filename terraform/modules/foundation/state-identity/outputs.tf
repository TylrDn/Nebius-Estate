output "service_account_id" {
  description = "Set NIP_STATE_SA_ID to this for scripts/bootstrap-backend.sh."
  value       = nebius_iam_v1_service_account.this.id
}

output "group_id" {
  description = "Set NIP_STATE_GROUP_ID to this for scripts/bootstrap-backend.sh."
  value       = nebius_iam_v1_group.this.id
}

output "role" {
  description = "The role this identity holds on the state bucket."
  value       = nebius_iam_v1_access_permit.state.role
}
