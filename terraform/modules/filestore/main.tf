# Shared network filesystem (Filestore). Mirrors k8s-training/filesystem.tf.
# The filesystem is attached to node groups via modules/node-group (filesystem
# input) and mounted by cloud-init at mount_path. The CSI driver that exposes it
# as a ReadWriteMany StorageClass lives in modules/filestore-csi and must be
# installed AFTER the node groups exist (the chart is atomic and waits for pods).

resource "nebius_compute_v1_filesystem" "this" {
  count = var.existing_filesystem_id == null ? 1 : 0

  parent_id        = var.parent_id
  name             = var.name
  type             = var.type
  size_gibibytes   = var.size_gib
  block_size_bytes = var.block_size_kib * 1024
  forbid_deletion  = var.forbid_deletion
  labels           = var.labels

  # Labels are written at creation only: a filesystem can outlive the run that created it (R8),
  # and a later run's nip-run / TTL labels must not rewrite the volume's attribution.
  lifecycle {
    ignore_changes = [labels]
  }
}

data "nebius_compute_v1_filesystem" "existing" {
  count = var.existing_filesystem_id == null ? 0 : 1
  id    = var.existing_filesystem_id
}

locals {
  id = var.existing_filesystem_id == null ? one(nebius_compute_v1_filesystem.this).id : one(data.nebius_compute_v1_filesystem.existing).id
}
