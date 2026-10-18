# ---- Custom NAT gateway (docs: vpc/routing/custom-nat-gateway) ----------------------------
# The docs configure forwarding and MASQUERADE over SSH after boot; here cloud-init does the same
# steps on every boot so the gateway is reproducible. The route's next hop is the VM's PRIVATE
# allocation: if that allocation is not attached to a running VM, matching egress is discarded
# (vpc/routing/overview). The public address is a reserved allocation, so the egress IP that
# external allowlists (model hubs, the customer's own buckets) see survives a VM replacement.

resource "nebius_vpc_v1_allocation" "nat" {
  count        = var.enable_nat ? 1 : 0
  parent_id    = var.parent_id
  name         = "${local.name}-nat"
  ipv4_private = { subnet_id = nebius_vpc_v1_subnet.edge.id }
  labels       = local.labels
}

resource "nebius_vpc_v1_allocation" "nat_public" {
  count       = var.enable_nat ? 1 : 0
  parent_id   = var.parent_id
  name        = "${local.name}-nat-public"
  ipv4_public = { subnet_id = nebius_vpc_v1_subnet.edge.id }
  labels      = local.labels
}

resource "nebius_compute_v1_instance" "nat" {
  count     = var.enable_nat ? 1 : 0
  parent_id = var.parent_id
  name      = "${local.name}-nat"
  resources = { platform = var.vm_platform, preset = var.vm_preset }
  boot_disk = {
    attach_mode = "READ_WRITE"
    managed_disk = {
      name = "${local.name}-nat-boot"
      spec = { type = "NETWORK_SSD", size_gibibytes = 50, source_image_family = { image_family = var.image_family } }
    }
  }
  network_interfaces = [{
    name              = "eth0"
    subnet_id         = nebius_vpc_v1_subnet.edge.id
    ip_address        = { allocation_id = nebius_vpc_v1_allocation.nat[0].id }
    public_ip_address = { allocation_id = nebius_vpc_v1_allocation.nat_public[0].id }
    security_groups   = [{ id = nebius_vpc_v1_security_group.this["nat"].id }]
  }]
  cloud_init_user_data = templatefile("${path.module}/cloud-init/nat.yaml.tftpl", { admin_user = local.admin_user })
  labels               = local.labels
}

resource "nebius_vpc_v1_route_table" "egress" {
  count      = var.enable_nat ? 1 : 0
  parent_id  = var.parent_id
  name       = "${local.name}-egress"
  network_id = nebius_vpc_v1_network.this.id
  labels     = local.labels
}

resource "nebius_vpc_v1_route" "default" {
  count       = var.enable_nat ? 1 : 0
  parent_id   = nebius_vpc_v1_route_table.egress[0].id
  name        = "via-nat"
  destination = { cidr = "0.0.0.0/0" }
  next_hop    = { allocation = { id = nebius_vpc_v1_allocation.nat[0].id } }
  labels      = local.labels
}

# ---- WireGuard bastion (mirrors nebius-solutions-library wireguard/, minus the web UI) -----

resource "nebius_vpc_v1_allocation" "bastion" {
  count       = var.enable_bastion ? 1 : 0
  parent_id   = var.parent_id
  name        = "${local.name}-bastion"
  ipv4_public = { subnet_id = nebius_vpc_v1_subnet.edge.id }
  labels      = local.labels
}

resource "nebius_compute_v1_instance" "bastion" {
  count     = var.enable_bastion ? 1 : 0
  parent_id = var.parent_id
  name      = "${local.name}-bastion"
  resources = { platform = var.vm_platform, preset = var.vm_preset }
  boot_disk = {
    attach_mode = "READ_WRITE"
    managed_disk = {
      name = "${local.name}-bastion-boot"
      spec = { type = "NETWORK_SSD", size_gibibytes = 50, source_image_family = { image_family = var.image_family } }
    }
  }
  network_interfaces = [{
    name              = "eth0"
    subnet_id         = nebius_vpc_v1_subnet.edge.id
    ip_address        = {}
    public_ip_address = { allocation_id = nebius_vpc_v1_allocation.bastion[0].id }
    security_groups   = [{ id = nebius_vpc_v1_security_group.this["bastion"].id }]
  }]
  cloud_init_user_data = templatefile("${path.module}/cloud-init/wireguard.yaml.tftpl", {
    admin_user     = local.admin_user
    tunnel_address = "${cidrhost(var.wireguard_cidr, 1)}/${split("/", var.wireguard_cidr)[1]}"
  })
  labels = local.labels
}
