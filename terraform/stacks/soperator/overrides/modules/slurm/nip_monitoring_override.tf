# Copyright 2024 Nebius B.V. (adapted portions); Apache-2.0.
# Modified by Taylor Dean: override changes described below; see docs/source-provenance.md.
# Override file copied by scripts/fetch-soperator.sh into upstream/soperator/modules/slurm/.
# Makes telemetry_enabled = false actually work on Soperator 4.1.13 (written against tag
# soperator-v4.1.13-2; only `values` of the named resource is replaced).
#
# Observed live (prior Soperator run 1, docs/soperator-compatibility.md): with telemetry off the recipe skips the
# prometheus-operator CRDs and the monitoring-system namespace, but four charts still render a
# ServiceMonitor by default (helm-soperator, -soperatorchecks, -nodeconfigurator, -slurm-cluster's
# sConfigController) and the fluxcd chart still installs the monitoring-dashboards release, so the
# soperator HelmRelease fails on the missing CRD and the Slurm cluster never comes up.
# Fix through the recipe's own extension point: the ad-hoc ConfigMap soperator-fluxcd-values
# (layered after terraform-fluxcd-values) plus the optional per-release ConfigMaps nodeconfigurator
# and slurm-cluster (valuesFrom, optional: true). With telemetry on the vendored template is used.

resource "helm_release" "soperator_fluxcd_ad_hoc_cm" {
  values = [var.telemetry_enabled ? templatefile("${path.module}/templates/helm_values/soperator_fluxcd.yaml.tftpl", {}) : yamlencode({
    resources = [for name, vals in {
      "soperator-fluxcd-values" = {
        soperator = {
          values               = { serviceMonitor = { enabled = false } }
          soperatorChecks      = { values = { serviceMonitor = { enabled = false } } }
          monitoringDashboards = { enabled = false }
        }
      }
      "nodeconfigurator" = { serviceMonitor = { enabled = false } }
      "slurm-cluster"    = { sConfigController = { serviceMonitor = { enabled = false } } }
      } : {
      apiVersion = "v1"
      kind       = "ConfigMap"
      metadata = {
        name        = name
        labels      = { "reconcile.fluxcd.io/watch" = "Enabled" }
        annotations = { "helm.sh/resource-policy" = "keep" }
      }
      data = { "values.yaml" = yamlencode(vals) }
    }]
  })]
}
