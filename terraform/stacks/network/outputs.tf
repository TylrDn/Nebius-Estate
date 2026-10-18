output "stage" {
  description = "Stage this root was planned for."
  value       = var.stage
}

output "network_id" {
  description = "VPC network ID."
  value       = nebius_vpc_v1_network.this.id
}

output "subnet_id" {
  description = "Workload subnet (no public addresses; egress through the NAT gateway). Pass to R1/R3 as subnet_id."
  value       = nebius_vpc_v1_subnet.workload.id
}

output "security_group_ids" {
  description = "Security groups for workload nodes. Pass to R1/R3 as security_group_ids."
  value       = [nebius_vpc_v1_security_group.this["workload"].id]
}

output "service_cidr" {
  description = "Kubernetes Service range size for clusters in subnet_id. Pass to R1/R3 as service_cidr: the API reserves it inside the subnet and its /16 default does not fit."
  value       = local.service_cidr
}

output "nat_private_ip" {
  description = "The default route's next hop (the NAT VM's private address); null without NAT."
  value       = var.enable_nat ? split("/", nebius_vpc_v1_allocation.nat[0].status.details.allocated_cidr)[0] : null
}

output "nat_public_ip" {
  description = "Egress address of the workload subnet (the NAT VM's reserved public IP) for external allowlists; null without NAT."
  value       = var.enable_nat ? split("/", nebius_vpc_v1_allocation.nat_public[0].status.details.allocated_cidr)[0] : null
}

output "bastion" {
  description = "WireGuard endpoint (host:port) and tunnel range; null without a bastion."
  value = var.enable_bastion ? {
    endpoint    = "${split("/", nebius_vpc_v1_allocation.bastion[0].status.details.allocated_cidr)[0]}:51820"
    tunnel_cidr = var.wireguard_cidr
  } : null
}
