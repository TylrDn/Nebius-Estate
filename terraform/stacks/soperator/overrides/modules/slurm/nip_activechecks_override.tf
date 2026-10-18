# Copyright 2024 Nebius B.V. (adapted portions); Apache-2.0.
# Modified by Taylor Dean: override changes described below; see docs/source-provenance.md.
# Override file copied by scripts/fetch-soperator.sh into upstream/soperator/modules/slurm/.
# Terraform merges *_override.tf into the vendored module: only the attributes named here are
# replaced (locals by name, the provisioner of the named resource). Written against
# nebius-solutions-library tag soperator-v4.1.13-2; re-verify on every tag bump.
#
# Why (observed live in prior Soperator runs 4-5, docs/soperator-compatibility.md):
#   1. With active_checks_scope = "essential" the ensure-healthy-nodes check dependsOn every GPU
#      check, and the scope sets runAfterCreation = false on all of them (locals_active_checks.tf),
#      so it never starts and terraform_data.wait_for_soperator_activechecks_hr blocks for its full
#      240 minutes. The recipe narrows the same dependsOn for GB300; this does it for "essential".
#   2. The checks controller reads slurmJob results through the Slurm REST API, which Soperator
#      only creates when accounting is enabled. With accounting off the wait can never succeed, so
#      it is replaced by a note and `sbatch` (runbooks/soperator-jobs.md) is the health gate.

locals {
  soperator_activechecks_override_yaml = yamlencode(
    merge(
      local.active_checks_scopes[var.active_checks_scope],
      var.active_checks_scope == "essential" ? {
        ensure-healthy-nodes = {
          dependsOn = ["wait-for-soperatorchecks-srun-ready", "wait-for-topology"]
        }
      } : {},
      {
        for check_name, check_config in local.gb300_active_checks_overrides :
        check_name => check_config
        if local.gb300_enabled
      }
    )
  )
}

resource "terraform_data" "wait_for_soperator_activechecks_hr" {
  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command = var.accounting_enabled ? templatefile("${path.module}/scripts/wait_for_flux_hr.sh.tmpl", {
      k8s_cluster_context = var.k8s_cluster_context
      helmrelease_name    = "flux-system-soperator-fluxcd-soperator-activechecks"
      timeout_minutes     = 240
    }) : "echo 'nip: accounting is off, so Soperator has no REST API and slurmJob active checks cannot report; skipping the recipe wait (runbooks/soperator-jobs.md: sbatch is the health gate)'"
  }
}
