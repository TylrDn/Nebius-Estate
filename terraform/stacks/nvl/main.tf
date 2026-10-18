# R15: rack-scale GB300 NVL72 on Managed Kubernetes through NVLink instance groups.
# Per rack: one nebius_compute_v1_nvl_instance_group (type GB300, size 18) and one fixed 18-node
# MK8s node group whose template joins it (template.nvlink.nvl_instance_group_id), on the
# gpu-gb300 platform's 4gpu-112vcpu-800gb preset: 18 x 4 = 72 GPUs in one NVLink domain.
# Mirrors nebius-solutions-library k8s-training/gb300.tf (main @ fba7148, 2026-10-09); the
# docs.nebius.com sources are the provider reference pages cited below and in README.md.
#
# Mocked only: capacity is not approved, so this stack is never planned against the real API.
# platform/stages.yaml caps max_gpu_nodes.nvl at 0 in every stage, and any rack also needs a
# capacity reservation (STRICT): a deliberate stage-policy change plus a reservation ID unlock it.

locals {
  name   = "nip-${var.stage}-nvl"
  labels = merge({ "nip-env" = "nvl" }, var.labels, { "nip-region" = var.region, "nip-stage" = var.stage, "nip-stack" = "nvl" })

  # Rack shape. Neither the VM types page nor the regions page lists GB300; platform and preset are
  # the ones a read-only compute/v1/platforms listing returned in eu-north1 on 2026-10-11 and the
  # upstream recipe uses (platform/regions.yaml header). 18 nodes per rack: upstream and the
  # rack-scale service level (docs/solutions/platforms.md).
  platform       = "gpu-gb300"
  preset         = "4gpu-112vcpu-800gb"
  nodes_per_rack = 18
  gpus_per_node  = 4
  drivers_preset = "cuda13.0" # the managed driver image; upstream's GB300 path supports no custom driver
  racks          = [for i in range(var.racks) : format("rack-%03d", i + 1)]

  # Node VMs carry the cost labels minus the per-run ones (same rule as R1/R3: changing
  # instance metadata labels recreates the nodes, https://docs.nebius.com/kubernetes/logs#how-to-enable-journald-logs).
  instance_metadata_labels = { for k, v in local.labels : k => v if !contains(["nip-run", "nip-ttl-expires"], k) }

  local_rules = {
    reservation = { ok = var.racks == 0 || length(var.capacity_reservation_ids) > 0, msg = "a GB300 rack runs on reserved capacity only: set capacity_reservation_ids (the approved capacity block groups; runbooks/nvl.md)" }
    cross_rack  = { ok = var.racks <= 1 || var.gpu_cluster_id != null, msg = "two or more racks need gpu_cluster_id for InfiniBand between racks; one rack may omit it" }
  }
  local_violations = [for r in values(local.local_rules) : r.msg if !r.ok]
}

module "stage_policy" {
  source = "../../modules/stage-policy"

  stage                       = var.stage
  ttl_expires                 = lookup(var.labels, "nip-ttl-expires", null)
  stack                       = "nvl"
  has_cluster                 = false
  has_public_endpoint_control = false
  k8s_version                 = var.k8s_version
  # Every rack node counts against max_gpu_nodes["nvl"] (0 in every stage today) and, with
  # require_strict_reservation.nvl, must run on a STRICT reservation.
  gpu_node_count         = var.racks * local.nodes_per_rack
  gpu_reservation_policy = "STRICT"
}

resource "terraform_data" "stage_policy" {
  lifecycle {
    precondition {
      condition     = length(module.stage_policy.violations) == 0
      error_message = "stage ${var.stage} policy (platform/stages.yaml): ${join("; ", module.stage_policy.violations)}."
    }
    precondition {
      condition     = length(local.local_violations) == 0
      error_message = "nvl: ${join("; ", local.local_violations)}."
    }
  }
}

# One NVLink domain per rack. `size` is the maximum number of instances in the group
# (https://docs.nebius.com/terraform-provider/reference/resources/compute_v1_nvl_instance_group#required);
# `type` names the platform family (GB200 or GB300).
resource "nebius_compute_v1_nvl_instance_group" "rack" {
  for_each = toset(local.racks)

  parent_id = var.parent_id
  name      = "${local.name}-${each.key}"
  type      = "GB300"
  size      = local.nodes_per_rack
  labels    = local.labels

  depends_on = [terraform_data.stage_policy]
}

resource "nebius_mk8s_v1_node_group" "rack" {
  for_each = toset(local.racks)

  parent_id = var.cluster_id
  name      = "${local.name}-ng-${each.key}"
  version   = var.k8s_version
  labels    = local.labels

  # Fixed size: the node count of a node group with NVLink cannot be changed
  # (https://docs.nebius.com/terraform-provider/reference/resources/mk8s_v1_node_group#optional).
  fixed_node_count = local.nodes_per_rack

  # Never surge: the NVLink group holds at most 18 VMs, so a 19th node created during a rolling
  # update has no place in it. Replace one node at a time instead (max_surge defaults to 1;
  # https://docs.nebius.com/terraform-provider/reference/resources/mk8s_v1_node_group#nested-schema-for-strategy).
  strategy = {
    max_surge       = { count = 0 }
    max_unavailable = { count = 1 }
  }

  template = {
    resources = {
      platform = local.platform
      preset   = local.preset
    }

    boot_disk = {
      size_gibibytes = var.boot_disk_size_gib
      type           = "NETWORK_SSD"
    }

    network_interfaces = [{ subnet_id = var.subnet_id }]

    service_account_id = var.node_service_account_id
    instance_metadata  = { labels = local.instance_metadata_labels }

    gpu_settings = { drivers_preset = local.drivers_preset }
    gpu_cluster  = var.gpu_cluster_id == null ? null : { id = var.gpu_cluster_id }

    # The node group joins the rack's NVLink instance group
    # (https://docs.nebius.com/terraform-provider/reference/resources/mk8s_v1_node_group#nested-schema-for-templatenvlink).
    nvlink = { nvl_instance_group_id = nebius_compute_v1_nvl_instance_group.rack[each.key].id }

    # STRICT: nodes come only from the listed reservations and the request fails without them
    # (https://docs.nebius.com/kubernetes/node-groups/reservations#how-to-add-reservations-to-node-groups).
    reservation_policy = {
      policy          = "STRICT"
      reservation_ids = var.capacity_reservation_ids
    }

    taints = [{ key = "nvidia.com/gpu", value = "present", effect = "NO_SCHEDULE" }]

    # Our labels only (docs/naming.md): Nebius sets topology.nebius.com/* (tier-0 for multi-node
    # NVLink) itself.
    metadata = {
      labels = {
        "nip.nebius.io/gpu"      = "true"
        "nip.nebius.io/nvl"      = "true"
        "nip.nebius.io/nvl-rack" = each.key
      }
    }
  }

  depends_on = [terraform_data.stage_policy]
}
