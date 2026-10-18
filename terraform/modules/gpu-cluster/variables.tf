variable "parent_id" {
  type = string
}

variable "name" {
  type = string
}

variable "infiniband_fabric" {
  description = "Fabric name for the region/platform, e.g. fabric-3 (H100, eu-north1). See https://docs.nebius.com/compute/clusters/gpu."
  type        = string

  validation {
    condition     = length(trimspace(var.infiniband_fabric)) > 0
    error_message = "infiniband_fabric must not be empty."
  }
}

variable "labels" {
  type    = map(string)
  default = {}
}
