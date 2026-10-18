mock_provider "nebius" {
  mock_data "nebius_vpc_v1_subnet" {
    defaults = { id = "vpcsubnet-e00mock0000000000", network_id = "vpcnetwork-e00mock000000000" }
  }
  mock_resource "nebius_mk8s_v1_cluster" {
    defaults = { id = "mk8scluster-e00mock000000000" }
  }
  mock_resource "nebius_compute_v1_filesystem" {
    defaults = { id = "computefilesystem-e00mock00" }
  }
  mock_resource "nebius_compute_v1_gpu_cluster" {
    defaults = { id = "gpucluster-e00mock0000000000" }
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

run "defaults_are_plan_only_with_ib_fabric_3" {
  command = plan

  assert {
    condition     = output.node_groups.gpu.count == 0
    error_message = "training env must default to zero GPU nodes (plan-only)"
  }
  assert {
    condition     = local.infiniband_fabric == "fabric-3" && local.gpu_preset == "8gpu-128vcpu-1600gb"
    error_message = "eu-north1 should default to fabric-3 with the 8-GPU H100 preset"
  }
  assert {
    condition     = output.node_groups.gpu.drivers == "cuda13.0" && length(module.device_plugin) == 1 && length(module.gpu_operator) == 0 && length(module.network_operator) == 0
    error_message = "training defaults to the managed driver image + device plugin; the operator path is opt-in (ADR-0003)"
  }
  assert {
    condition     = length(module.gpu_cluster) == 0
    error_message = "plan-only (gpu_node_count = 0) must not create a GPU cluster or hold its quota"
  }
  assert {
    condition     = output.cluster_name == "nip-sandbox-training" && module.filestore[0].name == "nip-sandbox-training-shared-fs"
    error_message = "cluster and filesystem names carry the stage; the filesystem role is shared-fs, as in inference (docs/naming.md)"
  }
  assert {
    condition     = local.instance_metadata_labels["nip-stack"] == "training" && !contains(keys(local.instance_metadata_labels), "nip-run") && !contains(keys(local.instance_metadata_labels), "nip-ttl-expires")
    error_message = "propagate_cost_labels defaults to true: node VMs carry the nip-* cost allocation labels, except the per-run nip-run / nip-ttl-expires (changing them would recreate every node)"
  }
}

run "operator_path_is_opt_in" {
  command = plan

  variables {
    enable_gpu_operator = true
  }

  assert {
    condition     = output.node_groups.gpu.drivers == "gpu-operator" && length(module.device_plugin) == 0 && length(module.network_operator) == 1 && length(module.gpu_operator) == 1 && length(terraform_data.ofed_ready) == 1
    error_message = "enable_gpu_operator switches to Network Operator -> OFED gate -> GPU Operator and drops the device plugin"
  }
}

run "two_nodes_for_nccl" {
  command = plan

  variables {
    gpu_node_count = 2
  }

  assert {
    condition     = output.node_groups.gpu.count == 2 && output.gpu_cluster.infiniband_fabric == "fabric-3" && length(module.gpu_cluster) == 1
    error_message = "two 8-GPU nodes in fabric-3, and the GPU cluster exists only now"
  }
}

run "gpu_cluster_rejects_single_gpu_preset" {
  command = plan

  variables {
    gpu_preset     = "1gpu-16vcpu-200gb"
    gpu_node_count = 1
  }

  expect_failures = [var.gpu_preset]
}

run "no_gpu_cluster_allows_single_gpu_preset" {
  command = plan

  variables {
    enable_gpu_cluster = false
    gpu_preset         = "1gpu-16vcpu-200gb"
    gpu_node_count     = 1
  }

  assert {
    condition     = output.gpu_cluster == null && local.infiniband_fabric == null
    error_message = "without a GPU cluster there is no fabric"
  }
}

run "sandbox_policy_rejects_five_nodes" {
  command = plan

  variables {
    gpu_node_count = 5
  }

  expect_failures = [terraform_data.stage_policy]
}

run "rejects_count_over_stack_cap" {
  command = plan

  variables {
    gpu_node_count = 33
  }

  expect_failures = [var.gpu_node_count]
}

run "h200_in_eu_north1_uses_fabric_7" {
  command = plan

  variables {
    gpu_platform = "gpu-h200-sxm"
  }

  assert {
    condition     = local.infiniband_fabric == "fabric-7"
    error_message = "H200 in eu-north1 must map to fabric-7, not the H100 default"
  }
}

run "platform_absent_from_region_is_rejected" {
  command = plan

  variables {
    gpu_platform = "gpu-b200-sxm" # offered in us-central1, not eu-north1
    gpu_preset   = "8gpu-160vcpu-1792gb"
  }

  expect_failures = [terraform_data.fabric_check]
}

run "uk_south1_defaults_to_b300_fabric" {
  command = plan

  variables {
    region = "uk-south1"
  }

  assert {
    condition     = local.gpu_platform == "gpu-b300-sxm" && local.gpu_preset == "8gpu-192vcpu-2768gb" && local.infiniband_fabric == "uk-south1-a"
    error_message = "uk-south1 should default to gpu-b300-sxm / 8gpu-192vcpu-2768gb in fabric uk-south1-a"
  }
}

run "b200_in_us_central1_uses_fabric_b" {
  command = plan

  variables {
    region       = "us-central1"
    gpu_platform = "gpu-b200-sxm"
  }

  assert {
    condition     = local.gpu_preset == "8gpu-160vcpu-1792gb" && local.infiniband_fabric == "us-central1-b"
    error_message = "B200 in us-central1 must map to us-central1-b, not the H200 default"
  }
}

run "b300_operator_path_pins_the_docs_driver" {
  command = plan

  variables {
    region              = "uk-south1"
    enable_gpu_operator = true
  }

  assert {
    condition     = module.gpu_operator[0].driver_version == "580.95.05"
    error_message = "B300 on the operator path must install driver 580.95.05 (docs/kubernetes/gpu/set-up)"
  }
}

run "platform_without_8gpu_preset_is_rejected" {
  command = plan

  variables {
    gpu_platform = "gpu-l40s-a" # listed for eu-north1, no 8-GPU preset
  }

  expect_failures = [terraform_data.fabric_check]
}

run "prod_caps_gpu_nodes_by_policy_and_requires_etcd_three" {
  command = plan

  variables {
    stage       = "prod"
    k8s_version = "1.35"
    labels      = { "nip-env" = "training", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  assert {
    condition     = local.etcd_cluster_size == 3 && local.public_endpoint == false && module.stage_policy.policy.max_gpu_nodes.training == 32
    error_message = "prod policy for training: etcd 3, private endpoint, 32-node cap"
  }
}

run "sandbox_policy_caps_training_at_four" {
  command = plan

  variables {
    gpu_node_count = 4
  }

  assert {
    condition     = output.node_groups.gpu.count == 4
    error_message = "four nodes is the sandbox ceiling and must plan"
  }
}

run "rejects_eol_k8s_version" {
  command = plan

  variables {
    k8s_version = "1.33"
  }

  expect_failures = [var.k8s_version]
}

# ---- Stage-governed flags (ADR-0009) ----

run "prod_training_gpu_nodes_need_strict_reservation" {
  command = plan

  variables {
    stage          = "prod"
    k8s_version    = "1.35"
    gpu_node_count = 2
    labels         = { "nip-env" = "training", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "prod_training_with_strict_reservation_plans" {
  command = plan

  variables {
    stage           = "prod"
    k8s_version     = "1.35"
    gpu_node_count  = 2
    gpu_reservation = { policy = "STRICT", reservation_ids = ["reservation-e00mock"] }
    labels          = { "nip-env" = "training", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  assert {
    condition     = module.gpu_nodes[0].reservation_policy.policy == "STRICT" && module.gpu_nodes[0].reservation_policy.reservation_ids[0] == "reservation-e00mock"
    error_message = "the STRICT reservation must reach the GPU node group template"
  }
  assert {
    condition     = module.gpu_nodes[0].preemptible == false
    error_message = "reserved capacity is never preemptible"
  }
}


run "sandbox_training_runs_on_demand_without_reservation" {
  command = plan

  variables {
    gpu_node_count = 2
  }

  assert {
    # null in the API means AUTO (any matching capacity block group); the stack pins FORBID instead.
    condition     = module.gpu_nodes[0].reservation_policy.policy == "FORBID" && module.gpu_nodes[0].reservation_policy.reservation_ids == null
    error_message = "without gpu_reservation a regular GPU group must run on the common pool (FORBID), never the API default AUTO"
  }
}

run "staging_refuses_newest_k8s_version" {
  command = plan

  variables {
    stage       = "staging"
    k8s_version = "1.36" # offset 1: staging runs at most 1.35
    labels      = { "nip-env" = "training", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "prod_rejects_audit_logs_off" {
  command = plan

  variables {
    stage       = "prod"
    k8s_version = "1.35"
    labels      = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
    audit_logs  = false
  }

  expect_failures = [terraform_data.stage_policy]
}

run "prod_rejects_forbid_deletion_off" {
  command = plan

  variables {
    stage                     = "prod"
    k8s_version               = "1.35"
    labels                    = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
    filestore_forbid_deletion = false
  }

  expect_failures = [terraform_data.stage_policy]
}

run "prod_rejects_alertmanager_off" {
  command = plan

  variables {
    stage                = "prod"
    k8s_version          = "1.35"
    labels               = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
    alertmanager_enabled = false
  }

  expect_failures = [terraform_data.stage_policy]
}

run "prod_rejects_o11y_off" {
  command = plan

  variables {
    stage       = "prod"
    k8s_version = "1.35"
    labels      = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
    enable_o11y = false
  }

  expect_failures = [terraform_data.stage_policy]
}

run "zero_gpus_create_no_gpu_node_group" {
  command = plan

  assert {
    condition     = length(module.gpu_nodes) == 0
    error_message = "plan-only (gpu_node_count = 0) must not create a GPU node group (R3-8)"
  }
}

# The CPU group is outside the GPU caps (modules/stage-policy), so it must never carry GPUs.
run "cpu_group_refuses_a_gpu_platform" {
  command = plan

  variables {
    cpu_platform = "gpu-h100-sxm"
  }

  expect_failures = [var.cpu_platform]
}

run "cpu_group_refuses_a_gpu_preset" {
  command = plan

  variables {
    cpu_preset = "8gpu-128vcpu-1600gb"
  }

  expect_failures = [var.cpu_preset]
}

run "cpu_node_count_is_bounded" {
  command = plan

  variables {
    cpu_node_count = 17
  }

  expect_failures = [var.cpu_node_count]
}

run "cpu_node_count_rejects_negative_and_fractional" {
  command = plan

  variables {
    cpu_node_count = 1.5
  }

  expect_failures = [var.cpu_node_count]
}

run "staging_refuses_an_internet_wide_allowlist" {
  command = plan

  variables {
    stage         = "staging"
    k8s_version   = "1.35"
    allowed_cidrs = ["0.0.0.0/0"]
    labels        = { "nip-env" = "training", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "prod_refuses_a_public_endpoint_even_with_an_allowlist" {
  command = plan

  variables {
    stage           = "prod"
    k8s_version     = "1.35"
    public_endpoint = true
    allowed_cidrs   = ["10.10.0.0/16"]
    labels          = { "nip-env" = "training", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  expect_failures = [terraform_data.stage_policy]
}
