variable "iam_token" {
  description = "Nebius IAM token of an administrator (exported by scripts/bootstrap-backend.sh). Ephemeral: never written to plans or state."
  type        = string
  sensitive   = true
  ephemeral   = true
}

variable "tenant_id" {
  description = "Tenant that owns the stage projects (tenant-...)."
  type        = string

  validation {
    condition     = startswith(var.tenant_id, "tenant-")
    error_message = "tenant_id must be a Nebius tenant ID (tenant-...)."
  }
}

variable "name_prefix" {
  description = "Prefix for every foundation object (projects, buckets, groups, service accounts). scripts/bootstrap-backend.sh must be run with NIP_NAME_PREFIX set to the same value when it is not the default."
  type        = string
  default     = "nip"
}

variable "create_projects" {
  description = "Create a project per stage (needs tenant-level IAM). false = every stage passes an existing project_id, which is what a tenant that restricts tenant-level writes needs."
  type        = bool
  default     = false
}

variable "stages" {
  description = "Stages to provision, keyed by name from platform/stages.yaml. project_id null + create_projects = true creates the project. ci = true creates the apply (editor) and plan (viewer) CI service accounts; ci_secret_ids grants the apply account mysterybox.payload-viewer on those SecretStash secrets only (editor cannot read payloads; the plan account never needs to); register their authorized keys with `nebius iam auth-public-key create` (docs/credentials.md). ci_public_key_pem / ci_plan_public_key_pem upload a key through Terraform instead, which the docs allow only when this root authenticates with a service-account authorized key, and never for an account's first key (iam/service-accounts/authorized-keys#uploading-the-public-key)."
  type = map(object({
    project_id             = optional(string)
    region                 = string
    ci                     = optional(bool, false)
    ci_public_key_pem      = optional(string)
    ci_key_expires_at      = optional(string)
    ci_plan_public_key_pem = optional(string)
    ci_plan_key_expires_at = optional(string)
    ci_secret_ids          = optional(list(string), [])
  }))

  validation {
    condition = alltrue(flatten([
      for name, s in var.stages : [
        for k in [[s.ci_public_key_pem, s.ci_key_expires_at], [s.ci_plan_public_key_pem, s.ci_plan_key_expires_at]] :
        k[0] == null || (k[1] != null && can(formatdate("YYYY", coalesce(k[1], "x"))))
      ]
    ]))
    error_message = "every CI public key (ci_public_key_pem, ci_plan_public_key_pem) needs its expiry (ci_key_expires_at, ci_plan_key_expires_at) as an RFC 3339 timestamp (e.g. 2027-01-01T00:00:00Z): CI keys always expire (runbooks/credential-rotation.md)."
  }
  validation {
    condition     = alltrue(flatten([for name, s in var.stages : [for id in s.ci_secret_ids : can(regex("^mbsec-[a-z0-9]+$", id))]]))
    error_message = "ci_secret_ids holds SecretStash secret IDs (mbsec-...)."
  }
  validation {
    condition     = alltrue([for name, s in var.stages : length(s.ci_secret_ids) == 0 || s.ci])
    error_message = "ci_secret_ids needs ci = true for that stage: the grant goes to the stage's apply identity."
  }
}

variable "labels" {
  description = "Labels on every foundation resource."
  type        = map(string)
  default     = {}
}

variable "adopt_bootstrap" {
  description = <<-EOT
    Per stage, the ids of what scripts/bootstrap-backend.sh created before this root was applied
    (it prints them). Terraform imports them instead of failing on the name clash. Leave a stage
    out when the foundation creates everything. Any id may be null when that object does not exist.
  EOT
  type = map(object({
    bucket_id          = optional(string)
    service_account_id = optional(string)
    group_id           = optional(string)
    membership_id      = optional(string) # the service account's membership of that group
  }))
  default = {}

  validation {
    condition     = alltrue([for s, a in var.adopt_bootstrap : contains(["sandbox", "staging", "prod"], s)])
    error_message = "adopt_bootstrap keys are stage names (sandbox, staging, prod)."
  }
}

variable "ci_federation" {
  description = "GitHub OIDC federation for the CI identities (R13, modules/foundation/ci-federation). null = keys only (the default). repository = owner/name; repository_id and repository_owner_id = GitHub's immutable numeric ids, required unless subject_claims = \"name\". The subjects default to the <stage> (apply) and <stage>-plan (plan) GitHub Environments of every stage with ci = true, pinned by those ids (the repository's OIDC sub template must include them: runbooks/identity.md)."
  type = object({
    repository          = string
    repository_id       = optional(string)
    repository_owner_id = optional(string)
    subject_claims      = optional(string, "ids")
    issuer_url          = optional(string, "https://token.actions.githubusercontent.com")
    subjects = optional(map(object({
      apply = optional(string)
      plan  = optional(string)
    })), {})
  })
  default = null
}

variable "team_groups" {
  description = "Least-privilege, project-scoped team groups (modules/foundation/ci-federation `groups`): label => permit (role, resource_id null = the project) and label => member ID. admin, dsr.admin and tenant targets are refused."
  type = map(object({
    project_id = string
    permits    = map(object({ role = string, resource_id = optional(string) })) # label => permit
    members    = optional(map(string), {})                                      # label => account ID
  }))
  default = {}
}
