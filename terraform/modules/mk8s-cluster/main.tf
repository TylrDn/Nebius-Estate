# Managed Kubernetes control plane. Mirrors nebius_mk8s_v1_cluster usage in
# nebius-solutions-library/k8s-training/main.tf.

resource "nebius_mk8s_v1_cluster" "this" {
  parent_id = var.parent_id
  name      = var.name
  labels    = var.labels

  control_plane = {
    version           = var.k8s_version
    subnet_id         = var.subnet_id
    etcd_cluster_size = var.etcd_cluster_size
    endpoints = {
      # allowed_cidrs: empty list means unrestricted on the API, so pass null instead of [].
      public_endpoint = var.public_endpoint ? {
        allowed_cidrs = length(var.allowed_cidrs) > 0 ? var.allowed_cidrs : null
      } : null
    }
    # Audit logs: the API's "configuration" object has no fields; presence turns it on.
    audit_logs = var.audit_logs ? {} : null
  }

  # The Service range is reserved inside subnet_id; null keeps the API default (a /16).
  kube_network = var.service_cidr == null ? null : { service_cidrs = [var.service_cidr] }
}
