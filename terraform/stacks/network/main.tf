# R7: private network perimeter (docs.nebius.com/vpc). A dedicated network with its own private
# pool; a workload subnet that cannot hold public addresses; an edge subnet for the NAT gateway
# and the optional WireGuard bastion; security groups; a route table sending 0.0.0.0/0 to the
# NAT VM's private allocation (docs: vpc/routing/custom-nat-gateway). R1 and R3 consume the
# outputs through their subnet_id, security_group_ids and service_cidr variables.

locals {
  # <prefix>-<stage>-<stack> (docs/naming.md): disk names are unique in the whole tenant.
  name   = coalesce(var.name, "nip-${var.stage}-network")
  labels = merge({ "nip-env" = "network" }, var.labels, { "nip-region" = var.region, "nip-stage" = var.stage, "nip-stack" = "network" })

  # Managed Kubernetes reserves one /24 per node for pods and the Service range inside the cluster
  # subnet (kubernetes/networking/requirements), so the workload subnet gets half the range and the
  # edge (NAT, bastion) only the last /24.
  prefix        = tonumber(split("/", var.cidr)[1])
  workload_cidr = cidrsubnet(var.cidr, 1, 0)
  edge_cidr     = cidrsubnet(var.cidr, 24 - local.prefix, pow(2, 24 - local.prefix) - 1)
  # The API default Service range is a /16, which never fits in the workload subnet; an eighth of it
  # (at most a /16) leaves the rest for node and pod allocations.
  service_cidr = "/${max(16, local.prefix + 4)}"

  admin_user = var.ssh_public_key == null ? "" : yamlencode({
    users = [{ name = "nip-admin", sudo = "ALL=(ALL) NOPASSWD:ALL", shell = "/bin/bash", ssh_authorized_keys = [var.ssh_public_key] }]
  })
}

module "stage_policy" {
  source = "../../modules/stage-policy"

  stage                       = var.stage
  ttl_expires                 = lookup(var.labels, "nip-ttl-expires", null)
  stack                       = "network"
  has_cluster                 = false
  has_public_endpoint_control = false
  allowed_cidrs               = var.allowed_cidrs
  public_bastion              = var.enable_bastion
}

resource "terraform_data" "stage_policy" {
  lifecycle {
    precondition {
      condition     = length(module.stage_policy.violations) == 0
      error_message = "stage ${var.stage} policy (platform/stages.yaml): ${join("; ", module.stage_policy.violations)}."
    }
  }
}

# ---- Network, pool, subnets --------------------------------------------------------------

resource "nebius_vpc_v1_pool" "private" {
  parent_id  = var.parent_id
  name       = "${local.name}-private"
  version    = "IPV4"
  visibility = "PRIVATE"
  cidrs      = [{ cidr = var.cidr }]
  labels     = local.labels
}

resource "nebius_vpc_v1_network" "this" {
  parent_id          = var.parent_id
  name               = local.name
  ipv4_private_pools = { pools = [{ id = nebius_vpc_v1_pool.private.id }] }
  labels             = local.labels
}

resource "nebius_vpc_v1_subnet" "workload" {
  parent_id          = var.parent_id
  name               = "${local.name}-workload"
  network_id         = nebius_vpc_v1_network.this.id
  ipv4_private_pools = { use_network_pools = false, pools = [{ cidrs = [{ cidr = local.workload_cidr }] }] }
  # No public pool: nothing in this subnet can hold a public address (vpc/addressing/disable-public-addresses).
  ipv4_public_pools = { use_network_pools = false }
  route_table_id    = var.enable_nat ? nebius_vpc_v1_route_table.egress[0].id : null
  labels            = local.labels
}

# The NAT VM's own subnet must NOT use the route table (routing loop, per the docs).
resource "nebius_vpc_v1_subnet" "edge" {
  parent_id          = var.parent_id
  name               = "${local.name}-edge"
  network_id         = nebius_vpc_v1_network.this.id
  ipv4_private_pools = { use_network_pools = false, pools = [{ cidrs = [{ cidr = local.edge_cidr }] }] }
  ipv4_public_pools  = { use_network_pools = true }
  labels             = local.labels
}

# ---- Security groups ---------------------------------------------------------------------
# Rules of every group on an interface are looked up by priority, first match wins, and no match
# denies (vpc/security-groups/overview). The network's default group (ALLOW all, priority 500)
# controls an interface that is in no group (vpc/security-groups/manage#adding-vms-to-security-groups);
# the docs do not say whether it also applies next to explicit groups, or for node groups, so each
# group also DENYs other ingress at 400, which holds either way. Egress ALLOW
# rules are STATEFUL, so replies come back through the ingress DENY. Managed Kubernetes adds its
# own system group per cluster for API server <-> kubelet traffic (kubernetes/networking/security-groups).

locals {
  groups = concat(["workload", "nat"], var.enable_bastion ? ["bastion"] : [])
  ingress_allow = merge(
    {
      # Nodes, pods, the control plane, the NAT VM and the bastion all sit inside var.cidr.
      workload-from-network = { group = "workload", protocol = "ANY", cidrs = [var.cidr], ports = null, from_group = null }
      nat-from-workload     = { group = "nat", protocol = "ANY", cidrs = [local.workload_cidr], ports = null, from_group = null }
    },
    var.enable_bastion ? {
      bastion-wireguard    = { group = "bastion", protocol = "UDP", cidrs = tolist(var.allowed_cidrs), ports = [51820], from_group = null }
      nat-ssh-from-bastion = { group = "nat", protocol = "TCP", cidrs = tolist([]), ports = [22], from_group = "bastion" }
    } : {},
  )
}

resource "nebius_vpc_v1_security_group" "this" {
  for_each   = toset(local.groups)
  parent_id  = var.parent_id
  name       = "${local.name}-${each.key}"
  network_id = nebius_vpc_v1_network.this.id
  labels     = merge(local.labels, { "nip-purpose" = each.key })
}

resource "nebius_vpc_v1_security_rule" "ingress_allow" {
  for_each  = local.ingress_allow
  parent_id = nebius_vpc_v1_security_group.this[each.value.group].id
  name      = each.key
  access    = "ALLOW"
  protocol  = each.value.protocol
  priority  = 100
  ingress = {
    source_cidrs             = length(each.value.cidrs) > 0 ? each.value.cidrs : null
    source_security_group_id = each.value.from_group == null ? null : nebius_vpc_v1_security_group.this[each.value.from_group].id
    destination_ports        = each.value.ports
  }
  labels = local.labels
}

resource "nebius_vpc_v1_security_rule" "ingress_deny" {
  for_each  = toset(local.groups)
  parent_id = nebius_vpc_v1_security_group.this[each.key].id
  name      = "${each.key}-deny-other-ingress"
  access    = "DENY"
  protocol  = "ANY"
  priority  = 400
  ingress   = { source_cidrs = ["0.0.0.0/0"] }
  labels    = local.labels
}

resource "nebius_vpc_v1_security_rule" "egress_allow" {
  for_each  = toset(local.groups)
  parent_id = nebius_vpc_v1_security_group.this[each.key].id
  name      = "${each.key}-egress"
  access    = "ALLOW"
  protocol  = "ANY"
  type      = "STATEFUL"
  priority  = 100
  egress    = { destination_cidrs = ["0.0.0.0/0"] }
  labels    = local.labels
}
