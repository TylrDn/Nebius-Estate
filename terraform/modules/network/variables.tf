variable "parent_id" {
  description = "Project ID that owns the subnet."
  type        = string
}

variable "subnet_id" {
  description = "Existing subnet ID. When null, subnet_name is looked up under parent_id."
  type        = string
  default     = null
}

variable "subnet_name" {
  description = "Subnet name to look up when subnet_id is null. No default: real default subnets are named default-subnet-<suffix>, so pass subnet_id (scripts/bootstrap-backend.sh exports the project default as TF_VAR_subnet_id; R7 outputs subnet_id)."
  type        = string
  default     = null
}
