# Plan-mode tests for the network perimeter (mocked provider, no spend).

mock_provider "nebius" {
  # Mock values are known at plan time, so outputs built from allocation status can be asserted.
  override_during = plan

  mock_resource "nebius_vpc_v1_network" {
    defaults = { id = "vpcnetwork-e00mock000000000" }
  }
  mock_resource "nebius_vpc_v1_subnet" {
    defaults = { id = "vpcsubnet-e00mock0000000000" }
  }
  mock_resource "nebius_vpc_v1_security_group" {
    defaults = { id = "vpcsecuritygroup-e00mock000" }
  }
  mock_resource "nebius_vpc_v1_route_table" {
    defaults = { id = "vpcroutetable-e00mock000000" }
  }
  mock_resource "nebius_vpc_v1_allocation" {
    defaults = { id = "vpcallocation-e00mock000000", status = { details = { allocated_cidr = "10.40.255.5/32" } } }
  }
}

variables {
  stage     = "sandbox"
  parent_id = "project-e00mock"
  region    = "eu-north1"
  labels = {
    "nip-env"         = "network"
    "nip-owner"       = "ci"
    "nip-run"         = "mock"
    "nip-ttl-expires" = timeadd(timestamp(), "24h") # inside the 7-day sandbox window
  }
}

run "workload_subnet_is_private_and_routes_through_nat" {
  command = plan

  assert {
    condition     = nebius_vpc_v1_subnet.workload.ipv4_private_pools.pools[0].cidrs[0].cidr == "10.40.0.0/17"
    error_message = "workload subnet takes the first half of the network range"
  }
  assert {
    condition     = nebius_vpc_v1_subnet.workload.ipv4_public_pools.use_network_pools == false
    error_message = "workload subnet must not be able to hold public addresses"
  }
  assert {
    condition     = nebius_vpc_v1_subnet.edge.ipv4_private_pools.pools[0].cidrs[0].cidr == "10.40.255.0/24"
    error_message = "edge subnet is the last /24"
  }
  assert {
    condition     = nebius_vpc_v1_subnet.edge.route_table_id == null
    error_message = "the NAT VM's subnet must not use the route table (routing loop)"
  }
  assert {
    condition     = nebius_vpc_v1_route.default[0].destination.cidr == "0.0.0.0/0"
    error_message = "default route"
  }
  assert {
    condition     = nebius_vpc_v1_network.this.name == "nip-sandbox-network" && nebius_compute_v1_instance.nat[0].boot_disk.managed_disk.name == "nip-sandbox-network-nat-boot" && nebius_vpc_v1_route_table.egress[0].name == "nip-sandbox-network-egress"
    error_message = "R7 names carry the stage (docs/naming.md): disk names are unique in the whole tenant"
  }
  assert {
    condition     = nebius_vpc_v1_route.default[0].name == "via-nat" && !startswith(nebius_vpc_v1_route.default[0].name, "default-")
    error_message = "our objects never start with Nebius's default- prefix"
  }
  assert {
    condition     = length(nebius_compute_v1_instance.nat) == 1 && length(nebius_compute_v1_instance.bastion) == 0
    error_message = "NAT on, bastion off by default"
  }
  assert {
    condition     = nebius_compute_v1_instance.nat[0].boot_disk.managed_disk.spec.source_image_family.image_family == "ubuntu24.04-driverless"
    error_message = "non-deprecated CPU image family"
  }
  assert {
    condition     = !strcontains(nebius_compute_v1_instance.nat[0].cloud_init_user_data, "package_update") && strcontains(nebius_compute_v1_instance.nat[0].cloud_init_user_data, "MASQUERADE")
    error_message = "the NAT gateway configures forwarding without depending on a package mirror"
  }
  assert {
    condition     = length(nebius_vpc_v1_allocation.nat_public) == 1 && nebius_compute_v1_instance.nat[0].network_interfaces[0].public_ip_address.allocation_id != null
    error_message = "the NAT egress IP is a reserved allocation, stable across VM replacement"
  }
  assert {
    condition     = output.service_cidr == "/20" && output.nat_private_ip == "10.40.255.5" && output.nat_public_ip == "10.40.255.5"
    error_message = "a /16 network hands R1/R3 a /20 Service range; outputs carry bare IPs, not CIDRs"
  }
}

run "security_groups_deny_ingress_ahead_of_the_default_group" {
  command = plan

  assert {
    condition     = alltrue([for r in nebius_vpc_v1_security_rule.ingress_deny : r.access == "DENY" && r.priority < 500])
    error_message = "the deny must beat the default group's ALLOW at priority 500"
  }
  assert {
    condition     = alltrue([for r in nebius_vpc_v1_security_rule.ingress_allow : r.priority < 400])
    error_message = "allows must come before the deny"
  }
  assert {
    condition     = alltrue([for r in nebius_vpc_v1_security_rule.egress_allow : r.type == "STATEFUL"])
    error_message = "egress allows are stateful so replies pass the ingress deny"
  }
  assert {
    condition     = nebius_vpc_v1_security_rule.ingress_allow["nat-from-workload"].ingress.source_cidrs == tolist(["10.40.0.0/17"])
    error_message = "the NAT VM accepts traffic from the workload subnet only"
  }
  assert {
    condition     = length(output.security_group_ids) == 1
    error_message = "one workload group for R1/R3"
  }
}

run "bastion_needs_allowed_cidrs_in_every_stage" {
  command = plan

  variables {
    enable_bastion = true
  }

  expect_failures = [terraform_data.stage_policy]
}

run "bastion_listens_only_to_allowed_cidrs" {
  command = plan

  variables {
    enable_bastion = true
    allowed_cidrs  = ["10.10.0.0/16"]
  }

  assert {
    condition     = nebius_vpc_v1_security_rule.ingress_allow["bastion-wireguard"].ingress.source_cidrs == tolist(["10.10.0.0/16"]) && nebius_vpc_v1_security_rule.ingress_allow["bastion-wireguard"].ingress.destination_ports == tolist([51820])
    error_message = "WireGuard port open to the allowlist only"
  }
  assert {
    condition     = length(nebius_vpc_v1_allocation.bastion) == 1 && nebius_vpc_v1_allocation.bastion[0].ipv4_public != null
    error_message = "bastion keeps a public allocation"
  }
  assert {
    condition     = output.bastion.endpoint == "10.40.255.5:51820"
    error_message = "the WireGuard endpoint is host:port"
  }
  assert {
    condition     = nebius_vpc_v1_security_rule.ingress_allow["nat-ssh-from-bastion"].ingress.destination_ports == tolist([22]) && nebius_vpc_v1_security_rule.ingress_allow["nat-ssh-from-bastion"].ingress.source_cidrs == null
    error_message = "the NAT VM takes SSH from the bastion's group only"
  }
}

run "rejects_a_tunnel_range_inside_the_network" {
  command = plan

  variables {
    wireguard_cidr = "10.40.200.0/24"
  }

  expect_failures = [var.wireguard_cidr]
}

run "small_network_gets_a_proportional_service_range" {
  command = plan

  variables {
    cidr = "10.50.0.0/18"
  }

  assert {
    condition     = output.service_cidr == "/22" && nebius_vpc_v1_subnet.edge.ipv4_private_pools.pools[0].cidrs[0].cidr == "10.50.63.0/24"
    error_message = "a /18 network: /22 Service range, edge is its last /24"
  }
}

run "prod_refuses_documentation_ranges_for_the_bastion" {
  command = plan

  variables {
    stage          = "prod"
    enable_bastion = true
    allowed_cidrs  = ["203.0.113.0/24"]
    labels         = { "nip-env" = "network", "nip-owner" = "ci", "nip-run" = "prod" }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "no_nat_means_no_route_table" {
  command = plan

  variables {
    enable_nat = false
  }

  assert {
    condition     = length(nebius_vpc_v1_route_table.egress) == 0 && nebius_vpc_v1_subnet.workload.route_table_id == null
    error_message = "without NAT there is no route table"
  }
}

run "rejects_public_or_docker_ranges" {
  command = plan

  variables {
    cidr = "8.8.0.0/16"
  }

  expect_failures = [var.cidr]
}

run "rejects_a_range_that_contains_the_docker_bridge" {
  command = plan

  variables {
    cidr = "172.16.0.0/12"
  }

  expect_failures = [var.cidr]
}

run "rejects_a_range_inside_the_docker_bridge" {
  command = plan

  variables {
    cidr = "172.17.128.0/17"
  }

  expect_failures = [var.cidr]
}

run "accepts_a_range_next_to_the_docker_bridge" {
  command = plan

  variables {
    cidr = "172.18.0.0/16"
  }

  assert {
    condition     = nebius_vpc_v1_subnet.workload.ipv4_private_pools.pools[0].cidrs[0].cidr == "172.18.0.0/17"
    error_message = "a range that only borders 172.17.0.0/16 is allowed"
  }
}

run "rejects_a_range_wider_than_its_rfc1918_block" {
  command = plan

  variables {
    cidr = "192.168.0.0/14"
  }

  expect_failures = [var.cidr]
}

run "bastion_refuses_the_two_slash_one_halves" {
  command = plan

  variables {
    enable_bastion = true
    allowed_cidrs  = ["0.0.0.0/1", "128.0.0.0/1"]
  }

  expect_failures = [var.allowed_cidrs]
}
