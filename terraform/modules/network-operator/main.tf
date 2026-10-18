# Copyright 2024 Nebius B.V. (adapted portions); Apache-2.0.
# Modified by Taylor Dean: local settings map, typed values and content-hash release version.
# Source/ref/path and license: docs/source-provenance.md, third_party/licenses/.
# NVIDIA Network Operator from the Nebius Marketplace. Required only for node groups
# WITHOUT the managed driver image that use B200 or an InfiniBand GPU cluster; install
# it BEFORE the GPU Operator and wait for state-OFED (docs/kubernetes/gpu/set-up; the
# docs install chart 25.7.0, the Marketplace release carries no version to pin).
# Mirrors nebius-solutions-library/modules/network-operator @ soperator-v4.1.13-2 (d1c15ca).

resource "nebius_applications_v1alpha1_k8s_release" "this" {
  cluster_id = var.cluster_id
  parent_id  = var.parent_id

  application_name = "network-operator"
  namespace        = "network-operator"
  product_slug     = "nebius/nvidia-network-operator"

  sensitive = {
    version = md5(jsonencode(local.set))
    set     = local.set
  }
}

locals {
  set = {
    "operator.resources.limits.cpu"             = var.limit_cpu
    "operator.resources.limits.memory"          = var.limit_memory
    "operator.ofedDriver.livenessProbe.enabled" = "false"
  }
}
