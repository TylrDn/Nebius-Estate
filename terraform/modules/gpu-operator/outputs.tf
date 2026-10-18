output "release_id" {
  description = "Marketplace release ID."
  value       = nebius_applications_v1alpha1_k8s_release.this.id
}

output "driver_version" {
  description = "Driver version passed to the chart (null = chart default)."
  value       = var.driver_version
}
