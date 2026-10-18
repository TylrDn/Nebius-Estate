variable "project_id" {
  description = "Stage project the role is granted on."
  type        = string
}

variable "role" {
  description = "Project role: editor (apply identity) or viewer (plan identity)."
  type        = string
  default     = "editor"

  validation {
    condition     = contains(["editor", "viewer"], var.role)
    error_message = "role must be editor or viewer: a CI identity never holds admin or a tenant-level role."
  }
}

variable "name" {
  description = "Service account and group name, e.g. nip-ci-staging or nip-ci-plan-staging."
  type        = string
}

variable "public_key_pem" {
  description = "PEM public key whose private half lives only in the CI secret store. Leave null (the default) and register keys with `nebius iam auth-public-key create`: the docs do not allow the first key through Terraform, nor any key while the provider uses a user token (iam/service-accounts/authorized-keys#uploading-the-public-key)."
  type        = string
  default     = null
}

variable "key_expires_at" {
  description = "RFC 3339 expiry of the authorized key; rotate before it (runbooks/credential-rotation.md)."
  type        = string
  default     = null
}

variable "labels" {
  description = "Resource labels."
  type        = map(string)
  default     = {}
}
