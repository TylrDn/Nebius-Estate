variable "project_id" {
  description = "Project that owns the bucket (the stage's project)."
  type        = string
}

variable "name" {
  description = "Bucket name, e.g. tfstate-nip-sandbox-<hash>."
  type        = string
}

variable "noncurrent_version_days" {
  description = "Days after which an old state version expires (recovery window)."
  type        = number
  default     = 90
}

variable "keep_noncurrent_versions" {
  description = "Old versions always kept regardless of age."
  type        = number
  default     = 10
}

variable "labels" {
  description = "Resource labels."
  type        = map(string)
  default     = {}
}
