variable "parent_id" {
  type = string
}

variable "name" {
  description = "Filesystem name, <cluster>-shared-fs in the stacks (docs/naming.md). No default: filesystem names are unique in the whole tenant and cannot be changed after creation, so the caller always passes a stage-qualified name."
  type        = string
}

variable "existing_filesystem_id" {
  description = "Reuse an existing filesystem instead of creating one."
  type        = string
  default     = null
}

variable "type" {
  description = "Filesystem type. NETWORK_SSD is the only documented type (compute/storage/types#filesystem-specifications)."
  type        = string
  default     = "NETWORK_SSD"

  validation {
    condition     = var.type == "NETWORK_SSD"
    error_message = "type must be NETWORK_SSD (compute/storage/types#filesystem-specifications)."
  }
}

variable "size_gib" {
  description = "Size in GiB (1-104,857,600); can only grow after creation. Model caches for a 7B model need ~20 GiB; keep small for a lab. Bandwidth scales per 4 TiB; up to 256 GiB the inode limit is 4,194,304 (compute/storage/types)."
  type        = number
  default     = 64

  validation {
    condition     = var.size_gib >= 1 && var.size_gib <= 104857600
    error_message = "size_gib must be 1-104,857,600 (compute/storage/types#filesystem-specifications)."
  }
}

variable "block_size_kib" {
  description = "Block size in KiB: a power of two from 4 to 128, fixed at creation. Maximum file size = 512 GiB x this value."
  type        = number
  default     = 4

  validation {
    condition     = contains([4, 8, 16, 32, 64, 128], var.block_size_kib)
    error_message = "block_size_kib must be 4, 8, 16, 32, 64 or 128 (compute/storage/manage#type-encryption-and-size)."
  }
}

variable "forbid_deletion" {
  description = "Protect the filesystem from `terraform destroy`. Keep false for labs so teardown is complete."
  type        = bool
  default     = false
}

variable "mount_tag" {
  type    = string
  default = "data"
}

variable "mount_path" {
  type    = string
  default = "/mnt/data"
}

variable "labels" {
  type    = map(string)
  default = {}
}
