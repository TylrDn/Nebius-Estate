# CI federation (R13): GitHub Actions jobs act as the stage CI service accounts through federated
# credentials, so no authorized key (NIP_SA_PRIVATE_KEY) has to exist for CI at all. Plus a
# reusable pattern for least-privilege, project-scoped team groups.
#
# How a federated credential binds (terraform-provider/reference/resources/iam_v1_federated_credentials):
#   subject_id            the service account the external identity impersonates
#   oidc_provider         issuer_url (+ optional jwk_set_json); the issuer must publish OIDC discovery
#   federated_subject_id  compared with the token's "sub" claim
# Those are the only conditions the schema has: there is no audience and no other claim to match.
# Repository, ref and environment scoping therefore all ride on "sub", whose shape GitHub sets: for a
# job that names an environment it is repo:<owner>/<repo>:environment:<name>. The environment's own
# rules (deployment branches/tags, required reviewers) then decide which ref may reach it.
#
# The credential's parent is the stage project, where the service account lives; the docs do not
# say which parent the API expects (README "Limits and unknowns").

locals {
  # Default subjects carry the immutable owner and repository ids (subject_claims = "ids"), in the
  # order of the sub template the repository sets; "name" keeps GitHub's default, name-only shape.
  # "immutable" is GitHub's immutable subject (owner and repository ids inline, no template needed).
  repo_parts = split("/", coalesce(var.repository, "-/-"))
  subject_prefix = {
    ids       = "repo:${coalesce(var.repository, "-")}:repository_owner_id:${coalesce(var.repository_owner_id, "-")}:repository_id:${coalesce(var.repository_id, "-")}"
    immutable = "repo:${local.repo_parts[0]}@${coalesce(var.repository_owner_id, "-")}/${local.repo_parts[1]}@${coalesce(var.repository_id, "-")}"
    name      = "repo:${coalesce(var.repository, "-")}"
  }[var.subject_claims]

  # Keys are "<stage>/<job>": stage names and jobs are known at plan time even when the ids are not.
  identities = merge([
    for stage, s in var.stages : {
      for job in s.jobs : "${stage}/${job}" => {
        stage              = stage
        job                = job
        project_id         = s.project_id
        service_account_id = job == "apply" ? s.apply_service_account_id : s.plan_service_account_id
        environment        = job == "apply" ? stage : "${stage}-plan"
        subject = coalesce(
          job == "apply" ? s.apply_subject : s.plan_subject,
          "${local.subject_prefix}:environment:${job == "apply" ? stage : "${stage}-plan"}",
        )
      }
    }
  ]...)

  # Keys use the caller's labels, never the IDs, which may be unknown until apply.
  group_permits = merge([
    for name, g in var.groups : {
      for label, p in g.permits : "${name}/${label}" => {
        group       = name
        role        = p.role
        resource_id = coalesce(p.resource_id, g.project_id) # null = the group's project
      }
    }
  ]...)
  group_members = merge([
    for name, g in var.groups : { for label, id in g.members : "${name}/${label}" => { group = name, member_id = id } }
  ]...)
}

resource "terraform_data" "subject_check" {
  lifecycle {
    precondition {
      condition     = length(distinct([for k, i in local.identities : i.subject])) == length(local.identities)
      error_message = "two CI identities share a subject: one GitHub job could then act as both. Give each its own environment."
    }
  }
}

resource "nebius_iam_v1_federated_credentials" "ci" {
  for_each = local.identities

  parent_id            = each.value.project_id
  name                 = "${var.name_prefix}-${each.value.stage}-gha-${each.value.job}" # <prefix>-<stage>-<function> (docs/naming.md)
  subject_id           = each.value.service_account_id
  federated_subject_id = each.value.subject
  oidc_provider = {
    issuer_url   = var.issuer_url
    jwk_set_json = var.jwk_set_json
  }
  labels = merge(var.labels, { "nip-stage" = each.value.stage, "nip-ci-job" = each.value.job })
}

# Team groups: created in the project, so the API refuses permits outside it
# (iam/authorization/groups/manage#setting-up-custom-groups).
resource "nebius_iam_v1_group" "team" {
  for_each = var.groups

  parent_id = each.value.project_id
  name      = "${var.name_prefix}-team-${each.key}"
  labels    = var.labels
}

resource "nebius_iam_v1_access_permit" "team" {
  for_each = local.group_permits

  parent_id   = nebius_iam_v1_group.team[each.value.group].id
  resource_id = each.value.resource_id
  role        = each.value.role
}

resource "nebius_iam_v1_group_membership" "team" {
  for_each = local.group_members

  parent_id = nebius_iam_v1_group.team[each.value.group].id
  member_id = each.value.member_id
}
