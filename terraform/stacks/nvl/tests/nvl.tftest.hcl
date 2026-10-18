# Plan-mode tests for the GB300 NVL72 stack (mocked provider, no spend, never the real API).
#
# The shared stage policy is overridden to "no violations" here so these runs pin the rack's shape
# although platform/stages.yaml caps max_gpu_nodes.nvl at 0 in every stage; policy.tftest.hcl runs
# the real module. The stack's own rules (a reservation for any rack, a GPU cluster between racks)
# are not part of the module and still apply.

mock_provider "nebius" {
  override_during = plan

  mock_resource "nebius_compute_v1_nvl_instance_group" {
    defaults = { id = "nvlinstancegroup-e00mock000" }
  }
  mock_resource "nebius_mk8s_v1_node_group" {
    defaults = { id = "mk8snodegroup-e00mock00000" }
  }
}

override_module {
  target  = module.stage_policy
  outputs = { violations = [] }
}

variables {
  stage      = "sandbox"
  parent_id  = "project-e00mock"
  region     = "eu-north1"
  cluster_id = "mk8scluster-e00mock0000000"
  subnet_id  = "vpcsubnet-e00mock0000000000"
  labels = {
    "nip-env"         = "nvl"
    "nip-owner"       = "ci"
    "nip-run"         = "mock"
    "nip-ttl-expires" = timeadd(timestamp(), "24h") # inside the 7-day sandbox window
  }
}

run "zero_racks_plan_nothing" {
  command = plan

  assert {
    condition     = length(nebius_compute_v1_nvl_instance_group.rack) == 0 && length(nebius_mk8s_v1_node_group.rack) == 0
    error_message = "racks = 0 (the default) creates no NVLink group and no node group"
  }
  assert {
    condition     = output.shape.gpus == 0 && output.shape.gpus_per_rack == 72 && length(output.racks) == 0
    error_message = "no GPUs planned; a rack is 72 GPUs"
  }
}

run "one_rack_is_one_nvlink_group_and_one_fixed_node_group" {
  command = plan

  variables {
    racks                    = 1
    capacity_reservation_ids = ["capacityblockgroup-e00mock"]
  }

  assert {
    condition     = nebius_compute_v1_nvl_instance_group.rack["rack-001"].type == "GB300" && nebius_compute_v1_nvl_instance_group.rack["rack-001"].size == 18
    error_message = "one GB300 NVLink instance group of 18 VMs per rack"
  }
  assert {
    condition     = nebius_compute_v1_nvl_instance_group.rack["rack-001"].name == "nip-sandbox-nvl-rack-001" && nebius_mk8s_v1_node_group.rack["rack-001"].name == "nip-sandbox-nvl-ng-rack-001"
    error_message = "names follow docs/naming.md: nip-<stage>-nvl-rack-<nnn>, node group nip-<stage>-nvl-ng-rack-<nnn>"
  }
  assert {
    condition     = nebius_mk8s_v1_node_group.rack["rack-001"].template.nvlink.nvl_instance_group_id == "nvlinstancegroup-e00mock000" && nebius_mk8s_v1_node_group.rack["rack-001"].parent_id == "mk8scluster-e00mock0000000"
    error_message = "the node group joins its rack's NVLink group, in the given cluster"
  }
  assert {
    condition     = nebius_mk8s_v1_node_group.rack["rack-001"].fixed_node_count == 18 && nebius_mk8s_v1_node_group.rack["rack-001"].autoscaling == null
    error_message = "fixed 18 nodes: an NVLink node group cannot be resized"
  }
  assert {
    condition     = nebius_mk8s_v1_node_group.rack["rack-001"].template.resources.platform == "gpu-gb300" && nebius_mk8s_v1_node_group.rack["rack-001"].template.resources.preset == "4gpu-112vcpu-800gb"
    error_message = "GB300 platform, 4-GPU preset"
  }
  assert {
    condition     = nebius_mk8s_v1_node_group.rack["rack-001"].strategy.max_surge.count == 0 && nebius_mk8s_v1_node_group.rack["rack-001"].strategy.max_unavailable.count == 1
    error_message = "no surge: a 19th node has no place in an 18-VM NVLink group"
  }
  assert {
    condition     = nebius_mk8s_v1_node_group.rack["rack-001"].template.reservation_policy.policy == "STRICT" && nebius_mk8s_v1_node_group.rack["rack-001"].template.reservation_policy.reservation_ids == tolist(["capacityblockgroup-e00mock"])
    error_message = "STRICT on the given reservation: never the common pool"
  }
  assert {
    condition     = nebius_mk8s_v1_node_group.rack["rack-001"].template.gpu_settings.drivers_preset == "cuda13.0" && nebius_mk8s_v1_node_group.rack["rack-001"].template.gpu_cluster == null
    error_message = "managed CUDA 13 driver image; one rack needs no GPU cluster"
  }
  assert {
    condition     = nebius_mk8s_v1_node_group.rack["rack-001"].template.metadata.labels["nip.nebius.io/nvl-rack"] == "rack-001" && nebius_mk8s_v1_node_group.rack["rack-001"].template.metadata.labels["nip.nebius.io/gpu"] == "true" && length([for k in keys(nebius_mk8s_v1_node_group.rack["rack-001"].template.metadata.labels) : k if startswith(k, "topology.nebius.com/") || startswith(k, "nebius.com/")]) == 0
    error_message = "our node labels only; Nebius's topology labels are never set by us"
  }
  assert {
    condition     = nebius_mk8s_v1_node_group.rack["rack-001"].template.taints[0].key == "nvidia.com/gpu" && nebius_mk8s_v1_node_group.rack["rack-001"].template.taints[0].effect == "NO_SCHEDULE"
    error_message = "GPU taint as on the other GPU node groups"
  }
  assert {
    condition     = nebius_mk8s_v1_node_group.rack["rack-001"].template.instance_metadata.labels["nip-stack"] == "nvl" && !contains(keys(nebius_mk8s_v1_node_group.rack["rack-001"].template.instance_metadata.labels), "nip-run") && !contains(keys(nebius_mk8s_v1_node_group.rack["rack-001"].template.instance_metadata.labels), "nip-ttl-expires")
    error_message = "node VMs carry the cost labels without the per-run ones (a new run must not recreate a rack)"
  }
  assert {
    condition     = nebius_compute_v1_nvl_instance_group.rack["rack-001"].labels["nip-stage"] == "sandbox" && nebius_compute_v1_nvl_instance_group.rack["rack-001"].labels["nip-stack"] == "nvl" && nebius_compute_v1_nvl_instance_group.rack["rack-001"].labels["nip-run"] == "mock"
    error_message = "stage, stack and run labels on every resource"
  }
  assert {
    condition     = output.shape.nodes == 18 && output.shape.gpus == 72 && output.racks["rack-001"].nvl_instance_group_id == "nvlinstancegroup-e00mock000"
    error_message = "one rack = 18 nodes = 72 GPUs"
  }
}

run "two_racks_share_a_gpu_cluster" {
  command = plan

  variables {
    racks                    = 2
    capacity_reservation_ids = ["capacityblockgroup-e00mock"]
    gpu_cluster_id           = "computegpucluster-e00mock"
  }

  assert {
    condition     = toset(keys(nebius_mk8s_v1_node_group.rack)) == toset(["rack-001", "rack-002"]) && length(nebius_compute_v1_nvl_instance_group.rack) == 2
    error_message = "stable, sequential rack keys; one NVLink group per rack"
  }
  assert {
    condition     = alltrue([for ng in values(nebius_mk8s_v1_node_group.rack) : ng.template.gpu_cluster.id == "computegpucluster-e00mock"])
    error_message = "every rack joins the same GPU cluster for InfiniBand between racks"
  }
  assert {
    condition     = output.shape.gpus == 144
    error_message = "two racks = 144 GPUs"
  }
}

run "a_rack_without_a_reservation_is_refused" {
  command = plan

  variables {
    racks = 1
  }

  expect_failures = [terraform_data.stage_policy]
}

run "two_racks_without_a_gpu_cluster_are_refused" {
  command = plan

  variables {
    racks                    = 2
    capacity_reservation_ids = ["capacityblockgroup-e00mock"]
  }

  expect_failures = [terraform_data.stage_policy]
}

run "a_fractional_rack_is_refused" {
  command = plan

  variables {
    racks = 1.5
  }

  expect_failures = [var.racks]
}

run "sandbox_needs_a_ttl" {
  command = plan

  variables {
    labels = { "nip-env" = "nvl", "nip-owner" = "ci", "nip-run" = "mock" }
  }

  expect_failures = [var.labels]
}
