# Mocked plan of the foundation root: no credentials, no tenant.
mock_provider "nebius" {
  mock_resource "nebius_storage_v1_bucket" {
    defaults = { id = "storagebucket-e00mock000000" }
  }
  mock_resource "nebius_iam_v1_group" {
    defaults = { id = "group-e00mock00000000000" }
  }
  mock_resource "nebius_iam_v1_service_account" {
    defaults = { id = "serviceaccount-e00mock0000" }
  }
  mock_resource "nebius_iam_v2_project" {
    defaults = { id = "project-e00created00000000" }
  }
}

# Every input is pinned: `terraform test` also loads a git-ignored terraform.tfvars, and an operator's
# real one (adopt_bootstrap ids, ci_federation) must not change what these tests see (2026-10-11).
variables {
  iam_token       = "mock-token"
  tenant_id       = "tenant-e00mock"
  name_prefix     = "nip"
  create_projects = false
  labels          = {}
  adopt_bootstrap = {}
  ci_federation   = null
  team_groups     = {}
  stages = {
    sandbox = { project_id = "project-e00sandbox", region = "eu-north1" }
    prod    = { project_id = "project-e00prod", region = "eu-north1", ci = true }
  }
}

run "existing_projects_get_bucket_identity_and_prod_ci" {
  command = plan

  assert {
    condition     = length(module.state_bucket) == 2 && length(module.state_identity) == 2 && length(module.ci_identity) == 1 && length(nebius_iam_v2_project.stage) == 0
    error_message = "one bucket and one state identity per stage, CI identities only where ci = true, no projects created"
  }
  assert {
    condition     = output.projects.sandbox == "project-e00sandbox"
    error_message = "existing project ids pass through"
  }
  assert {
    condition     = startswith(module.state_bucket["prod"].name, "tfstate-nip-prod-") && startswith(module.state_bucket["sandbox"].name, "tfstate-nip-sandbox-")
    error_message = "state buckets are named per stage"
  }
}

run "prod_gets_an_apply_and_a_plan_identity" {
  command = plan

  assert {
    condition     = length(module.ci_identity) == 1 && length(module.ci_plan_identity) == 1
    error_message = "two CI identities for a stage with both keys: apply and plan"
  }
  assert {
    condition     = module.ci_identity["prod"].role == "editor" && module.ci_plan_identity["prod"].role == "viewer"
    error_message = "apply holds editor, plan holds viewer, both on the stage project only"
  }
  assert {
    condition     = module.ci_identity["prod"].public_key_id == null && module.ci_plan_identity["prod"].public_key_id == null
    error_message = "by default no authorized key goes through Terraform: the first key is registered with the CLI (docs)"
  }
}

run "terraform_key_upload_stays_available_with_an_expiry" {
  command = plan

  # Overrides make the key ids known at plan time.
  override_resource {
    target          = module.ci_identity["prod"].nebius_iam_v1_auth_public_key.this[0]
    values          = { id = "publickey-e00mock0000000" }
    override_during = plan
  }
  override_resource {
    target          = module.ci_plan_identity["prod"].nebius_iam_v1_auth_public_key.this[0]
    values          = { id = "publickey-e00mock0000000" }
    override_during = plan
  }

  variables {
    stages = {
      prod = {
        project_id             = "project-e00prod"
        region                 = "eu-north1"
        ci_public_key_pem      = "-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----\n"
        ci_key_expires_at      = "2099-01-01T00:00:00Z"
        ci_plan_public_key_pem = "-----BEGIN PUBLIC KEY-----\nMOCKPLAN\n-----END PUBLIC KEY-----\n"
        ci_plan_key_expires_at = "2099-01-01T00:00:00Z"
      }
    }
  }

  assert {
    condition     = module.ci_identity["prod"].public_key_id == "publickey-e00mock0000000" && module.ci_plan_identity["prod"].public_key_id == "publickey-e00mock0000000"
    error_message = "a PEM passed in is still registered (for roots that authenticate with an authorized key)"
  }
}

run "no_ci_flag_and_no_key_means_no_ci_identity" {
  command = plan

  variables {
    stages = { sandbox = { project_id = "project-e00sandbox", region = "eu-north1" } }
  }

  assert {
    condition     = length(module.ci_identity) == 0 && length(module.ci_plan_identity) == 0
    error_message = "CI identities are opt-in per stage"
  }
}

run "plan_key_without_expiry_is_rejected" {
  command = plan

  variables {
    stages = {
      prod = { project_id = "project-e00prod", region = "eu-north1", ci_plan_public_key_pem = "-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----\n" }
    }
  }

  expect_failures = [var.stages]
}

run "rejects_unknown_stage" {
  command = plan

  variables {
    stages = { dev = { project_id = "project-e00dev", region = "eu-north1" } }
  }

  expect_failures = [terraform_data.stage_check]
}

run "missing_project_without_create_is_rejected" {
  command = plan

  variables {
    stages = { sandbox = { region = "eu-north1" } }
  }

  expect_failures = [terraform_data.stage_check]
}

run "create_projects_creates_one_per_stage" {
  command = plan

  variables {
    create_projects = true
    stages          = { staging = { region = "eu-north1" } }
  }

  # The created project's id is unknown at plan time, so assert on the resource set, not the id.
  assert {
    condition     = length(nebius_iam_v2_project.stage) == 1 && keys(module.state_bucket) == ["staging"] && keys(module.state_identity) == ["staging"]
    error_message = "with create_projects the stage project is created and the bucket/identity are planned for it"
  }
}

run "ci_key_without_expiry_is_rejected" {
  command = plan

  variables {
    stages = {
      prod = { project_id = "project-e00prod", region = "eu-north1", ci_public_key_pem = "-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----\n" }
    }
  }

  expect_failures = [var.stages]
}

run "adopts_what_bootstrap_created" {
  command = plan

  variables {
    adopt_bootstrap = {
      sandbox = {
        bucket_id          = "storagebucket-e00mockboot"
        service_account_id = "serviceaccount-e00mockboot"
        group_id           = "group-e00mockboot"
        membership_id      = "groupmembership-e00mockboot"
      }
    }
  }

  # Mock providers cannot import; overrides stand in for the existing objects.
  override_resource {
    target = module.state_bucket["sandbox"].nebius_storage_v1_bucket.this
    values = { id = "storagebucket-e00mockboot" }
  }
  override_resource {
    target = module.state_identity["sandbox"].nebius_iam_v1_service_account.this
    values = { id = "serviceaccount-e00mockboot" }
  }
  override_resource {
    target = module.state_identity["sandbox"].nebius_iam_v1_group.this
    values = { id = "group-e00mockboot" }
  }
  override_resource {
    target = module.state_identity["sandbox"].nebius_iam_v1_group_membership.this
    values = { id = "groupmembership-e00mockboot" }
  }

  assert {
    condition     = module.state_bucket["sandbox"].id == "storagebucket-e00mockboot" && length(module.state_bucket) == 2
    error_message = "the bootstrap bucket is adopted under the foundation's address; nothing else changes"
  }
}

run "adopt_rejects_unknown_stage" {
  command = plan

  variables {
    adopt_bootstrap = { dev = { bucket_id = "storagebucket-e00mock" } }
  }

  expect_failures = [var.adopt_bootstrap]
}

run "apply_identity_reads_only_the_listed_secrets" {
  command = plan

  override_resource {
    target          = module.ci_identity["prod"].nebius_iam_v1_service_account.this
    values          = { id = "serviceaccount-e00mockapply" }
    override_during = plan
  }

  variables {
    stages = {
      sandbox = { project_id = "project-e00sandbox", region = "eu-north1" }
      prod    = { project_id = "project-e00prod", region = "eu-north1", ci = true, ci_secret_ids = ["mbsec-e00mockgrafana", "mbsec-e00mocktransfer", "mbsec-e00mockgrafana"] }
    }
  }

  assert {
    condition     = keys(nebius_iam_v1_group.ci_secret_readers) == ["prod"] && length(nebius_iam_v1_access_permit.ci_secret_payload) == 2
    error_message = "one reader group per stage that lists secrets, one permit per distinct secret"
  }
  assert {
    condition     = alltrue([for p in nebius_iam_v1_access_permit.ci_secret_payload : p.role == "mysterybox.payload-viewer" && startswith(p.resource_id, "mbsec-")])
    error_message = "payload-viewer on the secret itself, never the project"
  }
  assert {
    condition     = nebius_iam_v1_group_membership.ci_secret_readers["prod"].member_id == "serviceaccount-e00mockapply"
    error_message = "the apply identity (editor) is the member; the plan identity never reads payloads"
  }
  assert {
    condition     = jsonencode(output.ci_secret_grants) == jsonencode({ prod = ["mbsec-e00mockgrafana", "mbsec-e00mocktransfer"] })
    error_message = "grants are reported per stage"
  }
}

run "no_secret_ids_no_secret_grants" {
  command = plan

  assert {
    condition     = length(nebius_iam_v1_group.ci_secret_readers) == 0 && length(nebius_iam_v1_access_permit.ci_secret_payload) == 0
    error_message = "payload access is opt-in per stage"
  }
}

run "secret_ids_need_the_ci_identity" {
  command = plan

  variables {
    stages = { sandbox = { project_id = "project-e00sandbox", region = "eu-north1", ci_secret_ids = ["mbsec-e00mock"] } }
  }

  expect_failures = [var.stages]
}

run "rejects_a_malformed_secret_id" {
  command = plan

  variables {
    stages = { prod = { project_id = "project-e00prod", region = "eu-north1", ci = true, ci_secret_ids = ["project-e00prod"] } }
  }

  expect_failures = [var.stages]
}

run "ci_federation_is_off_by_default" {
  command = plan

  assert {
    condition     = length(module.ci_federation) == 0 && length(output.ci_federation) == 0
    error_message = "no federated credential and no team group unless ci_federation or team_groups is set (R13)"
  }
}

run "ci_federation_binds_each_ci_stage_to_its_environments" {
  command = plan

  variables {
    ci_federation = { repository = "example-org/infra", repository_id = "200000002", repository_owner_id = "100000001" }
  }

  assert {
    condition     = length(module.ci_federation) == 1 && length(module.ci_federation[0].federated_credentials) == 2
    error_message = "one credential each for prod's apply and plan accounts; none for sandbox (ci = false)"
  }
  assert {
    condition     = module.ci_federation[0].federated_credentials["prod/apply"].subject == "repo:example-org/infra:repository_owner_id:100000001:repository_id:200000002:environment:prod" && module.ci_federation[0].federated_credentials["prod/plan"].subject == "repo:example-org/infra:repository_owner_id:100000001:repository_id:200000002:environment:prod-plan"
    error_message = "apply trusts the prod environment, plan the prod-plan environment, both pinned by the immutable owner and repository ids"
  }
  assert {
    condition     = !contains(keys(module.ci_federation[0].federated_credentials), "sandbox/apply") && !contains(keys(module.ci_federation[0].federated_credentials), "sandbox/plan")
    error_message = "a stage with ci = false gets no federated credential"
  }
}

run "team_groups_alone_need_no_repository" {
  command = plan

  variables {
    team_groups = {
      ml-readers = {
        project_id = "project-e00prod"
        permits    = { project = { role = "viewer" } }
        members    = { trainer = "serviceaccount-e00mock0000" }
      }
    }
  }

  assert {
    condition     = length(module.ci_federation) == 1 && length(module.ci_federation[0].federated_credentials) == 0
    error_message = "team groups alone create no federated credential"
  }
}

# The plan job (environment "<stage>-plan", no reviewers) reaches state through its own read-only
# identity: storage.object-viewer on the bucket, so a plan from any branch cannot rewrite state.
run "ci_stage_gets_a_read_only_state_identity_for_plans" {
  command = plan

  assert {
    condition     = keys(module.state_reader_identity) == ["prod"] && module.state_reader_identity["prod"].role == "storage.object-viewer" && module.state_identity["prod"].role == "storage.object-editor"
    error_message = "a CI stage gets a second, read-only state identity (storage.object-viewer) for its plan job; the apply/bootstrap identity keeps storage.object-editor"
  }
  assert {
    condition     = keys(output.ci_plan_state_identities) == ["prod"]
    error_message = "ci_plan_state_identities names the read-only state account for each CI stage only"
  }
}
