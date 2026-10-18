output "cluster_id" {
  value = module.cluster.id
}

output "cluster_name" {
  value = module.cluster.name
}

output "cluster_public_endpoint" {
  value = module.cluster.public_endpoint
}

output "cluster_private_endpoint" {
  value = module.cluster.private_endpoint
}

output "cluster_ca_certificate" {
  sensitive = true
  value     = module.cluster.cluster_ca_certificate
}

output "gpu_cluster" {
  value = length(module.gpu_cluster) > 0 ? {
    id                = module.gpu_cluster[0].id
    infiniband_fabric = module.gpu_cluster[0].infiniband_fabric
  } : null
}

output "node_groups" {
  value = {
    cpu = { id = module.cpu_nodes.id, platform = var.cpu_platform, preset = var.cpu_preset, count = var.cpu_node_count }
    gpu = { id = try(module.gpu_nodes[0].id, null), platform = local.gpu_platform, preset = local.gpu_preset, count = var.gpu_node_count, drivers = var.enable_gpu_operator ? "gpu-operator" : local.gpu_drivers_preset }
  }
}

output "filestore" {
  value = var.enable_filestore ? {
    id            = module.filestore[0].id
    mount_path    = var.filestore_mount_path
    storage_class = module.filestore_csi[0].storage_class
  } : null
}

output "grafana_admin_password" {
  description = "Generated Grafana admin password (held in state); null when it comes from SecretStash (grafana_admin_secret_id)."
  sensitive   = true
  value       = var.enable_o11y ? module.o11y[0].grafana_admin_password : null
}

output "stage" {
  description = "Lifecycle stage this root was planned for (platform/stages.yaml)."
  value       = var.stage
}

output "k8s_host" {
  description = "Control-plane endpoint the Kubernetes/Helm providers in the live root talk to (public or private per the stage policy)."
  value       = local.public_endpoint ? module.cluster.public_endpoint : module.cluster.private_endpoint
}

output "public_endpoint_enabled" {
  description = "Whether the control plane has a public endpoint (stage policy or override)."
  value       = local.public_endpoint
}

output "o11y_provisioning" {
  description = "What the in-cluster Grafana and Prometheus are sent (no values): Nebius data sources and the input they still need, alert rule groups, Alertmanager receiver source. recipes/observability/acceptance.sh checks the cluster against it (O11Y_PROVISIONING)."
  value       = var.enable_o11y ? module.o11y[0].provisioning : null
}
