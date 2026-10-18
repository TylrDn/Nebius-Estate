# Mocked plan of the upstream Soperator recipe with our overrides. Copied by CI (and
# scripts/fetch-soperator.sh --no-backend) into <upstream>/soperator/installations/
# example/tests-nip/ and run with both var files:
#   terraform test -test-directory=tests-nip -var-file=terraform.tfvars \
#     -var-file=<repo>/terraform/stacks/soperator/profiles/lab.tfvars -var-file=<repo>/terraform/live/<stage>/soperator/stage.tfvars
# It proves the tfvars layers name real variables with the right types, that every stage plans,
# and that every upstream finding (docs/upstream-findings.md, R4-*) stays fixed. Mocked providers return fake data, so a
# placeholder filesystem id would plan "successfully": the assertions below catch that.
# No credentials, no spend.

mock_provider "nebius" {}
mock_provider "flux" {}
mock_provider "helm" {}
mock_provider "kubernetes" {}
mock_provider "units" {}
mock_provider "string-functions" {}

variables {
  region                           = "eu-north1"
  iam_token                        = "mock-token"
  iam_project_id                   = "project-e00mock"
  iam_tenant_id                    = "tenant-e00mock"
  o11y_iam_tenant_id               = "tenant-e00mock"
  o11y_profile                     = "mock"
  vpc_subnet_id                    = "vpcsubnet-e00mock"
  slurm_login_ssh_root_public_keys = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyForPlanOnlyTestsDoNotUse00000000000 ci@nip"]
}

run "lab_profile_plans" {
  command = plan

  # R4-1: the example attaches placeholder filesystem ids; the lab profile must create them.
  assert {
    condition     = var.filestore_jail.spec != null && !strcontains(jsonencode(var.filestore_jail), "<YOUR-")
    error_message = "filestore_jail must be created from a spec, not attached by the example's placeholder id"
  }
  assert {
    condition     = alltrue([for m in var.filestore_jail_submounts : m.spec != null && !strcontains(jsonencode(m), "<YOUR-")])
    error_message = "every jail submount must be created from a spec, not attached by a placeholder id"
  }
  assert {
    condition     = !strcontains(jsonencode(var.filestore_controller_spool), "<YOUR-") && !strcontains(jsonencode(var.filestore_accounting), "<YOUR-")
    error_message = "no filesystem variable may carry the example's <YOUR-...> placeholder"
  }

  # R4-2: AppArmor profile never loaded on the nodes in the live runs.
  assert {
    condition     = var.use_default_apparmor_profile == false
    error_message = "use_default_apparmor_profile must be false (lab 04: CreateContainerError with the default profile)"
  }

  # R4-5: the release supports Kubernetes 1.32-1.35; the Managed Kubernetes default is 1.36.
  assert {
    condition     = tostring(var.k8s_version) == "1.35"
    error_message = "k8s_version must be pinned to 1.35: the only version both this release (1.32-1.35) and Managed Kubernetes for new clusters (1.34+) accept with headroom"
  }

  # R4-4: lab sizing, no GPU cluster, no NFS server, no accounting/telemetry stacks.
  assert {
    condition     = var.nfs_in_k8s.enabled == false
    error_message = "the lab profile must not deploy the 3,720 GiB IO_M3 NFS server"
  }
  assert {
    condition     = var.accounting_enabled == false && var.telemetry_enabled == false && var.slurm_exporter_enabled == false && var.public_o11y_enabled == false
    error_message = "accounting, telemetry, the exporter and public o11y are off in the lab profile"
  }
  assert {
    condition     = alltrue([for w in var.slurm_nodeset_workers : w.gpu_cluster == null && !startswith(w.resource.platform, "gpu-")])
    error_message = "lab workers are CPU nodes without a GPU cluster until a spend approval raises them"
  }
  assert {
    condition     = alltrue([for w in var.slurm_nodeset_workers : w.boot_disk.size_gibibytes >= 512]) && var.slurm_nodeset_login.boot_disk.size_gibibytes >= 256
    error_message = "release minimums: worker boot disk >= 512 GiB, login boot disk >= 256 GiB"
  }
  assert {
    condition     = var.slurm_nodeset_system.min_size == 3 && var.slurm_nodeset_system.max_size == 3 && var.slurm_nodeset_controller.resource.preset == "4vcpu-16gb"
    error_message = "system nodes pinned to 3 and the controller to 4vcpu-16gb (lab 04 sizing)"
  }

  # R4-3: the scope the recipe's validation accepts; the override narrows its dependsOn.
  assert {
    condition     = var.active_checks_scope == "essential"
    error_message = "active_checks_scope must be \"essential\" (the example's empty value is rejected by the recipe)"
  }
  # Stage layer (ADR-0009): sandbox/staging keep the lab profile's production = false and no
  # backups; prod's stage.tfvars may turn production on only with the recipe's merge-request gate
  # and deletion-protected jails.
  assert {
    condition     = var.production ? (var.iam_merge_request_url != "" && var.filestore_jail.spec.forbid_deletion && alltrue([for m in var.filestore_jail_submounts : m.spec.forbid_deletion])) : var.backups_enabled == "force_disable"
    error_message = "non-prod: backups off and production = false; prod: production = true needs iam_merge_request_url and forbid_deletion on the jail and every submount"
  }
}
