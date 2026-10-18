# A CI identity for one stage (ADR-0009, "Credentials"): a service account holding one role on the
# stage's PROJECT only (never the tenant). The foundation creates two per stage: `editor` for the
# apply job and `viewer` for the plan job, so a plan run (any branch, no reviewers) cannot change
# the stage.
#
# Authorized keys: the docs say the FIRST authorized key of a service account cannot be uploaded
# with Terraform, and that Terraform can upload one only when the provider itself authenticates
# with an existing authorized key (iam/service-accounts/authorized-keys#uploading-the-public-key).
# The foundation runs on an administrator's user token, so keys are registered with the CLI
# (docs/credentials.md, runbooks/credential-rotation.md) and public_key_pem stays null. Set it only
# when this root runs under a service-account authorized key. Either way the private key is made
# outside Terraform (`openssl genrsa`) and only the public half is ever passed here.

resource "nebius_iam_v1_group" "this" {
  parent_id = var.project_id
  name      = var.name
  labels    = var.labels
}

resource "nebius_iam_v1_service_account" "this" {
  parent_id   = var.project_id
  name        = var.name
  description = "CI identity ${var.name}: ${var.role} on the stage project only"
  labels      = var.labels
}

resource "nebius_iam_v1_group_membership" "this" {
  parent_id = nebius_iam_v1_group.this.id
  member_id = nebius_iam_v1_service_account.this.id
}

resource "nebius_iam_v1_access_permit" "project" {
  parent_id   = nebius_iam_v1_group.this.id
  resource_id = var.project_id
  role        = var.role
}

# Only with public_key_pem, and only when the provider authenticates with an authorized key (above).
resource "nebius_iam_v1_auth_public_key" "this" {
  count = var.public_key_pem == null ? 0 : 1

  parent_id   = var.project_id
  name        = "${var.name}-key"
  description = "Authorized key for the CI service account; rotate before expires_at (runbooks/credential-rotation.md)"
  data        = var.public_key_pem
  expires_at  = var.key_expires_at
  account = {
    service_account = { id = nebius_iam_v1_service_account.this.id }
  }
}
