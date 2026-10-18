variable "repository" {
  description = "GitHub repository whose workflows may act as the CI service accounts, as owner/name. It is the fixed prefix of every subject (repo:<owner>/<name>:...). Required when stages is set; may stay null for team groups alone."
  type        = string
  default     = null

  validation {
    condition     = var.repository == null || can(regex("^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$", coalesce(var.repository, "x")))
    error_message = "repository must be owner/name, e.g. example-org/nebius-infrastructure-patterns."
  }
}

variable "repository_id" {
  description = "GitHub's immutable numeric id of `repository` (gh api repos/<owner>/<name> --jq .id). With repository_owner_id it pins the default subjects to this exact repository, so a renamed, deleted or re-registered owner/name cannot match. Required unless subject_claims = \"name\"."
  type        = string
  default     = null

  validation {
    condition     = var.repository_id == null || can(regex("^[0-9]+$", coalesce(var.repository_id, "x")))
    error_message = "repository_id is GitHub's numeric repository id (gh api repos/<owner>/<name> --jq .id)."
  }
}

variable "repository_owner_id" {
  description = "GitHub's immutable numeric id of the repository owner (gh api repos/<owner>/<name> --jq .owner.id). Required unless subject_claims = \"name\"."
  type        = string
  default     = null

  validation {
    condition     = var.repository_owner_id == null || can(regex("^[0-9]+$", coalesce(var.repository_owner_id, "x")))
    error_message = "repository_owner_id is GitHub's numeric owner id (gh api repos/<owner>/<name> --jq .owner.id)."
  }
}

variable "subject_claims" {
  description = <<-EOT
    Shape of the default subjects. "ids" (default): repo:<owner>/<name>:repository_owner_id:<id>:repository_id:<id>:environment:<env>,
    which the repository must first enable as its OIDC sub template (include_claim_keys
    ["repo", "repository_owner_id", "repository_id", "context"]; README "Claim scoping"), so the
    trust survives no rename or re-registration of owner/name. "immutable": GitHub's immutable
    subject, repo:<owner>@<owner id>/<name>@<repository id>:environment:<env>, for repositories whose
    OIDC customization reports use_immutable_subject = true (gh api repos/<owner>/<name>/actions/oidc/customization/sub;
    its sub_claim_prefix is the part before :environment). Pinned to the ids with no template change.
    "name": GitHub's former default repo:<owner>/<name>:environment:<env>, which anyone who later holds
    that owner/name matches; an explicit, documented opt-in.
  EOT
  type        = string
  default     = "ids"

  validation {
    condition     = contains(["ids", "immutable", "name"], var.subject_claims) && (var.subject_claims == "name" || length(var.stages) == 0 || (var.repository_id != null && var.repository_owner_id != null))
    error_message = "subject_claims is \"ids\" (default) or \"immutable\" (GitHub's immutable subject), both needing repository_id and repository_owner_id, or \"name\" (opt-in: owner/name only, matchable after a rename or re-registration)."
  }
}

variable "issuer_url" {
  description = "OIDC issuer of the external tokens. The GitHub Actions issuer by default. The provider requires it to serve /.well-known/openid-configuration with a jwks_uri, unless jwk_set_json is given (terraform-provider/reference/resources/iam_v1_federated_credentials)."
  type        = string
  default     = "https://token.actions.githubusercontent.com"

  validation {
    condition     = startswith(var.issuer_url, "https://") && !endswith(var.issuer_url, "/")
    error_message = "issuer_url must be an https URL without a trailing slash (it must equal the token's iss claim)."
  }
}

variable "jwk_set_json" {
  description = "Optional JWKS (JSON) to verify token signatures with instead of the issuer's discovery document. Leave null for GitHub: its keys rotate, and a pinned copy would go stale."
  type        = string
  default     = null
}

variable "name_prefix" {
  description = "Prefix for every object this module names (the foundation's name_prefix)."
  type        = string
  default     = "nip"
}

variable "stages" {
  description = <<-EOT
    Per stage: the stage project and the two CI service accounts the foundation created
    (ci_identities / ci_plan_identities). Each account gets one federated credential whose subject
    is the GitHub environment its job runs in: "<stage>" for apply, "<stage>-plan" for plan.
    apply_subject / plan_subject override the default; they must stay inside `repository`, may not
    contain "*" (the docs describe no pattern matching), and apply_subject must name an environment.
    jobs picks which accounts get a credential (default both). It is an explicit list, not
    "whichever id is set", because the foundation passes ids that are unknown until apply and
    for_each keys must be known at plan time.
  EOT
  type = map(object({
    project_id               = string
    jobs                     = optional(set(string), ["apply", "plan"])
    apply_service_account_id = optional(string)
    plan_service_account_id  = optional(string)
    apply_subject            = optional(string)
    plan_subject             = optional(string)
  }))
  default = {}

  validation {
    condition     = length(var.stages) == 0 || var.repository != null
    error_message = "stages needs repository (owner/name): every subject is bound to it."
  }
  validation {
    condition     = alltrue([for name, s in var.stages : can(regex("^[a-z][a-z0-9-]*$", name))])
    error_message = "stage names are lower-case words (sandbox, staging, prod)."
  }
  validation {
    condition     = alltrue([for name, s in var.stages : startswith(s.project_id, "project-")])
    error_message = "stages.<stage>.project_id must be a project ID (project-...): federated credentials live beside the service account, never at the tenant."
  }
  validation {
    condition     = alltrue([for name, s in var.stages : length(setsubtract(s.jobs, ["apply", "plan"])) == 0])
    error_message = "stages.<stage>.jobs holds apply and/or plan."
  }
  validation {
    condition = alltrue(flatten([for name, s in var.stages : [
      for job in s.jobs : startswith(coalesce(job == "apply" ? s.apply_service_account_id : s.plan_service_account_id, "x"), "serviceaccount-")
    ]]))
    error_message = "every job in stages.<stage>.jobs needs its service account ID (apply_service_account_id / plan_service_account_id, serviceaccount-...)."
  }
  validation {
    condition = alltrue(flatten([for name, s in var.stages : [
      for sub in [s.apply_subject, s.plan_subject] : sub == null || startswith(coalesce(sub, "x"), "repo:${coalesce(var.repository, "-")}:") || (
        var.repository != null && var.repository_id != null && var.repository_owner_id != null &&
        startswith(coalesce(sub, "x"), "repo:${split("/", coalesce(var.repository, "-/-"))[0]}@${coalesce(var.repository_owner_id, "-")}/${split("/", coalesce(var.repository, "-/-"))[1]}@${coalesce(var.repository_id, "-")}:")
      )
    ]]))
    error_message = "every subject override must start with repo:<repository>: (or GitHub's immutable repo:<owner>@<owner id>/<name>@<repository id>:) so no other repository can use the identity."
  }
  validation {
    condition = alltrue(flatten([for name, s in var.stages : [
      for sub in [s.apply_subject, s.plan_subject] : sub == null || !strcontains(coalesce(sub, "x"), "*")
    ]]))
    error_message = "subjects are matched as given; the docs describe no wildcard, so \"*\" is refused rather than trusted."
  }
  validation {
    condition = alltrue(flatten([for name, s in var.stages : [
      for sub in [s.apply_subject, s.plan_subject] : sub == null || !strcontains(coalesce(sub, "x"), ":pull_request")
    ]]))
    error_message = "a pull_request subject is refused: any contributor's branch could then act as the stage."
  }
  validation {
    condition     = alltrue([for name, s in var.stages : s.apply_subject == null || strcontains(coalesce(s.apply_subject, "x"), ":environment:")])
    error_message = "apply_subject must name a GitHub environment (repo:<repository>:environment:<name>): the environment's reviewers and branch rules are what guard an apply."
  }
}

variable "groups" {
  description = <<-EOT
    Least-privilege custom groups for teams, each created INSIDE a project, so the API allows it
    permits only on that project and its resources (iam/authorization/groups/manage). permits: one
    role each, on the project (resource_id null) or on a resource that accepts permits (bucket,
    secret, registry, VM, IAM object). members: user or service account IDs. Both are maps keyed
    by a label you choose, so the IDs may be values Terraform learns only at apply. admin and
    dsr.admin are refused; grant them by hand, with a ticket.
  EOT
  type = map(object({
    project_id = string
    permits = map(object({
      role        = string
      resource_id = optional(string)
    }))
    members = optional(map(string), {})
  }))
  default = {}

  validation {
    condition     = alltrue([for name, g in var.groups : can(regex("^[a-z][a-z0-9-]*$", name))])
    error_message = "group keys are lower-case words; the group is named <name_prefix>-team-<key>."
  }
  validation {
    condition     = alltrue([for name, g in var.groups : startswith(g.project_id, "project-")])
    error_message = "groups.<name>.project_id must be a project ID (project-...): team groups are project-scoped, never tenant-wide."
  }
  validation {
    condition     = alltrue([for name, g in var.groups : length(g.permits) > 0])
    error_message = "a group needs at least one permit; a group without one grants nothing (iam/authorization/roles)."
  }
  validation {
    condition = alltrue(flatten([for name, g in var.groups : [for k, p in g.permits : contains([
      "auditor", "viewer", "editor", "security-auditor",
      "compute.instance-power-operator", "compute.serial-console-user", "compute.use-via-object-storage",
      "storage.viewer", "storage.uploader", "storage.editor", "storage.object-editor", "storage.object-viewer",
      "storage.object-lister", "storage.bucket-policy-editor",
      "auditlogs.audit-event-viewer", "auditlogs.audit-event-exporter",
      "mysterybox.payload-viewer", "applicationtunnel.agent",
    ], p.role)]]))
    error_message = "permits.<label>.role must be a documented role other than admin and dsr.admin (iam/authorization/roles#list-of-roles)."
  }
  validation {
    condition = alltrue(flatten([for name, g in var.groups : [
      for k, p in g.permits : p.resource_id == null || !startswith(coalesce(p.resource_id, "x"), "tenant-")
    ]]))
    error_message = "a team permit never targets the tenant: leave resource_id null for the project, or name a resource in it."
  }
}

variable "labels" {
  description = "Labels on every object this module creates."
  type        = map(string)
  default     = {}
}
