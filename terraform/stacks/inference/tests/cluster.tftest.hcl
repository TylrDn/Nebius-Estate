# Plan-mode tests with mocked providers: no credentials, no spend.
# Run: terraform -chdir=terraform/stacks/inference test

mock_provider "nebius" {
  mock_data "nebius_vpc_v1_subnet" {
    defaults = {
      id         = "vpcsubnet-e00mock0000000000"
      network_id = "vpcnetwork-e00mock000000000"
    }
  }
  mock_resource "nebius_mk8s_v1_cluster" {
    defaults = {
      id = "mk8scluster-e00mock000000000"
    }
  }
}
mock_provider "helm" {}
mock_provider "kubernetes" {}
mock_provider "kubectl" {}
mock_provider "units" {}
mock_provider "random" {}

variables {
  stage     = "sandbox"
  parent_id = "project-e00mock"
  region    = "eu-north1"
  subnet_id = "vpcsubnet-e00mock0000000000" # bootstrap-backend.sh exports the default subnet; subnet_name has no default
  labels = {
    "nip-env"         = "test"
    "nip-owner"       = "ci"
    "nip-run"         = "mock"
    "nip-ttl-expires" = timeadd(timestamp(), "24h") # inside the 7-day sandbox window
  }
}

run "default_cluster_name_carries_the_stage" {
  command = plan

  assert {
    condition     = module.cluster.name == "nip-sandbox-inference"
    error_message = "cluster name should default to nip-<stage>-inference (docs/naming.md)"
  }

  assert {
    condition     = output.cluster_name == "nip-sandbox-inference"
    error_message = "cluster_name output should expose the cluster name"
  }
}

run "explicit_cluster_name_wins" {
  command = plan

  variables {
    cluster_name = "nip-sandbox-inference-b"
  }

  assert {
    condition     = output.cluster_name == "nip-sandbox-inference-b"
    error_message = "an explicit cluster_name is used as given"
  }
}

run "rejects_a_cluster_name_outside_the_convention" {
  command = plan

  variables {
    cluster_name = "Nip_Lab"
  }

  expect_failures = [var.cluster_name]
}

run "network_needs_a_subnet_id_or_name" {
  command = plan

  module {
    source = "../../modules/network"
  }

  variables {
    parent_id = "project-e00mock"
    subnet_id = null
  }

  expect_failures = [data.nebius_vpc_v1_subnet.by_name]
}

run "network_lookup_by_name" {
  command = plan

  module {
    source = "../../modules/network"
  }

  variables {
    parent_id   = "project-e00mock"
    subnet_id   = null
    subnet_name = "default-subnet-e00mock"
  }

  assert {
    condition     = length(data.nebius_vpc_v1_subnet.by_name) == 1 && length(data.nebius_vpc_v1_subnet.by_id) == 0
    error_message = "the subnet should be looked up by name when subnet_id is null and subnet_name is set"
  }
}

run "network_lookup_by_id" {
  command = plan

  module {
    source = "../../modules/network"
  }

  variables {
    parent_id = "project-e00mock"
    subnet_id = "vpcsubnet-e00mock"
  }

  assert {
    condition     = length(data.nebius_vpc_v1_subnet.by_id) == 1 && length(data.nebius_vpc_v1_subnet.by_name) == 0
    error_message = "subnet should be looked up by id when subnet_id is set"
  }
}

run "cluster_public_endpoint_toggle" {
  command = plan

  module {
    source = "../../modules/mk8s-cluster"
  }

  variables {
    parent_id         = "project-e00mock"
    name              = "nip-sandbox-inference"
    subnet_id         = "vpcsubnet-e00mock"
    public_endpoint   = false
    etcd_cluster_size = 1
  }

  assert {
    condition     = nebius_mk8s_v1_cluster.this.control_plane.endpoints.public_endpoint == null
    error_message = "public endpoint must be null when public_endpoint = false"
  }

  assert {
    condition     = nebius_mk8s_v1_cluster.this.control_plane.etcd_cluster_size == 1
    error_message = "etcd size should pass through"
  }
}

run "rejects_non_project_parent" {
  command = plan

  variables {
    parent_id = "tenant-e00mock"
  }

  expect_failures = [var.parent_id]
}

run "rejects_bad_etcd_size" {
  command = plan

  variables {
    etcd_cluster_size = 2
  }

  expect_failures = [var.etcd_cluster_size]
}

run "r7_subnet_gets_its_service_range" {
  command = plan

  variables {
    subnet_id          = "vpcsubnet-e00mock0000000000"
    security_group_ids = ["vpcsecuritygroup-e00mock000"]
    service_cidr       = "/20"
  }

  assert {
    condition     = module.cluster.service_cidr == "/20"
    error_message = "the R7 Service range must reach the cluster (the /16 default does not fit its workload subnet)"
  }
}

run "default_subnet_keeps_the_api_service_range" {
  command = plan

  assert {
    condition     = module.cluster.service_cidr == null
    error_message = "without service_cidr the API default applies"
  }
}

run "rejects_a_service_range_outside_the_api_limits" {
  command = plan

  variables {
    service_cidr = "/30"
  }

  expect_failures = [var.service_cidr]
}
