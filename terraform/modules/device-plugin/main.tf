# Copyright 2024 Nebius B.V. (adapted portions); Apache-2.0.
# Modified by Taylor Dean: local settings map, typed values and content-hash release version.
# Source/ref/path and license: docs/source-provenance.md, third_party/licenses/.
# NVIDIA device plugin (+ optional DCGM exporter) from the Nebius Marketplace.
# Used with node groups that boot the managed driver image
# (gpu_settings.drivers_preset); the GPU Operator is not installed on that
# path. Mirrors nebius-solutions-library/modules/device-plugin @ soperator-v4.1.13-2 (d1c15ca).

resource "nebius_applications_v1alpha1_k8s_release" "this" {
  cluster_id = var.cluster_id
  parent_id  = var.parent_id

  application_name = "nvidia-device-plugin"
  namespace        = "nvidia-device-plugin"
  product_slug     = "nebius/nvidia-device-plugin"

  # write-only values: `version` hashes them so an edit produces a diff (R1-13).
  sensitive = {
    version = md5(jsonencode(local.set))
    set     = local.set
  }
}

locals {
  set = {
    "dcgm-exporter.enabled" = tostring(var.dcgm_exporter_enabled)
  }
}
