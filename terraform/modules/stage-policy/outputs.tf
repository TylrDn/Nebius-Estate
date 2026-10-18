output "violations" {
  description = "Every stage-policy rule the requested settings break; empty when the plan may proceed."
  value       = [for name, r in local.rules : r.msg if !r.ok]
}

output "policy" {
  description = "The stage's raw policy block from platform/stages.yaml."
  value       = local.policy
}

output "etcd_cluster_size" {
  description = "Resolved etcd member count (request, else the stage default)."
  value       = local.etcd_cluster_size
}

output "public_endpoint" {
  description = "Resolved control-plane exposure (request, else the stage default)."
  value       = local.public_endpoint
}

output "audit_logs" {
  description = "Resolved control-plane audit logging (request, else the stage default); R8 maps it to bucket audit logging."
  value       = local.audit_logs
}

output "forbid_deletion" {
  description = "Resolved deletion protection for data volumes (request, else the stage default)."
  value       = local.forbid_deletion
}

output "alertmanager" {
  description = "Resolved Alertmanager switch (request, else the stage default)."
  value       = local.alertmanager
}

output "k8s_version_max" {
  description = "Newest Kubernetes version this stage may run (platform/regions.yaml minus the stage offset)."
  value       = local.k8s_version_max
}
