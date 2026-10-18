# R10: GPU VM quickstart (docs: compute/quickstart-host-model, compute/virtual-machines/containers).
# One GPU VM with a VM-managed boot disk from the platform's GPU image family; cloud-init runs vLLM's
# OpenAI-compatible server in a container pinned by digest (platform/versions.yaml). The API listens
# on 127.0.0.1 unless expose_api; a public address only behind allowed_cidrs. Attaches R7's subnet
# and security groups and R8's shared filesystem when given.

locals {
  regions  = yamldecode(file("${path.module}/../../../platform/regions.yaml")).regions
  versions = yamldecode(file("${path.module}/../../../platform/versions.yaml"))

  name     = coalesce(var.name, "nip-${var.stage}-gpu-vm")
  labels   = merge({ "nip-env" = "gpu-vm" }, var.labels, { "nip-region" = var.region, "nip-stage" = var.stage, "nip-stack" = "gpu-vm" })
  platform = coalesce(var.platform, local.regions[var.region].default)
  # null when the platform is not offered in the region; the precondition below names the choices.
  platform_spec = lookup(local.regions[var.region].platforms, local.platform, null)
  preset        = coalesce(var.preset, try(local.platform_spec.single_gpu_preset, "1gpu-0vcpu-0gb"))
  gpus          = tonumber(regex("^([0-9]+)gpu-", local.preset)[0])

  # Driver preset -> stable image family that carries it (compute/storage/boot-disk-images#gpu-drivers-and-other-components).
  family_for_drivers = { "cuda13.0" = "ubuntu24.04-cuda13.0", "cuda12.8" = "ubuntu24.04-cuda12" }
  image_family       = coalesce(var.image_family, lookup(local.family_for_drivers, try(local.platform_spec.drivers_preset, "cuda13.0"), "ubuntu24.04-cuda13.0"))
  # Recommended + alternative images per platform (compute/storage/boot-disk-images#images-for-gpu-vms).
  # Blackwell platforms have no CUDA 12 image; L40S has no "latest" one.
  blackwell_images = ["ubuntu24.04-cuda13.0", "ubuntu24.04-cuda13-latest"]
  hopper_images    = ["ubuntu24.04-cuda13.0", "ubuntu24.04-cuda12", "ubuntu24.04-cuda13-latest"]
  l40s_images      = ["ubuntu24.04-cuda13.0", "ubuntu24.04-cuda12"]
  compatible_images = {
    "gpu-b300-sxm"   = local.blackwell_images
    "gpu-b200-sxm"   = local.blackwell_images
    "gpu-b200-sxm-a" = local.blackwell_images
    "gpu-rtx6000"    = local.blackwell_images
    "gpu-rtx6000-a"  = local.blackwell_images
    "gpu-h200-sxm"   = local.hopper_images
    "gpu-h100-sxm"   = local.hopper_images
    "gpu-l40s-a"     = local.l40s_images
    "gpu-l40s-d"     = local.l40s_images
  }

  vllm_image     = local.versions.workloads.vllm.value
  model_repo     = trimprefix(local.versions.workloads[var.model].source, "https://huggingface.co/")
  model_revision = local.versions.workloads[var.model].version
  mount_tag      = "nip-fs"
  vllm_args = concat(
    [local.model_repo, "--revision", local.model_revision, "--port", tostring(var.api_port), "--tensor-parallel-size", tostring(local.gpus)],
    var.vllm_extra_args,
  )
  # Each argument single-quoted for the start script's shell.
  vllm_args_shell = join(" ", [for a in local.vllm_args : "'${replace(a, "'", "'\\''")}'"])

  admin_user = yamlencode({
    users = [{ name = var.admin_user, sudo = "ALL=(ALL) NOPASSWD:ALL", shell = "/bin/bash", ssh_authorized_keys = [var.ssh_public_key] }]
  })

  # Exposure rules that are this stack's own; the shared ones come from modules/stage-policy.
  local_rules = {
    public_allowlist = { ok = !var.public_ip || length(var.allowed_cidrs) > 0, msg = "a public address needs allowed_cidrs in every stage: SSH and the API are never open to the internet" }
    spot_policy      = { ok = var.preemptible || var.spot_pricing_policy_id == null, msg = "spot_pricing_policy_id applies to preemptible VMs only; set preemptible = true or drop it" }
  }
  local_violations = [for r in values(local.local_rules) : r.msg if !r.ok]
}

module "stage_policy" {
  source = "../../modules/stage-policy"

  stage                       = var.stage
  ttl_expires                 = lookup(var.labels, "nip-ttl-expires", null)
  stack                       = "gpu-vm"
  has_cluster                 = false
  has_public_endpoint_control = false
  allowed_cidrs               = var.allowed_cidrs
  # One VM, counted against max_gpu_nodes["gpu-vm"] (0 when the stage does not list the stack).
  gpu_node_count  = 1
  gpu_preemptible = var.preemptible
}

resource "terraform_data" "stage_policy" {
  lifecycle {
    precondition {
      condition     = length(module.stage_policy.violations) == 0
      error_message = "stage ${var.stage} policy (platform/stages.yaml): ${join("; ", module.stage_policy.violations)}."
    }
    precondition {
      condition     = length(local.local_violations) == 0
      error_message = "gpu-vm: ${join("; ", local.local_violations)}."
    }
  }
}

# ---- Allowlisted access for a public address -----------------------------------------------
# Same shape as R7's groups (vpc/security-groups/overview): ALLOW at 100, DENY other ingress at 400
# (ahead of the network's default group, which allows everything at 500), stateful egress.

data "nebius_vpc_v1_subnet" "this" {
  count = var.public_ip ? 1 : 0
  id    = var.subnet_id
}

locals {
  access_ports = concat([22], var.expose_api ? [var.api_port] : [])
}

resource "nebius_vpc_v1_security_group" "access" {
  count      = var.public_ip ? 1 : 0
  parent_id  = var.parent_id
  name       = "${local.name}-access"
  network_id = data.nebius_vpc_v1_subnet.this[0].network_id
  labels     = merge(local.labels, { "nip-purpose" = "gpu-vm-access" })
}

resource "nebius_vpc_v1_security_rule" "access_allow" {
  count     = var.public_ip ? 1 : 0
  parent_id = nebius_vpc_v1_security_group.access[0].id
  name      = "allowlist"
  access    = "ALLOW"
  protocol  = "TCP"
  priority  = 100
  ingress = {
    source_cidrs      = var.allowed_cidrs
    destination_ports = local.access_ports
  }
  labels = local.labels
}

resource "nebius_vpc_v1_security_rule" "access_deny" {
  count     = var.public_ip ? 1 : 0
  parent_id = nebius_vpc_v1_security_group.access[0].id
  name      = "deny-other-ingress"
  access    = "DENY"
  protocol  = "ANY"
  priority  = 400
  ingress   = { source_cidrs = ["0.0.0.0/0"] }
  labels    = local.labels
}

resource "nebius_vpc_v1_security_rule" "access_egress" {
  count     = var.public_ip ? 1 : 0
  parent_id = nebius_vpc_v1_security_group.access[0].id
  name      = "egress"
  access    = "ALLOW"
  protocol  = "ANY"
  type      = "STATEFUL"
  priority  = 100
  egress    = { destination_cidrs = ["0.0.0.0/0"] }
  labels    = local.labels
}

# ---- Addresses ----------------------------------------------------------------------------
# Allocations keep the addresses across a VM replacement, so tunnels, allowlists on the far side
# and ~/.ssh/known_hosts entries stay valid (vpc/overview#allocation). A public allocation is
# reserved until it is deleted, unlike a dynamic address, which a preempted (stopped) VM loses
# (compute/virtual-machines/network#public-ip-addresses).

resource "nebius_vpc_v1_allocation" "private" {
  parent_id    = var.parent_id
  name         = local.name
  ipv4_private = { subnet_id = var.subnet_id }
  labels       = local.labels
}

resource "nebius_vpc_v1_allocation" "public" {
  count       = var.public_ip ? 1 : 0
  parent_id   = var.parent_id
  name        = "${local.name}-public"
  ipv4_public = { subnet_id = var.subnet_id }
  labels      = local.labels
}

# ---- The VM --------------------------------------------------------------------------------

resource "nebius_compute_v1_instance" "this" {
  parent_id = var.parent_id
  name      = local.name
  resources = { platform = local.platform, preset = local.preset }

  boot_disk = {
    attach_mode = "READ_WRITE"
    managed_disk = {
      name   = "${local.name}-boot"
      labels = local.labels
      spec = {
        type                = "NETWORK_SSD"
        size_gibibytes      = var.boot_disk_size_gib
        block_size_bytes    = 4096
        source_image_family = { image_family = local.image_family }
      }
    }
  }

  filesystems = var.existing_filesystem_id == null ? null : [{
    existing_filesystem = { id = var.existing_filesystem_id }
    attach_mode         = "READ_WRITE"
    mount_tag           = local.mount_tag
  }]

  network_interfaces = [{
    name              = "eth0"
    subnet_id         = var.subnet_id
    ip_address        = { allocation_id = nebius_vpc_v1_allocation.private.id }
    public_ip_address = var.public_ip ? { allocation_id = nebius_vpc_v1_allocation.public[0].id } : null
    security_groups = length(var.security_group_ids) + (var.public_ip ? 1 : 0) == 0 ? null : concat(
      [for id in var.security_group_ids : { id = id }],
      var.public_ip ? [{ id = nebius_vpc_v1_security_group.access[0].id }] : [],
    )
  }]

  # Preemptible VMs support only recovery_policy FAIL and on_preemption STOP
  # (compute/virtual-machines/preemptible#how-to-create-a-preemptible-vm).
  recovery_policy     = var.preemptible ? "FAIL" : null
  preemptible         = var.preemptible ? { on_preemption = "STOP" } : null
  follows_spot_price  = var.preemptible && var.spot_pricing_policy_id == null ? {} : null
  spot_pricing_policy = var.preemptible && var.spot_pricing_policy_id != null ? { id = var.spot_pricing_policy_id } : null

  cloud_init_user_data = templatefile("${path.module}/cloud-init/vllm.yaml.tftpl", {
    admin_user = local.admin_user
    image      = local.vllm_image
    bind       = var.expose_api ? "" : "127.0.0.1:"
    port       = var.api_port
    cache_dir  = var.existing_filesystem_id == null ? "/var/lib/vllm/cache" : "/mnt/fs/vllm-cache"
    args       = local.vllm_args_shell
    mount      = var.existing_filesystem_id != null
    mount_tag  = local.mount_tag
  })

  labels = local.labels

  lifecycle {
    precondition {
      condition     = local.platform_spec != null
      error_message = "platform ${local.platform} is not offered in ${var.region} (platform/regions.yaml): one of ${join(", ", keys(local.regions[var.region].platforms))}."
    }
    precondition {
      condition     = contains(lookup(local.compatible_images, local.platform, []), local.image_family)
      error_message = "image family ${local.image_family} is not listed for ${local.platform} (compute/storage/boot-disk-images#images-for-gpu-vms): use one of ${join(", ", lookup(local.compatible_images, local.platform, []))}."
    }
  }
}
