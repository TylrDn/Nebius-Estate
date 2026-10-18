# Copyright 2024 Nebius B.V. (adapted portions); Apache-2.0.
# Modified by Taylor Dean: Helm chart version, node tolerations, variables and StorageClass predicates.
# Source/ref/path and license: docs/source-provenance.md, third_party/licenses/.
# csi-mounted-fs-path: exposes a Filestore that is already mounted on every node
# (modules/filestore + modules/node-group cloud-init) as a ReadWriteMany
# StorageClass. Chart and version follow https://docs.nebius.com/kubernetes/storage/filesystem-over-csi
# (0.1.10 from cr.eu-north1; the upstream recipe still pins 0.1.5). Mirrors
# helm_release.filesystem_csi in k8s-training/filesystem.tf,
# including its depends_on the node groups: the chart is atomic and waits for
# pods, so the root must pass the node-group modules in depends_on.

locals {
  data_dir = "${trimsuffix(var.mount_path, "/")}/csi-mounted-fs-path-data/"
}

resource "helm_release" "csi" {
  name             = "csi-mounted-fs-path"
  repository       = var.csi.chart_repository
  chart            = "csi-mounted-fs-path"
  version          = var.csi.chart_version
  namespace        = var.csi.namespace
  create_namespace = true
  atomic           = true
  wait             = true

  # dataDir is the only value the docs set. The chart ships `tolerations: []`, so without the
  # entries below its node DaemonSet never lands on tainted GPU nodes and a ReadWriteMany PVC
  # cannot mount there (the vLLM pod stays Pending) — verified with `helm show values` 0.1.10.
  set = concat(
    [{ name = "dataDir", value = local.data_dir }],
    flatten([for i, t in var.csi.tolerations : [
      { name = "tolerations[${i}].key", value = t.key },
      { name = "tolerations[${i}].operator", value = t.operator },
      { name = "tolerations[${i}].effect", value = t.effect },
    ]]),
  )
}

resource "kubernetes_annotations" "demote_previous_default" {
  count = var.csi.make_default_storage_class && var.csi.previous_default_storage_class_name != "" ? 1 : 0

  api_version = "storage.k8s.io/v1"
  kind        = "StorageClass"
  force       = true

  metadata {
    name = var.csi.previous_default_storage_class_name
  }

  annotations = {
    "storageclass.kubernetes.io/is-default-class" = "false"
  }

  depends_on = [helm_release.csi]
}

resource "kubernetes_annotations" "promote_default" {
  count = var.csi.make_default_storage_class ? 1 : 0

  api_version = "storage.k8s.io/v1"
  kind        = "StorageClass"
  force       = true

  metadata {
    name = "csi-mounted-fs-path-sc"
  }

  annotations = {
    "storageclass.kubernetes.io/is-default-class" = "true"
  }

  depends_on = [helm_release.csi, kubernetes_annotations.demote_previous_default]
}
