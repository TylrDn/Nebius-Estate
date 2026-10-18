# Foundation root (ADR-0009): the tenant-level objects every stage needs, applied once by an
# administrator — never by the stage CI identities it creates.
#   per stage: the project (optional: existing projects are the norm where tenant IAM is
#   restricted), the versioned state bucket, the bucket-scoped state identity (plus, with ci = true,
#   a read-only one for the plan job), and (ci = true) two
#   CI service accounts on that project only: editor for apply, viewer for plan. Their authorized
#   keys are registered with the CLI, not here (docs/credentials.md). Optionally the apply account
#   may read the payloads of listed SecretStash secrets (ci_secret_ids).
#   Off by default: GitHub OIDC federated credentials for those CI accounts and project-scoped team
#   groups (ci_federation, team_groups; R13, runbooks/identity.md).
# Its own state lives in a bucket bootstrapped by hand (scripts/bootstrap-backend.sh foundation
# foundation), because nothing can create the first bucket for you.

locals {
  stages    = yamldecode(file("${path.module}/../../../platform/stages.yaml")).stages
  requested = { for name, s in var.stages : name => s if contains(keys(local.stages), name) }
  # Project per stage: created here, or an existing id passed in. A stage with neither is
  # left out of the modules so terraform_data.stage_check can report it instead of a null id.
  provisioned = { for name, s in local.requested : name => s if s.project_id != null || var.create_projects }
  project_ids = {
    for name, s in local.provisioned : name => s.project_id != null ? s.project_id : nebius_iam_v2_project.stage[name].id
  }
  labels = merge(var.labels, { "nip-owner" = "platform", "nip-layer" = "foundation" })
}

resource "terraform_data" "stage_check" {
  lifecycle {
    precondition {
      condition     = length(setsubtract(keys(var.stages), keys(local.stages))) == 0
      error_message = "stages must be a subset of platform/stages.yaml: ${join(", ", keys(local.stages))}."
    }
    precondition {
      condition     = alltrue([for name, s in var.stages : s.project_id != null || var.create_projects])
      error_message = "either pass project_id for every stage or set create_projects = true (needs tenant-level IAM)."
    }
  }
}

resource "nebius_iam_v2_project" "stage" {
  for_each = { for name, s in local.requested : name => s if s.project_id == null && var.create_projects }

  parent_id = var.tenant_id
  name      = "${var.name_prefix}-${each.key}"
  region    = each.value.region
  labels    = merge(local.labels, { "nip-stage" = each.key })
}

module "state_bucket" {
  for_each = local.provisioned
  source   = "../../modules/foundation/state-bucket"

  project_id = local.project_ids[each.key]
  name       = "tfstate-${var.name_prefix}-${each.key}-${substr(md5("${var.tenant_id}-${local.project_ids[each.key]}"), 0, 12)}"
  labels     = merge(local.labels, { "nip-stage" = each.key })
}

module "state_identity" {
  for_each = local.provisioned
  source   = "../../modules/foundation/state-identity"

  project_id = local.project_ids[each.key]
  name       = "${var.name_prefix}-tfstate-${each.key}"
  bucket_id  = module.state_bucket[each.key].id
  labels     = merge(local.labels, { "nip-stage" = each.key })
}

# The plan job's state access (environment "<stage>-plan"): read-only on the bucket, so a plan from
# any branch can read state but never rewrite it. It cannot take the state lock either, so the plan
# job runs with -lock=false; the apply job re-plans with the editor key, under the lock.
module "state_reader_identity" {
  for_each = { for name, s in local.provisioned : name => s if s.ci }
  source   = "../../modules/foundation/state-identity"

  project_id = local.project_ids[each.key]
  name       = "${var.name_prefix}-tfstate-ro-${each.key}"
  bucket_id  = module.state_bucket[each.key].id
  role       = "storage.object-viewer"
  labels     = merge(local.labels, { "nip-stage" = each.key })
}

module "ci_identity" {
  for_each = { for name, s in local.provisioned : name => s if s.ci || s.ci_public_key_pem != null }
  source   = "../../modules/foundation/ci-service-account"

  project_id     = local.project_ids[each.key]
  name           = "${var.name_prefix}-ci-${each.key}"
  public_key_pem = each.value.ci_public_key_pem
  key_expires_at = each.value.ci_key_expires_at
  labels         = merge(local.labels, { "nip-stage" = each.key })
}

# The plan job's identity (environment "<stage>-plan", no reviewers): viewer only, so a plan from
# any branch can read the stage but never change it.
module "ci_plan_identity" {
  for_each = { for name, s in local.provisioned : name => s if s.ci || s.ci_plan_public_key_pem != null }
  source   = "../../modules/foundation/ci-service-account"

  project_id     = local.project_ids[each.key]
  name           = "${var.name_prefix}-ci-plan-${each.key}"
  role           = "viewer"
  public_key_pem = each.value.ci_plan_public_key_pem
  key_expires_at = each.value.ci_plan_key_expires_at
  labels         = merge(local.labels, { "nip-stage" = each.key })
}

# SecretStash payloads the stage's apply identity reads before `terraform apply` (the Grafana
# admin password, R8 transfer keys; docs/credentials.md#secretstash). `editor` can create secrets
# but not read payloads: that is `mysterybox.payload-viewer`, a sub-role of `admin`
# (iam/authorization/roles#secretstash). It is granted per secret, through a group of its own, so
# the identity reads only the secrets listed. The plan identity gets nothing: plans never need
# the values (they go only into write-only arguments).
locals {
  ci_secret_readers = { for name, s in local.provisioned : name => s if s.ci && length(s.ci_secret_ids) > 0 }
  ci_secret_grants = merge([
    for name, s in local.ci_secret_readers : { for id in distinct(s.ci_secret_ids) : "${name}/${id}" => { stage = name, secret_id = id } }
  ]...)
}

resource "nebius_iam_v1_group" "ci_secret_readers" {
  for_each = local.ci_secret_readers

  parent_id = local.project_ids[each.key]
  name      = "${var.name_prefix}-ci-${each.key}-secrets"
  labels    = merge(local.labels, { "nip-stage" = each.key })
}

resource "nebius_iam_v1_group_membership" "ci_secret_readers" {
  for_each = local.ci_secret_readers

  parent_id = nebius_iam_v1_group.ci_secret_readers[each.key].id
  member_id = module.ci_identity[each.key].service_account_id
}

resource "nebius_iam_v1_access_permit" "ci_secret_payload" {
  for_each = local.ci_secret_grants

  parent_id   = nebius_iam_v1_group.ci_secret_readers[each.value.stage].id
  resource_id = each.value.secret_id
  role        = "mysterybox.payload-viewer"
}

# R13: GitHub Actions jobs act as the CI accounts above through federated credentials, so the
# environments need no private key (modules/foundation/ci-federation, runbooks/identity.md). Off
# unless ci_federation or team_groups is set; keys keep working side by side until retired.
module "ci_federation" {
  count  = var.ci_federation == null && length(var.team_groups) == 0 ? 0 : 1
  source = "../../modules/foundation/ci-federation"

  repository          = try(var.ci_federation.repository, null) # null is allowed for team groups alone
  repository_id       = try(var.ci_federation.repository_id, null)
  repository_owner_id = try(var.ci_federation.repository_owner_id, null)
  subject_claims      = try(var.ci_federation.subject_claims, "ids")
  issuer_url          = try(var.ci_federation.issuer_url, "https://token.actions.githubusercontent.com")
  name_prefix         = var.name_prefix
  stages = var.ci_federation == null ? {} : {
    for name, s in local.provisioned : name => {
      project_id               = local.project_ids[name]
      apply_service_account_id = module.ci_identity[name].service_account_id
      plan_service_account_id  = module.ci_plan_identity[name].service_account_id
      apply_subject            = try(var.ci_federation.subjects[name].apply, null)
      plan_subject             = try(var.ci_federation.subjects[name].plan, null)
    } if s.ci
  }
  groups = var.team_groups
  labels = local.labels
}
