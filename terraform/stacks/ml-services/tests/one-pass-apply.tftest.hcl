# One clean pass (mocked provider, no spend). The first live apply (2026-10-11,
# docs/evidence/2026-10-11-sandbox-ml-services-live-recipe.md) needed manual steps: the MLflow
# cluster came back without the labels it was sent ("inconsistent result after apply", so a tainted
# cluster, `terraform untaint`, then `state rm` + `import`), PostgreSQL refused a description with
# parentheses, and the re-plan after the import tried an in-place MLflow update, which the API does
# not implement. These runs apply everything the stack can build in one pass and re-plan it, and
# fail if any argument that caused one of those steps comes back. A mocked provider cannot prove
# the API's answers; the live check is the next sandbox run (make plan apply, then a second
# make plan must print "No changes").
# Run: terraform -chdir=terraform/stacks/ml-services test

mock_provider "nebius" {
  mock_data "nebius_vpc_v1_subnet" {
    defaults = {
      id         = "vpcsubnet-e00mock0000000000"
      network_id = "vpcnetwork-e00mock000000000"
    }
  }
  mock_data "nebius_iam_v1_service_account" {
    defaults = { id = "serviceaccount-e00mlflowsa" }
  }
  mock_resource "nebius_registry_v1_registry" {
    defaults = { id = "registry-e00mockregistry" }
  }
  mock_resource "nebius_iam_v1_service_account" {
    defaults = { id = "serviceaccount-e00nodesa" }
  }
  mock_resource "nebius_iam_v1_group" {
    defaults = { id = "group-e00mockpullers" }
  }
  mock_resource "nebius_msp_mlflow_v1alpha1_cluster" {
    defaults = { id = "mlflowcluster-e00mock" }
  }
  mock_resource "nebius_msp_postgresql_v1alpha1_cluster" {
    defaults = { id = "postgresqlcluster-e00mock" }
  }
}

# The sandbox run's inputs: every service on, passwords from a pinned SecretStash version and read
# into the ephemeral variables (runbooks/ml-services.md#passwords-secretstash-never-in-state).
variables {
  stage                       = "sandbox"
  parent_id                   = "project-e00mock"
  region                      = "eu-north1"
  subnet_id                   = "vpcsubnet-e00mock0000000000"
  enable_mlflow               = true
  enable_postgresql           = true
  create_node_service_account = true
  secret_id                   = "mbsec-e00mock"
  secret_version_id           = "mbsecver-e00mock"
  mlflow_admin_password       = "Mock-Passw0rd!"
  postgresql_password         = "Mock-Passw0rd!"
  labels = {
    "nip-env"         = "ml-services"
    "nip-owner"       = "ci"
    "nip-run"         = "mock"
    "nip-ttl-expires" = timeadd(timestamp(), "24h") # inside the 7-day sandbox window
  }
}

run "fresh_apply_in_one_pass" {
  command = apply

  # Live 2026-10-11: labels on the MLflow cluster were dropped by the API and failed the apply.
  assert {
    condition     = length(coalesce(nebius_msp_mlflow_v1alpha1_cluster.this[0].labels, {})) == 0
    error_message = "the MLflow cluster must be sent no labels: the API drops them and the apply fails"
  }
  # Live 2026-10-11: "clusterDescription: value is invalid, must match regexp ^[\{\}\,\":a-zA-Z0-9\s_-]*$".
  assert {
    condition     = can(regex("^[{},\":a-zA-Z0-9\\s_-]*$", nebius_msp_postgresql_v1alpha1_cluster.this[0].description))
    error_message = "the PostgreSQL description must use only the characters the API accepts"
  }
  assert {
    condition     = output.mlflow.id == "mlflowcluster-e00mock" && output.postgresql.id == "postgresqlcluster-e00mock" && output.registry_id == "registry-e00mockregistry" && output.node_service_account_id == "serviceaccount-e00nodesa"
    error_message = "one apply builds the registry, the node identity, MLflow and PostgreSQL"
  }
  assert {
    condition     = nebius_msp_mlflow_v1alpha1_cluster.this[0].sensitive.version == "1/mbsec-e00mock/mbsecver-e00mock"
    error_message = "the MLflow password version is the pinned secret reference"
  }
  assert {
    condition     = length(terraform_data.deletion_guard) == 0
    error_message = "sandbox has no deletion guard, so the same root also destroys in one pass"
  }
}

# The re-plan with the same inputs, against the state the apply left: every argument the MLflow
# API cannot update in place stays what was applied (an in-place MLflow update fails with
# "Update is unimplemented"), and nothing depends on plan time.
run "replan_keeps_mlflow_unchanged" {
  command = plan

  assert {
    condition     = nebius_msp_mlflow_v1alpha1_cluster.this[0].sensitive.version == "1/mbsec-e00mock/mbsecver-e00mock"
    error_message = "the re-plan must not change sensitive.version: that re-sends the password, an MLflow update the API rejects"
  }
  assert {
    condition     = length(coalesce(nebius_msp_mlflow_v1alpha1_cluster.this[0].labels, {})) == 0 && nebius_msp_mlflow_v1alpha1_cluster.this[0].name == "nip-sandbox-mlflow" && nebius_msp_mlflow_v1alpha1_cluster.this[0].description == "MLflow tracking for sandbox (R12)"
    error_message = "MLflow name, description and (absent) labels are stable across plans"
  }
  assert {
    condition     = nebius_msp_mlflow_v1alpha1_cluster.this[0].network_id == "vpcnetwork-e00mock000000000" && nebius_msp_mlflow_v1alpha1_cluster.this[0].service_account_id == "serviceaccount-e00mlflowsa" && nebius_msp_mlflow_v1alpha1_cluster.this[0].public_access == true && nebius_msp_mlflow_v1alpha1_cluster.this[0].size == "medium"
    error_message = "MLflow network, service account, public access and size are stable across plans"
  }
  assert {
    condition     = nebius_msp_postgresql_v1alpha1_cluster.this[0].sensitive.version == "1/mbsec-e00mock/mbsecver-e00mock" && nebius_msp_postgresql_v1alpha1_cluster.this[0].description == "PostgreSQL for sandbox ML services - R12"
    error_message = "PostgreSQL keeps its password version and description across plans"
  }
}
