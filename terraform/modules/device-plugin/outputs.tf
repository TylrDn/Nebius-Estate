output "status" {
  value = try(nebius_applications_v1alpha1_k8s_release.this.status, null)
}
