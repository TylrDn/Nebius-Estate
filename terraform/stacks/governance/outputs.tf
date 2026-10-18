output "stage" {
  description = "Stage this root was planned for."
  value       = var.stage
}

output "pricing_policy_ids" {
  description = "Spot pricing policy ID per GPU platform. Pass the one for the node group's platform to R1/R3 as gpu_spot_pricing_policy_id."
  value       = { for p, r in nebius_billing_v1_pricing_policy.spot_cap : p => r.id }
}

output "pricing_policy_states" {
  description = "Scheduling state per capped platform after apply: SCHEDULING_STATE_BLOCKED means the cap is below the current spot price and no VM under it can start."
  value       = { for p, r in nebius_billing_v1_pricing_policy.spot_cap : p => try(r.status.scheduling_state, null) }
}

output "capacity_allowances" {
  description = "Project limit per capacity block group key: id, configured limit and reported usage (GPUs)."
  value = {
    for k, r in nebius_capacity_v1_capacity_allowance.project_limit : k => {
      id                      = r.id
      capacity_block_group_id = r.capacity_block_group_id
      limit                   = r.limit
      usage                   = try(r.status.usage, null)
    }
  }
}

output "stage_gpu_ceiling" {
  description = "Upper bound for any project limit in this stage (sum of max_gpu_nodes x 8, platform/stages.yaml)."
  value       = local.stage_gpu_ceiling
}

output "quota_usage" {
  description = "Usage of each watched quota. limit is what the API returned: null or 0 when it omitted the field (proto3 JSON leaves zero values out), so the console figure is the authority."
  value = {
    for q, d in data.nebius_quotas_v1_quota_allowance.watch : q => {
      usage       = try(d.status.usage, null)
      usage_state = try(d.status.usage_state, null)
      limit       = try(d.limit, null)
      unit        = try(d.status.unit, null)
    }
  }
}
