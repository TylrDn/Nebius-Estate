# Plan-mode tests for the ML platform services (mocked provider, no spend).
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

variables {
  stage     = "sandbox"
  parent_id = "project-e00mock"
  region    = "eu-north1"
  subnet_id = "vpcsubnet-e00mock0000000000"
  labels = {
    "nip-env"         = "ml-services"
    "nip-owner"       = "ci"
    "nip-run"         = "mock"
    "nip-ttl-expires" = timeadd(timestamp(), "24h") # inside the 7-day sandbox window
  }
}

# ---- defaults: registry and the node pull identity only ----

run "defaults_build_registry_and_node_identity_only" {
  command = plan

  assert {
    condition     = length(nebius_registry_v1_registry.this) == 1 && nebius_registry_v1_registry.this[0].name == "nip-sandbox"
    error_message = "one registry named <name>-<stage>"
  }
  assert {
    condition     = nebius_iam_v1_service_account.node[0].name == "nip-sandbox-node-sa" && nebius_iam_v1_group.image_pullers[0].name == "nip-sandbox-image-pullers"
    error_message = "node service account and its group follow the naming standard"
  }
  assert {
    condition     = nebius_iam_v1_access_permit.image_pull[0].role == "viewer"
    error_message = "pulling needs viewer (kubernetes/workloads/images-container-registry)"
  }
  assert {
    condition     = length(nebius_msp_mlflow_v1alpha1_cluster.this) == 0 && length(nebius_msp_postgresql_v1alpha1_cluster.this) == 0 && length(module.network) == 0
    error_message = "MLflow and PostgreSQL are opt-in; no network lookup without them"
  }
  assert {
    condition     = nebius_registry_v1_registry.this[0].labels["nip-stage"] == "sandbox" && nebius_registry_v1_registry.this[0].labels["nip-region"] == "eu-north1" && nebius_registry_v1_registry.this[0].labels["nip-stack"] == "ml-services" && nebius_iam_v1_service_account.node[0].labels["nip-run"] == "mock"
    error_message = "labels carry nip-stage, nip-region, nip-stack and the caller's nip-run"
  }
  assert {
    condition     = length(terraform_data.deletion_guard) == 0
    error_message = "sandbox has no deletion guard"
  }
}

run "node_pull_permit_is_scoped_to_the_registry" {
  command = plan

  # Plan with the mocked ids known (no apply needed; an apply run with the ephemeral password
  # variables unset also needs Terraform >= 1.16, see the last run).
  override_resource {
    target          = nebius_registry_v1_registry.this[0]
    values          = { id = "registry-e00mockregistry" }
    override_during = plan
  }
  override_resource {
    target          = nebius_iam_v1_service_account.node[0]
    values          = { id = "serviceaccount-e00nodesa" }
    override_during = plan
  }
  override_resource {
    target          = nebius_iam_v1_group.image_pullers[0]
    values          = { id = "group-e00mockpullers" }
    override_during = plan
  }

  assert {
    condition     = nebius_iam_v1_access_permit.image_pull[0].resource_id == "registry-e00mockregistry"
    error_message = "least privilege: viewer on this registry only"
  }
  assert {
    condition     = nebius_iam_v1_group_membership.node[0].member_id == "serviceaccount-e00nodesa" && nebius_iam_v1_group_membership.node[0].parent_id == "group-e00mockpullers"
    error_message = "the node service account is a member of the image-pullers group"
  }
  assert {
    condition     = output.node_service_account_id == "serviceaccount-e00nodesa"
    error_message = "node_service_account_id feeds R1/R3"
  }
  assert {
    condition     = output.registry_url == "cr.eu-north1.nebius.cloud/e00mockregistry"
    error_message = "registry URL is cr.<region>.nebius.cloud/<id without registry->"
  }
}

run "node_pull_permit_can_cover_the_project" {
  command = plan

  # Plan with the mocked ids known (no apply needed; an apply run with the ephemeral password
  # variables unset also needs Terraform >= 1.16, see the last run).
  override_resource {
    target          = nebius_registry_v1_registry.this[0]
    values          = { id = "registry-e00mockregistry" }
    override_during = plan
  }
  override_resource {
    target          = nebius_iam_v1_service_account.node[0]
    values          = { id = "serviceaccount-e00nodesa" }
    override_during = plan
  }
  override_resource {
    target          = nebius_iam_v1_group.image_pullers[0]
    values          = { id = "group-e00mockpullers" }
    override_during = plan
  }

  variables {
    node_pull_scope = "project"
  }

  assert {
    condition     = nebius_iam_v1_access_permit.image_pull[0].resource_id == "project-e00mock"
    error_message = "project scope grants viewer on the project"
  }
}

run "registry_scope_without_a_registry_is_refused" {
  command = plan

  variables {
    enable_registry = false
  }

  expect_failures = [terraform_data.stage_policy]
}

run "existing_node_identity_and_no_registry" {
  command = plan

  variables {
    enable_registry             = false
    create_node_service_account = false
  }

  assert {
    condition     = length(nebius_registry_v1_registry.this) == 0 && length(nebius_iam_v1_service_account.node) == 0 && length(nebius_iam_v1_access_permit.image_pull) == 0
    error_message = "nothing is created when both are off"
  }
  assert {
    condition     = output.node_service_account_id == null && output.registry_url == null && output.registry_id == null
    error_message = "outputs are null when the resources are off"
  }
}

run "rejects_an_unknown_pull_scope" {
  command = plan

  variables {
    node_pull_scope = "tenant"
  }

  expect_failures = [var.node_pull_scope]
}

run "sandbox_requires_a_ttl_label" {
  command = plan

  variables {
    labels = { "nip-env" = "ml-services", "nip-owner" = "ci", "nip-run" = "mock" }
  }

  expect_failures = [var.labels]
}

# ---- Managed MLflow ----

run "mlflow_with_a_typed_password" {
  command = plan

  variables {
    enable_mlflow         = true
    mlflow_admin_password = "Mock-Passw0rd!"
  }

  assert {
    condition     = nebius_msp_mlflow_v1alpha1_cluster.this[0].size == "medium" && nebius_msp_mlflow_v1alpha1_cluster.this[0].name == "nip-sandbox-mlflow"
    error_message = "medium is the only size"
  }
  assert {
    condition     = nebius_msp_mlflow_v1alpha1_cluster.this[0].network_id == "vpcnetwork-e00mock000000000"
    error_message = "the cluster joins the subnet's network"
  }
  assert {
    condition     = nebius_msp_mlflow_v1alpha1_cluster.this[0].service_account_id == "serviceaccount-e00mlflowsa"
    error_message = "mlflow-sa is looked up by name when no id is given"
  }
  assert {
    condition     = nebius_msp_mlflow_v1alpha1_cluster.this[0].public_access == true
    error_message = "sandbox may expose the tracking endpoint publicly (TTL-bound)"
  }
  assert {
    condition     = nebius_msp_mlflow_v1alpha1_cluster.this[0].admin_password == null && nebius_msp_mlflow_v1alpha1_cluster.this[0].sensitive.version == "1"
    error_message = "the password travels only in the write-only block; the version tag is the plain secrets_version"
  }
  # Live apply 2026-10-11: the MLflow API keeps no labels (the created cluster had none), so any label
  # set here fails the apply with "inconsistent result after apply: .labels_all ... has vanished".
  assert {
    condition     = length(coalesce(nebius_msp_mlflow_v1alpha1_cluster.this[0].labels, {})) == 0
    error_message = "the MLflow cluster is sent no labels: the API drops them"
  }
}

run "mlflow_with_an_explicit_service_account_skips_the_lookup" {
  command = plan

  variables {
    enable_mlflow         = true
    mlflow_admin_password = "Mock-Passw0rd!"
    mlflow                = { service_account_id = "serviceaccount-e00custom", public_access = false, storage_bucket_name = "nip-sandbox-mlflow-artifacts" }
  }

  assert {
    condition     = length(data.nebius_iam_v1_service_account.mlflow) == 0 && nebius_msp_mlflow_v1alpha1_cluster.this[0].service_account_id == "serviceaccount-e00custom"
    error_message = "an explicit service account is used as is"
  }
  assert {
    condition     = nebius_msp_mlflow_v1alpha1_cluster.this[0].public_access == false && nebius_msp_mlflow_v1alpha1_cluster.this[0].storage_bucket_name == "nip-sandbox-mlflow-artifacts"
    error_message = "public_access and the artifact bucket pass through"
  }
}

run "mlflow_without_a_password_is_refused" {
  command = plan

  variables {
    enable_mlflow = true
  }

  expect_failures = [terraform_data.stage_policy]
}

run "mlflow_rejects_a_weak_password" {
  command = plan

  variables {
    enable_mlflow         = true
    mlflow_admin_password = "alllowercase"
  }

  expect_failures = [var.mlflow_admin_password]
}

run "mlflow_rejects_the_retired_small_size" {
  command = plan

  variables {
    mlflow = { size = "small" }
  }

  expect_failures = [var.mlflow]
}

run "mlflow_is_refused_where_the_region_lacks_it" {
  command = plan

  variables {
    region                = "eu-west1" # offers PostgreSQL but not MLflow
    enable_mlflow         = true
    mlflow_admin_password = "Mock-Passw0rd!"
  }

  expect_failures = [nebius_msp_mlflow_v1alpha1_cluster.this]
}

run "password_without_its_service_is_refused" {
  command = plan

  variables {
    postgresql_password = "Mock-Passw0rd!"
  }

  expect_failures = [terraform_data.stage_policy]
}

# ---- Managed PostgreSQL ----

run "postgresql_defaults" {
  command = plan

  variables {
    enable_postgresql   = true
    postgresql_password = "Mock-Passw0rd!"
  }

  assert {
    condition     = nebius_msp_postgresql_v1alpha1_cluster.this[0].config.version == "16" && nebius_msp_postgresql_v1alpha1_cluster.this[0].config.template.disk.type == "network-ssd"
    error_message = "PostgreSQL 16 on network-ssd, the only documented choices"
  }
  assert {
    condition     = nebius_msp_postgresql_v1alpha1_cluster.this[0].config.template.resources.platform == "cpu-e2" && nebius_msp_postgresql_v1alpha1_cluster.this[0].config.template.resources.preset == "2vcpu-8gb"
    error_message = "eu-north1 uses the documented cpu-e2 platform with the quickstart preset"
  }
  assert {
    condition     = nebius_msp_postgresql_v1alpha1_cluster.this[0].backup.retention_policy == "7d" && nebius_msp_postgresql_v1alpha1_cluster.this[0].backup.backup_window_start == "00:02:00"
    error_message = "daily backups at the documented default window, kept the minimum 7 days"
  }
  assert {
    condition     = nebius_msp_postgresql_v1alpha1_cluster.this[0].config.pooler_config.pooling_mode == "SESSION" && nebius_msp_postgresql_v1alpha1_cluster.this[0].config.postgresql_config_16 == null
    error_message = "session pooling and no parameter overrides by default"
  }
  assert {
    condition     = nebius_msp_postgresql_v1alpha1_cluster.this[0].bootstrap.user_password == null && nebius_msp_postgresql_v1alpha1_cluster.this[0].bootstrap.user_name == "ml_owner"
    error_message = "the bootstrap password travels only in the write-only block"
  }
  assert {
    condition     = nebius_msp_postgresql_v1alpha1_cluster.this[0].network_id == "vpcnetwork-e00mock000000000" && nebius_msp_postgresql_v1alpha1_cluster.this[0].config.public_access == true
    error_message = "joins the subnet's network; public in sandbox"
  }
  # Live apply 2026-10-11: the PostgreSQL API refuses a description outside ^[{},":a-zA-Z0-9\s_-]*$
  # ("validate cluster metadata: clusterDescription: value is invalid").
  assert {
    condition     = can(regex("^[{},\":a-zA-Z0-9\\s_-]*$", nebius_msp_postgresql_v1alpha1_cluster.this[0].description))
    error_message = "the description uses only the characters the PostgreSQL API accepts"
  }
}

run "postgresql_outside_eu_north1_runs_on_cpu_d3" {
  command = plan

  variables {
    region              = "eu-west2"
    enable_postgresql   = true
    postgresql_password = "Mock-Passw0rd!"
    postgresql          = { hosts = 2, disk_size_gibibytes = 256, backup_retention_days = 30, max_connections = 400 }
  }

  assert {
    condition     = nebius_msp_postgresql_v1alpha1_cluster.this[0].config.template.resources.platform == "cpu-d3"
    error_message = "cpu-e2 exists only in eu-north1"
  }
  assert {
    condition     = nebius_msp_postgresql_v1alpha1_cluster.this[0].config.template.hosts.count == 2 && nebius_msp_postgresql_v1alpha1_cluster.this[0].backup.retention_policy == "30d" && nebius_msp_postgresql_v1alpha1_cluster.this[0].config.postgresql_config_16.max_connections == 400
    error_message = "hosts, retention and max_connections pass through"
  }
}

run "postgresql_refuses_cpu_e2_outside_eu_north1" {
  command = plan

  variables {
    region              = "eu-west2"
    enable_postgresql   = true
    postgresql_password = "Mock-Passw0rd!"
    postgresql          = { platform = "cpu-e2" }
  }

  expect_failures = [nebius_msp_postgresql_v1alpha1_cluster.this]
}

run "postgresql_is_refused_where_the_region_lacks_it" {
  command = plan

  variables {
    region              = "uk-south2"
    enable_postgresql   = true
    postgresql_password = "Mock-Passw0rd!"
  }

  expect_failures = [nebius_msp_postgresql_v1alpha1_cluster.this]
}

run "postgresql_without_a_password_is_refused" {
  command = plan

  variables {
    enable_postgresql = true
  }

  expect_failures = [terraform_data.stage_policy]
}

run "postgresql_rejects_a_reserved_user" {
  command = plan

  variables {
    postgresql = { user_name = "postgres" }
  }

  expect_failures = [var.postgresql]
}

run "postgresql_rejects_retention_beyond_30_days" {
  command = plan

  variables {
    postgresql = { backup_retention_days = 31 }
  }

  expect_failures = [var.postgresql]
}

run "postgresql_rejects_a_weak_password" {
  command = plan

  variables {
    enable_postgresql   = true
    postgresql_password = "NoSpecials1"
  }

  expect_failures = [var.postgresql_password]
}

# ---- passwords from SecretStash (secret_id) ----

run "secretstash_plans_without_the_passwords" {
  command = plan

  variables {
    enable_mlflow     = true
    enable_postgresql = true
    secret_id         = "mbsec-e00mock"
    secret_version_id = "mbsecver-e00mock"
  }

  assert {
    condition     = nebius_msp_mlflow_v1alpha1_cluster.this[0].sensitive.version == "1/mbsec-e00mock/mbsecver-e00mock" && nebius_msp_postgresql_v1alpha1_cluster.this[0].sensitive.version == "1/mbsec-e00mock/mbsecver-e00mock"
    error_message = "the secret reference (never a value) versions the write-only passwords"
  }
  assert {
    condition     = output.secret.secret_id == "mbsec-e00mock" && output.secret.version_id == "mbsecver-e00mock"
    error_message = "outputs name the secret, never the value"
  }
}


run "secretstash_applies_with_the_passwords" {
  command = apply

  variables {
    enable_mlflow         = true
    enable_postgresql     = true
    secret_id             = "mbsec-e00mock"
    mlflow_admin_password = "Mock-Passw0rd!"
    postgresql_password   = "Mock-Passw0rd!"
  }

  assert {
    condition     = nebius_msp_postgresql_v1alpha1_cluster.this[0].sensitive.version == "1/mbsec-e00mock" && output.postgresql.id == "postgresqlcluster-e00mock" && output.mlflow.id == "mlflowcluster-e00mock"
    error_message = "unpinned: the version names the secret only"
  }
}

run "secret_id_without_a_service_is_refused" {
  command = plan

  variables {
    secret_id = "mbsec-e00mock"
  }

  expect_failures = [terraform_data.stage_policy]
}

run "rejects_a_malformed_secret_id" {
  command = plan

  variables {
    secret_id = "secret-e00mock"
  }

  expect_failures = [var.secret_id]
}

# ---- stage policy: public endpoints and deletion ----

run "staging_keeps_services_private" {
  command = plan

  variables {
    stage             = "staging"
    labels            = { "nip-env" = "ml-services", "nip-owner" = "ci", "nip-run" = "staging" }
    enable_mlflow     = true
    enable_postgresql = true
    secret_id         = "mbsec-e00mock"
  }

  assert {
    condition     = nebius_msp_mlflow_v1alpha1_cluster.this[0].public_access == false && nebius_msp_postgresql_v1alpha1_cluster.this[0].config.public_access == false
    error_message = "no allowlist exists for these endpoints, so staging defaults to private"
  }
  assert {
    condition     = length(terraform_data.deletion_guard) == 0
    error_message = "staging does not require deletion protection"
  }
}

run "staging_refuses_a_public_mlflow" {
  command = plan

  variables {
    stage         = "staging"
    labels        = { "nip-env" = "ml-services", "nip-owner" = "ci", "nip-run" = "staging" }
    enable_mlflow = true
    secret_id     = "mbsec-e00mock"
    mlflow        = { public_access = true }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "prod_guards_both_clusters" {
  command = plan

  variables {
    stage             = "prod"
    labels            = { "nip-env" = "ml-services", "nip-owner" = "ci", "nip-run" = "prod" }
    enable_mlflow     = true
    enable_postgresql = true
    secret_id         = "mbsec-e00mock"
    postgresql        = { hosts = 2, preset = "4vcpu-16gb", disk_size_gibibytes = 256, backup_retention_days = 14 }
  }

  assert {
    condition     = output.deletion_guarded == tolist(["mlflow", "postgresql"])
    error_message = "prod puts a prevent_destroy guard on both clusters"
  }
  assert {
    condition     = nebius_msp_postgresql_v1alpha1_cluster.this[0].config.public_access == false && nebius_msp_mlflow_v1alpha1_cluster.this[0].public_access == false
    error_message = "prod endpoints are private"
  }
}

run "prod_refuses_to_turn_deletion_protection_off" {
  command = plan

  variables {
    stage             = "prod"
    labels            = { "nip-env" = "ml-services", "nip-owner" = "ci", "nip-run" = "prod" }
    enable_postgresql = true
    secret_id         = "mbsec-e00mock"
    forbid_deletion   = false
  }

  expect_failures = [terraform_data.stage_policy]
}

run "prod_refuses_a_public_postgresql" {
  command = plan

  variables {
    stage             = "prod"
    labels            = { "nip-env" = "ml-services", "nip-owner" = "ci", "nip-run" = "prod" }
    enable_postgresql = true
    secret_id         = "mbsec-e00mock"
    postgresql        = { public_access = true }
  }

  expect_failures = [terraform_data.stage_policy]
}

# Last on purpose: it needs command = apply with the passwords unset (terraform.applying). Test
# harnesses before Terraform 1.16.0 refuse that ("ephemeral input variable ... must remain unset"),
# which is why the toolbox pins 1.16.5; a failed apply run skips the runs after it, so nothing
# follows this one. Checked 2026-10-11: passes on 1.16.0, 1.16.3 and 1.16.5; fails on 1.11.4, 1.12.2,
# 1.13.5, 1.14.9 and 1.15.9 (the same harness limit as stacks/data and modules/o11y).
run "secretstash_apply_without_the_passwords_is_refused" {
  command = apply

  variables {
    enable_postgresql = true
    secret_id         = "mbsec-e00mock"
  }

  expect_failures = [terraform_data.stage_policy]
}
