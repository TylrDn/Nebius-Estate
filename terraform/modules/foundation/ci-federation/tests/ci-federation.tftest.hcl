# Mocked plan tests for the CI federation module (R13). Fixture IDs are fakes.
mock_provider "nebius" {}

variables {
  repository          = "example-org/infra"
  repository_id       = "200000002"
  repository_owner_id = "100000001"
  stages = {
    sandbox = {
      project_id               = "project-e00mocksandbox0000"
      apply_service_account_id = "serviceaccount-e00mockapplysbx"
      plan_service_account_id  = "serviceaccount-e00mockplansbx0"
    }
    prod = {
      project_id               = "project-e00mockprod0000000"
      apply_service_account_id = "serviceaccount-e00mockapplyprd"
      plan_service_account_id  = "serviceaccount-e00mockplanprd0"
    }
  }
}

run "default_subjects_follow_the_workflow_environments" {
  command = plan

  assert {
    condition     = length(nebius_iam_v1_federated_credentials.ci) == 4
    error_message = "two stages x (apply, plan) must give four federated credentials"
  }
  assert {
    condition     = nebius_iam_v1_federated_credentials.ci["prod/apply"].name == "nip-prod-gha-apply" && nebius_iam_v1_federated_credentials.ci["sandbox/plan"].name == "nip-sandbox-gha-plan"
    error_message = "credentials are named <prefix>-<stage>-gha-<job> (docs/naming.md: new stage identities put the stage second)"
  }
  assert {
    condition     = nebius_iam_v1_federated_credentials.ci["prod/apply"].federated_subject_id == "repo:example-org/infra:repository_owner_id:100000001:repository_id:200000002:environment:prod"
    error_message = "the apply identity must accept only the <stage> environment of this repository, pinned by its immutable owner and repository ids"
  }
  assert {
    condition     = nebius_iam_v1_federated_credentials.ci["prod/plan"].federated_subject_id == "repo:example-org/infra:repository_owner_id:100000001:repository_id:200000002:environment:prod-plan"
    error_message = "the plan identity must accept only the <stage>-plan environment"
  }
  assert {
    condition     = nebius_iam_v1_federated_credentials.ci["prod/apply"].subject_id == "serviceaccount-e00mockapplyprd" && nebius_iam_v1_federated_credentials.ci["prod/plan"].subject_id == "serviceaccount-e00mockplanprd0"
    error_message = "apply must impersonate the editor account and plan the viewer account, never the reverse"
  }
  assert {
    condition     = alltrue([for k, c in nebius_iam_v1_federated_credentials.ci : c.oidc_provider.issuer_url == "https://token.actions.githubusercontent.com" && c.oidc_provider.jwk_set_json == null])
    error_message = "every credential must trust the GitHub Actions issuer through its discovery document"
  }
  assert {
    condition     = nebius_iam_v1_federated_credentials.ci["sandbox/apply"].parent_id == "project-e00mocksandbox0000"
    error_message = "the credential belongs to the stage project, beside its service account"
  }
  assert {
    condition     = output.github_environments["prod-plan"].NIP_SA_ID == "serviceaccount-e00mockplanprd0" && output.github_environments["sandbox"].NIP_SA_ID == "serviceaccount-e00mockapplysbx"
    error_message = "github_environments must map each environment to its own service account"
  }
  assert {
    condition     = length(nebius_iam_v1_group.team) == 0
    error_message = "no team groups unless asked"
  }
}

run "a_stage_without_a_plan_account_gets_only_apply" {
  command = plan

  variables {
    stages = {
      staging = {
        project_id               = "project-e00mockstaging000"
        jobs                     = ["apply"]
        apply_service_account_id = "serviceaccount-e00mockapplystg"
      }
    }
  }

  assert {
    condition     = keys(nebius_iam_v1_federated_credentials.ci) == ["staging/apply"]
    error_message = "a null account id must create no credential"
  }
}

run "hardened_subject_override_is_accepted" {
  command = plan

  variables {
    stages = {
      prod = {
        project_id               = "project-e00mockprod0000000"
        jobs                     = ["apply"]
        apply_service_account_id = "serviceaccount-e00mockapplyprd"
        apply_subject            = "repo:example-org/infra:environment:prod:repository_owner_id:1000001"
      }
    }
  }

  assert {
    condition     = nebius_iam_v1_federated_credentials.ci["prod/apply"].federated_subject_id == "repo:example-org/infra:environment:prod:repository_owner_id:1000001"
    error_message = "an override inside the repository and naming an environment must be used as given"
  }
}

run "refuses_a_subject_from_another_repository" {
  command = plan

  variables {
    stages = {
      prod = {
        project_id               = "project-e00mockprod0000000"
        jobs                     = ["apply"]
        apply_service_account_id = "serviceaccount-e00mockapplyprd"
        apply_subject            = "repo:someone-else/infra:environment:prod"
      }
    }
  }

  expect_failures = [var.stages]
}

run "refuses_a_wildcard_subject" {
  command = plan

  variables {
    stages = {
      sandbox = {
        project_id              = "project-e00mocksandbox0000"
        jobs                    = ["plan"]
        plan_service_account_id = "serviceaccount-e00mockplansbx0"
        plan_subject            = "repo:example-org/infra:ref:refs/heads/*"
      }
    }
  }

  expect_failures = [var.stages]
}

run "refuses_a_pull_request_subject" {
  command = plan

  variables {
    stages = {
      sandbox = {
        project_id              = "project-e00mocksandbox0000"
        jobs                    = ["plan"]
        plan_service_account_id = "serviceaccount-e00mockplansbx0"
        plan_subject            = "repo:example-org/infra:pull_request"
      }
    }
  }

  expect_failures = [var.stages]
}

run "refuses_an_apply_subject_bound_to_a_ref_not_an_environment" {
  command = plan

  variables {
    stages = {
      staging = {
        project_id               = "project-e00mockstaging000"
        jobs                     = ["apply"]
        apply_service_account_id = "serviceaccount-e00mockapplystg"
        apply_subject            = "repo:example-org/infra:ref:refs/heads/main"
      }
    }
  }

  expect_failures = [var.stages]
}

run "refuses_two_identities_on_one_subject" {
  command = plan

  variables {
    stages = {
      staging = {
        project_id               = "project-e00mockstaging000"
        apply_service_account_id = "serviceaccount-e00mockapplystg"
        plan_service_account_id  = "serviceaccount-e00mockplanstg0"
        plan_subject             = "repo:example-org/infra:repository_owner_id:100000001:repository_id:200000002:environment:staging" # the apply default
      }
    }
  }

  expect_failures = [terraform_data.subject_check]
}

run "refuses_a_tenant_parent" {
  command = plan

  variables {
    stages = {
      sandbox = {
        project_id               = "tenant-e00mock00000000000"
        jobs                     = ["apply"]
        apply_service_account_id = "serviceaccount-e00mockapplysbx"
      }
    }
  }

  expect_failures = [var.stages]
}

run "refuses_a_bad_repository_or_issuer" {
  command = plan

  variables {
    repository = "https://github.com/example-org/infra"
    issuer_url = "http://token.actions.githubusercontent.com/"
  }

  expect_failures = [var.repository, var.issuer_url]
}

run "a_listed_job_needs_its_account" {
  command = plan

  variables {
    stages = {
      staging = {
        project_id               = "project-e00mockstaging000"
        apply_service_account_id = "serviceaccount-e00mockapplystg"
      }
    }
  }

  expect_failures = [var.stages]
}

run "stages_need_a_repository" {
  command = plan

  variables {
    repository = null
  }

  expect_failures = [var.stages]
}

run "team_group_is_project_scoped_least_privilege" {
  command = plan

  variables {
    repository = null
    stages     = {}
    groups = {
      ml-readers = {
        project_id = "project-e00mocksandbox0000"
        permits = {
          project = { role = "viewer" }
          bucket  = { role = "storage.object-viewer", resource_id = "storagebucket-e00mock0000000" }
        }
        members = { trainer = "serviceaccount-e00mockteam0000" }
      }
    }
  }

  assert {
    condition     = nebius_iam_v1_group.team["ml-readers"].parent_id == "project-e00mocksandbox0000" && nebius_iam_v1_group.team["ml-readers"].name == "nip-team-ml-readers"
    error_message = "the team group must be created inside the project"
  }
  assert {
    condition     = length(nebius_iam_v1_access_permit.team) == 2
    error_message = "one access permit per labelled permit"
  }
  assert {
    condition     = nebius_iam_v1_access_permit.team["ml-readers/project"].resource_id == "project-e00mocksandbox0000" && nebius_iam_v1_access_permit.team["ml-readers/project"].role == "viewer"
    error_message = "a permit without resource_id targets the group's project"
  }
  assert {
    condition     = nebius_iam_v1_access_permit.team["ml-readers/bucket"].role == "storage.object-viewer" && nebius_iam_v1_access_permit.team["ml-readers/bucket"].resource_id == "storagebucket-e00mock0000000"
    error_message = "a resource-level permit keeps its narrow role"
  }
  assert {
    condition     = nebius_iam_v1_group_membership.team["ml-readers/trainer"].member_id == "serviceaccount-e00mockteam0000"
    error_message = "members join by their labelled id"
  }
  assert {
    condition     = length(nebius_iam_v1_federated_credentials.ci) == 0
    error_message = "groups alone create no federated credential"
  }
}

run "team_group_refuses_admin_and_tenant_permits" {
  command = plan

  variables {
    repository = null
    stages     = {}
    groups = {
      ops = {
        project_id = "project-e00mocksandbox0000"
        permits = {
          everything = { role = "admin" }
          tenant     = { role = "viewer", resource_id = "tenant-e00mock00000000000" }
        }
      }
    }
  }

  expect_failures = [var.groups]
}

run "team_group_refuses_a_tenant_parent_and_empty_permits" {
  command = plan

  variables {
    repository = null
    stages     = {}
    groups = {
      ops = {
        project_id = "tenant-e00mock00000000000"
        permits    = {}
      }
    }
  }

  expect_failures = [var.groups]
}

# A name-only subject matches whoever holds owner/name, including a re-registered repository
# after a rename or deletion: it is an explicit opt-in, never the default.
run "ids_are_required_unless_name_subjects_are_chosen" {
  command = plan

  variables {
    repository_id       = null
    repository_owner_id = null
  }

  expect_failures = [var.subject_claims]
}

# GitHub's immutable subject (use_immutable_subject = true, seen on this repository 2026-10-11): the
# ids are inline in the prefix, so the "ids" template shape would never match a real token.
run "immutable_subjects_match_githubs_immutable_prefix" {
  command = plan

  variables {
    subject_claims = "immutable"
  }

  assert {
    condition     = nebius_iam_v1_federated_credentials.ci["prod/apply"].federated_subject_id == "repo:example-org@100000001/infra@200000002:environment:prod" && nebius_iam_v1_federated_credentials.ci["prod/plan"].federated_subject_id == "repo:example-org@100000001/infra@200000002:environment:prod-plan"
    error_message = "subject_claims = immutable is repo:<owner>@<owner id>/<name>@<repository id>:environment:<name>"
  }
}

run "immutable_subject_override_is_accepted" {
  command = plan

  variables {
    subject_claims = "immutable"
    stages = {
      prod = {
        project_id               = "project-e00mockprod0000000"
        jobs                     = ["apply"]
        apply_service_account_id = "serviceaccount-e00mockapplyprd"
        apply_subject            = "repo:example-org@100000001/infra@200000002:environment:prod"
      }
    }
  }

  assert {
    condition     = nebius_iam_v1_federated_credentials.ci["prod/apply"].federated_subject_id == "repo:example-org@100000001/infra@200000002:environment:prod"
    error_message = "an override in GitHub's immutable form is this repository's subject"
  }
}

run "name_subjects_are_an_explicit_opt_in" {
  command = plan

  variables {
    repository_id       = null
    repository_owner_id = null
    subject_claims      = "name"
  }

  assert {
    condition     = nebius_iam_v1_federated_credentials.ci["prod/apply"].federated_subject_id == "repo:example-org/infra:environment:prod" && nebius_iam_v1_federated_credentials.ci["prod/plan"].federated_subject_id == "repo:example-org/infra:environment:prod-plan"
    error_message = "subject_claims = name keeps GitHub's default sub (repo:<owner>/<repo>:environment:<name>)"
  }
}

run "refuses_non_numeric_ids" {
  command = plan

  variables {
    repository_id = "infra"
  }

  expect_failures = [var.repository_id]
}
