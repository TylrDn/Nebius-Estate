# Copyright 2024 Nebius B.V. (adapted portions); Apache-2.0.
# Modified by Taylor Dean: conditional settings, driver/CDI options, typed values and release hash.
# Source/ref/path and license: docs/source-provenance.md, third_party/licenses/.
# NVIDIA GPU Operator from the Nebius Marketplace (operator-managed drivers,
# device plugin, DCGM, MIG). Used by node groups WITHOUT gpu_settings.drivers_preset
# (ADR-0003). Mirrors nebius-solutions-library/modules/gpu-operator @ soperator-v4.1.13-2
# (d1c15ca). The Marketplace release carries no chart version to pin; the docs install
# GPU Operator v25.10.0 and set driver.version=580.95.05 on B300 (driver_version).

resource "nebius_applications_v1alpha1_k8s_release" "this" {
  cluster_id = var.cluster_id
  parent_id  = var.parent_id

  application_name = "gpu-operator"
  namespace        = "gpu-operator"
  product_slug     = "nebius/nvidia-gpu-operator"

  sensitive = {
    version = md5(jsonencode(local.set))
    set     = local.set
  }
}

locals {
  set = merge(
    {
      "dcgmExporter.enabled"                = tostring(var.enable_dcgm_exporter)
      "dcgmExporter.serviceMonitor.enabled" = tostring(var.enable_dcgm_service_monitor)
    },
    var.mig_strategy == null ? {} : { "mig.strategy" = var.mig_strategy },
    var.cdi_enabled == null ? {} : { "cdi.enabled" = tostring(var.cdi_enabled) },
    var.driver_version == null ? {} : { "driver.version" = var.driver_version },
  )
}
