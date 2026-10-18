variable "parent_id" {
  description = "Project ID that owns the cluster."
  type        = string
}

variable "name" {
  description = "Cluster name."
  type        = string
}

variable "subnet_id" {
  description = "Subnet for the control plane."
  type        = string
}

variable "k8s_version" {
  description = "Kubernetes version; null = backend default."
  type        = string
  default     = null
}

variable "etcd_cluster_size" {
  description = "etcd members: 3 (HA) or 1."
  type        = number
  default     = 3
}

variable "service_cidr" {
  description = "Kubernetes Service range, a CIDR or a prefix length such as \"/20\" (/12 to /28), reserved inside subnet_id. null = the API default (/16)."
  type        = string
  default     = null
}

variable "public_endpoint" {
  description = "Expose the Kubernetes API on a public endpoint. false = private endpoint only: reach it from a VM in the cluster's subnet and region (https://docs.nebius.com/kubernetes/connect)."
  type        = bool
  default     = true
}

variable "allowed_cidrs" {
  description = "CIDR blocks allowed to reach the public endpoint (max 8). Empty = unrestricted, which the prod stage policy refuses."
  type        = list(string)
  default     = []

  validation {
    # The API wants host bits zero ("192.168.0.0/24", not "192.168.0.5/24"):
    # https://docs.nebius.com/kubernetes/networking/limit-access-to-public-endpoint
    condition     = length(var.allowed_cidrs) <= 8 && alltrue([for c in var.allowed_cidrs : can(cidrnetmask(c)) && try(cidrhost(c, 0) == split("/", c)[0], false)])
    error_message = "allowed_cidrs holds at most 8 IPv4 CIDR blocks with the host bits zero (e.g. 203.0.113.0/24, not 203.0.113.5/24)."
  }
}

variable "audit_logs" {
  description = "Push the Kubernetes audit log to Nebius service logs (off by default on the API; the prod stage policy turns it on)."
  type        = bool
  default     = false
}

variable "labels" {
  description = "Nebius resource labels."
  type        = map(string)
  default     = {}
}
