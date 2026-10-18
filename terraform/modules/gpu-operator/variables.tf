variable "cluster_id" {
  type = string
}

variable "parent_id" {
  type = string
}

variable "enable_dcgm_exporter" {
  type    = bool
  default = true
}

variable "enable_dcgm_service_monitor" {
  type    = bool
  default = false
}

variable "mig_strategy" {
  description = "none | single | mixed; null leaves the chart default."
  type        = string
  default     = null

  validation {
    condition     = var.mig_strategy == null || contains(["none", "single", "mixed"], coalesce(var.mig_strategy, "x"))
    error_message = "mig_strategy must be none, single, mixed or null."
  }
}

variable "driver_version" {
  description = "NVIDIA driver version the operator installs (the docs set 580.95.05 on B300); null = chart default."
  type        = string
  default     = null
}

variable "cdi_enabled" {
  type    = bool
  default = null
}
