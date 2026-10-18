output "release_id" {
  description = "Marketplace release ID; changes when the release is recreated."
  value       = nebius_applications_v1alpha1_k8s_release.this.id
}
