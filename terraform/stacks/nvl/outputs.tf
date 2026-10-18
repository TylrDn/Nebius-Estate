output "stage" {
  description = "Stage this root was planned for."
  value       = var.stage
}

output "racks" {
  description = "Per rack: the NVLink instance group ID and the node group ID (empty while racks = 0)."
  value = {
    for k in local.racks : k => {
      nvl_instance_group_id = nebius_compute_v1_nvl_instance_group.rack[k].id
      node_group_id         = nebius_mk8s_v1_node_group.rack[k].id
    }
  }
}

output "shape" {
  description = "Platform, preset and size the stack plans: nodes and GPUs per rack and in total."
  value = {
    platform       = local.platform
    preset         = local.preset
    nodes_per_rack = local.nodes_per_rack
    gpus_per_rack  = local.nodes_per_rack * local.gpus_per_node
    nodes          = var.racks * local.nodes_per_rack
    gpus           = var.racks * local.nodes_per_rack * local.gpus_per_node
  }
}
