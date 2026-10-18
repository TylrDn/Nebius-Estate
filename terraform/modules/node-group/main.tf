# One managed-Kubernetes node group (CPU or GPU). Mirrors the cpu-only / gpu
# node groups in nebius-solutions-library/k8s-training/main.tf @ soperator-v4.1.13-2 (d1c15ca), with
# the GPU driver image (gpu_settings.drivers_preset) as the default path per
# https://docs.nebius.com/kubernetes/gpu/set-up (ADR-0003).

locals {
  # Platforms whose 8-GPU preset can join a GPU cluster (docs compute/virtual-machines/types).
  gpu_cluster_platforms = ["gpu-h100-sxm", "gpu-h200-sxm", "gpu-b200-sxm", "gpu-b200-sxm-a", "gpu-b300-sxm"]

  is_gpu = var.drivers_preset != null || startswith(var.preset, "1gpu-") || startswith(var.preset, "2gpu-") || startswith(var.preset, "4gpu-") || startswith(var.preset, "8gpu-")

  cloud_init = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    filestore_mount_path = var.filesystem == null ? "" : var.filesystem.mount_path
    filestore_mount_tag  = var.filesystem == null ? "" : var.filesystem.mount_tag
    # Encoded, not interpolated raw: each value is one quoted, escaped scalar (JSON is a YAML subset;
    # yamlencode would emit a multi-line block that breaks the template's indentation), so a key
    # with newlines cannot add users, keys or sudo rules.
    ssh_user_name  = jsonencode(var.ssh_user_name)
    ssh_public_key = var.ssh_public_key == null ? null : jsonencode(var.ssh_public_key)
  })
}

resource "nebius_mk8s_v1_node_group" "this" {
  parent_id = var.cluster_id
  name      = var.name
  labels    = var.labels
  version   = var.k8s_version

  fixed_node_count = var.autoscaling == null ? var.fixed_node_count : null
  autoscaling = var.autoscaling == null ? null : {
    min_node_count = var.autoscaling.min
    max_node_count = var.autoscaling.max
  }

  strategy = var.strategy != null ? var.strategy : (var.rollout_surge ? {
    max_surge       = { count = 1, percent = null }
    max_unavailable = { count = 0, percent = null }
    drain_timeout   = null
  } : null)

  template = {
    resources = {
      platform = var.platform
      preset   = var.preset
    }

    boot_disk = {
      size_gibibytes = var.boot_disk_size_gib
      type           = var.boot_disk_type
    }

    network_interfaces = [
      {
        subnet_id         = var.subnet_id
        public_ip_address = var.public_ip ? {} : null
        security_groups   = length(var.security_group_ids) > 0 ? [for id in var.security_group_ids : { id = id }] : null
      }
    ]

    # Capacity reservations (docs: kubernetes/node-groups/reservations): STRICT pins the group to
    # reserved capacity, which is incompatible with preemptible; AUTO falls back to on-demand;
    # FORBID uses the common pool only. null sends nothing and the API applies AUTO.
    reservation_policy = var.reservation == null ? null : {
      policy          = var.reservation.policy
      reservation_ids = length(var.reservation.reservation_ids) > 0 ? var.reservation.reservation_ids : null
    }

    filesystems = var.filesystem == null ? null : [
      {
        attach_mode = "READ_WRITE"
        mount_tag   = var.filesystem.mount_tag
        existing_filesystem = {
          id = var.filesystem.id
        }
      }
    ]

    service_account_id = var.service_account_id
    instance_metadata  = length(var.instance_metadata_labels) == 0 ? null : { labels = var.instance_metadata_labels }

    gpu_cluster  = var.gpu_cluster_id == null ? null : { id = var.gpu_cluster_id }
    gpu_settings = var.drivers_preset == null ? null : { drivers_preset = var.drivers_preset }

    # The docs: "Set one of the spot pricing settings" with preemptible — a policy
    # (price cap) or follows_spot_price. The upstream recipe sets neither.
    preemptible         = var.preemptible ? {} : null
    spot_pricing_policy = var.preemptible && var.spot_pricing_policy_id != null ? { id = var.spot_pricing_policy_id } : null
    follows_spot_price  = var.preemptible && var.spot_pricing_policy_id == null ? {} : null

    taints = var.taints

    metadata = {
      labels = var.node_labels
    }

    cloud_init_user_data = local.cloud_init
  }

  lifecycle {
    precondition {
      # docs compute/virtual-machines/types#presets-compatible-with-gpu-clusters: only the 8-GPU presets of
      # these platforms; RTX PRO 6000 has an 8-GPU preset that is NOT GPU-cluster compatible.
      condition     = var.gpu_cluster_id == null || (startswith(var.preset, "8gpu-") && contains(local.gpu_cluster_platforms, var.platform))
      error_message = "A GPU cluster (InfiniBand) requires an 8-GPU preset on ${join(", ", local.gpu_cluster_platforms)}; '${var.platform}' / '${var.preset}' is not one. Leave gpu_cluster_id null otherwise."
    }
    precondition {
      # docs kubernetes/node-groups/manage#regular-node-groups: "VMs without GPUs only support the regular type".
      condition     = !var.preemptible || local.is_gpu
      error_message = "Preemptible node groups must have GPUs; CPU node groups support the regular type only."
    }
    precondition {
      condition     = var.reservation == null || try(var.reservation.policy, "") != "FORBID" || length(try(var.reservation.reservation_ids, [])) == 0
      error_message = "reservation.policy FORBID cannot list reservation_ids (the API rejects the combination)."
    }
    precondition {
      condition     = (var.autoscaling != null) != (var.fixed_node_count != null)
      error_message = "Set exactly one of fixed_node_count or autoscaling."
    }
    precondition {
      # docs kubernetes/node-groups/reservations: only regular (non-preemptible) GPU node groups can
      # use reservations; preemptible and CPU-only groups are rejected by the API. FORBID (no reservation) is allowed anywhere.
      condition     = var.reservation == null || try(var.reservation.policy, "") == "FORBID" || (local.is_gpu && !var.preemptible)
      error_message = "Reservations (STRICT or AUTO) apply only to regular GPU node groups: not to preemptible groups (reserved capacity is not spot capacity, ADR-0007) and not to CPU-only groups. Set reservation = null or { policy = \"FORBID\" } here."
    }
    precondition {
      condition     = !local.is_gpu || var.boot_disk_size_gib >= 256
      error_message = "GPU nodes need a boot disk of at least 256 GiB for driver images and model/container caches (upstream default 1023)."
    }
  }
}
