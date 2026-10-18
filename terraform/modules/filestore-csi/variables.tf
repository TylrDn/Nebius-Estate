variable "mount_path" {
  description = "Where the Filestore is mounted on the nodes (modules/filestore attachment.mount_path)."
  type        = string
}

variable "csi" {
  type = object({
    chart_repository                    = optional(string, "oci://cr.eu-north1.nebius.cloud/mk8s/helm")
    chart_version                       = optional(string, "0.1.10") # https://docs.nebius.com/kubernetes/storage/filesystem-over-csi
    namespace                           = optional(string, "kube-system")
    make_default_storage_class          = optional(bool, true)
    previous_default_storage_class_name = optional(string, "compute-csi-default-sc")
    # Taints the node DaemonSet must tolerate (chart default: none). The roots taint GPU nodes.
    tolerations = optional(list(object({
      key      = string
      operator = optional(string, "Exists")
      effect   = optional(string, "NoSchedule")
    })), [{ key = "nvidia.com/gpu" }])
  })
  default = {}

  validation {
    condition     = startswith(var.csi.chart_repository, "oci://")
    error_message = "csi.chart_repository must be an oci:// URL."
  }
}
