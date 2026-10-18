output "projects" {
  description = "Project ID per stage (created or passed in)."
  value       = local.project_ids
}

output "state_buckets" {
  description = "State bucket name per stage: the `bucket` for that stage's backend.hcl (key = stages/<stage>/<stack>.tfstate)."
  value       = { for k, m in module.state_bucket : k => m.name }
}

output "state_identities" {
  description = "NIP_STATE_SA_ID / NIP_STATE_GROUP_ID per stage for scripts/bootstrap-backend.sh."
  value       = { for k, m in module.state_identity : k => { service_account_id = m.service_account_id, group_id = m.group_id } }
}

output "ci_plan_state_identities" {
  description = "Read-only state account (storage.object-viewer on the bucket) per CI stage: mint the \"<stage>-plan\" environment's NIP_STATE_ACCESS_KEY_ID / NIP_STATE_SECRET_ACCESS_KEY for it (runbooks/credential-rotation.md). The \"<stage>\" environment keeps the state_identities (editor) key."
  value       = { for k, m in module.state_reader_identity : k => { service_account_id = m.service_account_id, group_id = m.group_id } }
}

output "ci_identities" {
  description = "Apply identity (editor) per stage: NIP_SA_ID for the \"<stage>\" GitHub Environment. public_key_id is null unless Terraform registered the key; NIP_SA_KEY_ID is then the id printed by `nebius iam auth-public-key create` (docs/credentials.md)."
  value       = { for k, m in module.ci_identity : k => { service_account_id = m.service_account_id, public_key_id = m.public_key_id } }
}

output "ci_plan_identities" {
  description = "Plan identity (viewer) per stage: NIP_SA_ID for the \"<stage>-plan\" GitHub Environment. public_key_id is null unless Terraform registered the key (see ci_identities)."
  value       = { for k, m in module.ci_plan_identity : k => { service_account_id = m.service_account_id, public_key_id = m.public_key_id } }
}

output "ci_secret_grants" {
  description = "SecretStash secrets whose payloads each stage's apply identity may read (mysterybox.payload-viewer, one access permit per secret)."
  value       = { for name, s in local.ci_secret_readers : name => distinct(s.ci_secret_ids) }
}

output "ci_federation" {
  description = "Per GitHub Environment (<stage>, <stage>-plan): NIP_SA_ID and the sub claim it must present on the federated path (R13). Empty without ci_federation."
  value       = try(module.ci_federation[0].github_environments, {})
}

output "team_groups" {
  description = "Team group id and permits per key (R13). Empty without team_groups."
  value       = try(module.ci_federation[0].team_groups, {})
}
