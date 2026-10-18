variable "project_id" {
  description = "Stage project that owns the group and the service account."
  type        = string
}

variable "name" {
  description = "Name shared by the group and the service account, e.g. nip-tfstate-sandbox."
  type        = string
}

variable "bucket_id" {
  description = "State bucket the permit is scoped to."
  type        = string
}

variable "labels" {
  description = "Resource labels."
  type        = map(string)
  default     = {}
}

variable "role" {
  description = "Role on the state bucket: storage.object-editor (local runs, the apply job) or storage.object-viewer (the plan job: reads state, cannot write it or take the lock)."
  type        = string
  default     = "storage.object-editor"

  validation {
    condition     = contains(["storage.object-editor", "storage.object-viewer"], var.role)
    error_message = "role must be storage.object-editor or storage.object-viewer: a state identity never holds more than its bucket's objects."
  }
}
