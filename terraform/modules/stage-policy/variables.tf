variable "stage" {
  description = "Stage from platform/stages.yaml."
  type        = string
}

variable "stack" {
  description = "Stack name; selects per-stack caps (max_gpu_nodes, require_strict_reservation) and defaults to 0 / false for stacks without GPUs."
  type        = string
}

variable "has_cluster" {
  description = "Whether the stack creates a Kubernetes cluster (enables the cluster-only rules)."
  type        = bool
  default     = true
}

variable "has_public_endpoint_control" {
  description = "Whether the stack exposes a control-plane endpoint governed by public_endpoint."
  type        = bool
  default     = true
}

# Requested settings; null = the stage default. A request may tighten the stage policy, never loosen it.
variable "etcd_cluster_size" {
  type    = number
  default = null
}

variable "public_endpoint" {
  type    = bool
  default = null
}

variable "audit_logs" {
  type    = bool
  default = null
}

variable "forbid_deletion" {
  type    = bool
  default = null
}

variable "alertmanager" {
  type    = bool
  default = null
}

# Facts the rules check.
variable "enable_o11y" {
  description = "Whether the stack installs the o11y stack (the alerting rule needs it where the stage requires Alertmanager)."
  type        = bool
  default     = true
}

variable "gpu_node_count" {
  description = "GPU nodes requested (with autoscaling: the maximum); checked against max_gpu_nodes.<stack>."
  type        = number
  default     = 0
}

variable "gpu_preemptible" {
  description = "Whether the GPU node group runs on preemptible capacity."
  type        = bool
  default     = false
}

variable "gpu_reservation_policy" {
  description = "Reservation policy of the GPU node group (\"STRICT\", \"AUTO\" or \"\" for none)."
  type        = string
  default     = ""
}

variable "allowed_cidrs" {
  description = "Allowlist for the public control-plane endpoint (R1/R3) or the bastion (R7)."
  type        = list(string)
  default     = []
}

variable "k8s_version" {
  description = "Requested Kubernetes version; null = the Managed Kubernetes default."
  type        = string
  default     = null
}

variable "public_bastion" {
  description = "Whether the stack exposes a bastion on a public address (R7); needs allowed_cidrs in every stage."
  type        = bool
  default     = false
}

variable "ttl_expires" {
  description = "The nip-ttl-expires label (RFC 3339 UTC); where the stage requires a TTL it must lie in the future and at most 7 days ahead of the plan. null = no label (the stack's variable validation requires one where the stage does)."
  type        = string
  default     = null
}
