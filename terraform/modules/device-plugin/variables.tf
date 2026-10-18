variable "cluster_id" {
  type = string
}

variable "parent_id" {
  type = string
}

variable "dcgm_exporter_enabled" {
  description = "Export per-GPU utilisation/memory/temperature metrics for Prometheus."
  type        = bool
  default     = true
}
