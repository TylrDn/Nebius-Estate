variable "stage" {
  description = "Lifecycle stage this root belongs to (platform/stages.yaml): sandbox, staging or prod. Selects the policy the stack enforces at plan time (ADR-0009)."
  type        = string

  validation {
    condition     = contains(keys(yamldecode(file("${path.module}/../../../platform/stages.yaml")).stages), var.stage)
    error_message = "stage must be one of the stages in platform/stages.yaml (sandbox, staging, prod)."
  }
}

variable "parent_id" {
  description = "Nebius project ID that owns the network (project-...)."
  type        = string

  validation {
    condition     = startswith(var.parent_id, "project-")
    error_message = "parent_id must be a Nebius project ID (project-...)."
  }
}

variable "region" {
  description = "Nebius region (platform/regions.yaml)."
  type        = string
  default     = "eu-north1"

  validation {
    condition     = contains(keys(yamldecode(file("${path.module}/../../../platform/regions.yaml")).regions), var.region)
    error_message = "region is not in platform/regions.yaml."
  }
}

variable "name" {
  description = "Name prefix for the network, subnets, security groups and VMs (docs/naming.md). null = nip-<stage>-network, so two stages in one tenant never clash on the tenant-unique boot disk names. Names are fixed at creation: changing this replaces every object."
  type        = string
  default     = null

  validation {
    condition     = var.name == null || can(regex("^[a-z][a-z0-9-]{0,39}$", var.name))
    error_message = "name must be lowercase letters, digits and hyphens, starting with a letter, at most 40 characters."
  }
}

variable "cidr" {
  description = "Private range of the network's own pool (RFC 1918, /12 to /18). The workload subnet takes the first half; the edge subnet (NAT, bastion) the last /24."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition = can(cidrhost(var.cidr, 0)) && tonumber(split("/", var.cidr)[1]) >= 12 && tonumber(split("/", var.cidr)[1]) <= 18 && anytrue([
      for r in ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] :
      tonumber(split("/", var.cidr)[1]) >= tonumber(split("/", r)[1]) && cidrhost(r, 0) == cidrhost("${cidrhost(var.cidr, 0)}/${split("/", r)[1]}", 0)
    ]) && cidrhost("${cidrhost(var.cidr, 0)}/${min(16, tonumber(split("/", var.cidr)[1]))}", 0) != cidrhost("172.17.0.0/${min(16, tonumber(split("/", var.cidr)[1]))}", 0)
    error_message = "cidr must be an RFC 1918 range between /12 and /18 that does not overlap 172.17.0.0/16 (Docker's default bridge; docs: vpc/addressing/custom-private-addresses)."
  }
}

variable "enable_nat" {
  description = "Custom NAT gateway VM with a reserved public IP + route table (0.0.0.0/0 via its private allocation) for the workload subnet. Without it the workload subnet has no internet egress at all, so nodes cannot pull images."
  type        = bool
  default     = true
}

variable "enable_bastion" {
  description = "WireGuard bastion VM with a public allocation in the edge subnet. Requires allowed_cidrs in every stage (the only sources that may reach UDP 51820)."
  type        = bool
  default     = false
}

variable "vm_platform" {
  description = "CPU platform for the NAT and bastion VMs."
  type        = string
  default     = "cpu-d3"
}

variable "vm_preset" {
  description = "Preset for the NAT and bastion VMs. NAT throughput scales with vCPUs; size it for the egress you expect (image pulls, dataset downloads)."
  type        = string
  default     = "4vcpu-16gb"
}

variable "image_family" {
  description = "Boot image family for the NAT and bastion VMs (ubuntu22.04-* families are deprecated)."
  type        = string
  default     = "ubuntu24.04-driverless"
}

variable "ssh_public_key" {
  description = "Public key for the admin user on the NAT and bastion VMs (null = no SSH user; the VMs still work)."
  type        = string
  default     = null
}

variable "wireguard_cidr" {
  description = "Tunnel range for WireGuard peers; must not overlap cidr. Client traffic is masqueraded to the bastion's private address."
  type        = string
  default     = "10.99.0.0/24"

  validation {
    # Two blocks overlap when either one's network address falls inside the other.
    condition = can(cidrhost(var.wireguard_cidr, 1)) && !(
      cidrhost("${cidrhost(var.wireguard_cidr, 0)}/${split("/", var.cidr)[1]}", 0) == cidrhost(var.cidr, 0) ||
      cidrhost("${cidrhost(var.cidr, 0)}/${split("/", var.wireguard_cidr)[1]}", 0) == cidrhost(var.wireguard_cidr, 0)
    )
    error_message = "wireguard_cidr must be a CIDR block that does not overlap cidr."
  }
}

variable "allowed_cidrs" {
  description = "Office/VPN egress CIDRs allowed to reach the bastion (UDP 51820), max 8. Pass with TF_VAR_allowed_cidrs; documentation ranges are refused."
  type        = list(string)
  default     = []

  validation {
    # /8 or narrower: 0.0.0.0/0, or the two /1 halves, would open the port to the internet.
    condition     = length(var.allowed_cidrs) <= 8 && alltrue([for c in var.allowed_cidrs : can(cidrhost(c, 0)) && try(tonumber(split("/", c)[1]) >= 8, false)])
    error_message = "allowed_cidrs takes at most 8 CIDR blocks (one security rule), each /8 or narrower (never 0.0.0.0/0 or its /1 halves)."
  }
}

variable "labels" {
  description = "Labels applied to every resource (docs/cost.md). nip-run is required; nip-ttl-expires where the stage requires it; nip-region, nip-stage and nip-stack are added automatically (nip-env, deprecated, defaults to the stack)."
  type        = map(string)
  default = {
    "nip-env"   = "network"
    "nip-owner" = "platform"
  }

  validation {
    condition     = try(length(var.labels["nip-run"]) > 0, false)
    error_message = "labels must carry nip-run (a ticket, date or run id) so leftovers can be attributed (docs/cost.md)."
  }
  validation {
    condition     = !yamldecode(file("${path.module}/../../../platform/stages.yaml")).stages[var.stage].policy.require_ttl_label || (can(regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$", lookup(var.labels, "nip-ttl-expires", ""))) && can(formatdate("YYYY", lookup(var.labels, "nip-ttl-expires", ""))))
    error_message = "this stage requires labels[\"nip-ttl-expires\"] as an RFC 3339 UTC timestamp, e.g. 2026-10-31T18:00:00Z (docs/cost.md)."
  }
}
