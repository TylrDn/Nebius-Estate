variable "cluster_id" {
  type = string
}

variable "parent_id" {
  type = string
}

variable "limit_cpu" {
  type    = string
  default = "500m"
}

variable "limit_memory" {
  type    = string
  default = "1Gi"
}
