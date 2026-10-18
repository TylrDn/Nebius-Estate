output "id" {
  value = nebius_mk8s_v1_node_group.this.id
}

output "name" {
  value = nebius_mk8s_v1_node_group.this.name
}

output "node_count" {
  value = try(nebius_mk8s_v1_node_group.this.status.node_count, null)
}

output "reservation_policy" {
  description = "Capacity reservation on the template (null = on-demand)."
  value       = nebius_mk8s_v1_node_group.this.template.reservation_policy
}

output "security_group_ids" {
  description = "Security group ids attached to the node interface."
  value       = try([for sg in nebius_mk8s_v1_node_group.this.template.network_interfaces[0].security_groups : sg.id], [])
}

output "preemptible" {
  description = "Whether the template asks for interruptible capacity."
  value       = nebius_mk8s_v1_node_group.this.template.preemptible != null
}
