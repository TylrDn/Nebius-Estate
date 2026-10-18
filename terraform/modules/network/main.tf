# Nebius projects ship with a default VPC network and subnet; the upstream
# k8s-training recipe looks that subnet up rather than creating one. This
# module does the same, by ID when given, otherwise by name.

data "nebius_vpc_v1_subnet" "by_id" {
  count = var.subnet_id != null ? 1 : 0
  id    = var.subnet_id
}

data "nebius_vpc_v1_subnet" "by_name" {
  count     = var.subnet_id == null ? 1 : 0
  parent_id = var.parent_id
  name      = var.subnet_name

  lifecycle {
    precondition {
      condition     = var.subnet_name != null
      error_message = "set subnet_id (source scripts/bootstrap-backend.sh exports the project's default subnet as TF_VAR_subnet_id; with R7, the network stack's subnet_id output) or subnet_name."
    }
  }
}

# Only id and network_id are read: touching the whole object pulls in status.ipv4_private_cidrs,
# which the provider deprecates (supported until 2027-02-01).
locals {
  subnet_id  = var.subnet_id != null ? one(data.nebius_vpc_v1_subnet.by_id[*].id) : one(data.nebius_vpc_v1_subnet.by_name[*].id)
  network_id = var.subnet_id != null ? one(data.nebius_vpc_v1_subnet.by_id[*].network_id) : one(data.nebius_vpc_v1_subnet.by_name[*].network_id)
}
