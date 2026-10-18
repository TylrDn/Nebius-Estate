output "id" {
  value = nebius_mk8s_v1_cluster.this.id
}

output "name" {
  value = nebius_mk8s_v1_cluster.this.name
}

output "public_endpoint" {
  value = try(nebius_mk8s_v1_cluster.this.status.control_plane.endpoints.public_endpoint, null)
}

output "private_endpoint" {
  value = try(nebius_mk8s_v1_cluster.this.status.control_plane.endpoints.private_endpoint, null)
}

output "cluster_ca_certificate" {
  sensitive = true
  value     = try(nebius_mk8s_v1_cluster.this.status.control_plane.auth.cluster_ca_certificate, null)
}

output "version" {
  value = try(nebius_mk8s_v1_cluster.this.status.control_plane.version, null)
}

output "allowed_cidrs" {
  description = "CIDR allowlist applied to the public endpoint (null when the endpoint is private or unrestricted)."
  value       = try(nebius_mk8s_v1_cluster.this.control_plane.endpoints.public_endpoint.allowed_cidrs, null)
}

output "audit_logs_enabled" {
  description = "Whether the Kubernetes audit log is pushed to service logs."
  value       = nebius_mk8s_v1_cluster.this.control_plane.audit_logs != null
}

output "public_endpoint_enabled" {
  description = "Whether the control plane has a public endpoint."
  value       = nebius_mk8s_v1_cluster.this.control_plane.endpoints.public_endpoint != null
}

output "service_cidr" {
  description = "Requested Kubernetes Service range (null = the API default /16)."
  value       = try(nebius_mk8s_v1_cluster.this.kube_network.service_cidrs[0], null)
}
