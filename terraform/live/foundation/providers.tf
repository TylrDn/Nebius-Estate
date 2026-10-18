# An administrator's token: the foundation creates identities, so it is never applied by one
# of the CI identities it creates.
provider "nebius" {
  token = var.iam_token
}
