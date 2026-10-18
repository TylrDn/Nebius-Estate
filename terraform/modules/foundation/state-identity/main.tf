# A state identity (ADR-0005): a custom group created IN the stage's project, a service account
# as its member, and one access permit on the state bucket only. No tenant-level IAM. The
# foundation makes two per CI stage: storage.object-editor for local runs and the apply job, and
# storage.object-viewer for the plan job (which therefore plans with -lock=false). Local S3 access
# keys (1 day) are minted at run time by scripts/bootstrap-backend.sh, the CI ones by an admin with
# the CLI (runbooks/credential-rotation.md); never by Terraform (they would land in state).

resource "nebius_iam_v1_group" "this" {
  parent_id = var.project_id
  name      = var.name
  labels    = var.labels
}

resource "nebius_iam_v1_service_account" "this" {
  parent_id   = var.project_id
  name        = var.name
  description = "Terraform state access for ${var.name}: ${var.role} on the state bucket only; keys expire"
  labels      = var.labels
}

resource "nebius_iam_v1_group_membership" "this" {
  parent_id = nebius_iam_v1_group.this.id
  member_id = nebius_iam_v1_service_account.this.id
}

resource "nebius_iam_v1_access_permit" "state" {
  parent_id   = nebius_iam_v1_group.this.id
  resource_id = var.bucket_id
  role        = var.role
}
