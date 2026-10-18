# Plan-mode tests for the full lab root (mocked providers, no spend).

mock_provider "nebius" {
  mock_data "nebius_vpc_v1_subnet" {
    defaults = {
      id         = "vpcsubnet-e00mock0000000000"
      network_id = "vpcnetwork-e00mock000000000"
    }
  }
  mock_resource "nebius_mk8s_v1_cluster" {
    defaults = { id = "mk8scluster-e00mock000000000" }
  }
  mock_resource "nebius_compute_v1_filesystem" {
    defaults = { id = "computefilesystem-e00mock00" }
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
  subnet_id = "vpcsubnet-e00mock0000000000"
  labels = {
    "nip-env"         = "test"
    "nip-owner"       = "ci"
    "nip-run"         = "mock"
    "nip-ttl-expires" = timeadd(timestamp(), "24h") # inside the 7-day sandbox window
  }
}

run "defaults_use_driver_image_and_single_gpu" {
  command = plan

  assert {
    condition     = module.gpu_nodes[0].name == "nip-sandbox-inference-ng-gpu" && module.filestore[0].name == "nip-sandbox-inference-shared-fs"
    error_message = "node group and filesystem names derive from the stage-qualified cluster name (docs/naming.md)"
  }
  assert {
    condition     = local.instance_metadata_labels["nip-stack"] == "inference" && local.instance_metadata_labels["nip-stage"] == "sandbox" && !contains(keys(local.instance_metadata_labels), "nip-run") && !contains(keys(local.instance_metadata_labels), "nip-ttl-expires")
    error_message = "propagate_cost_labels defaults to true: node VMs carry the nip-* cost allocation labels, except the per-run nip-run / nip-ttl-expires (changing them would recreate every node)"
  }
  assert {
    condition     = local.labels["nip-stack"] == "inference" && local.labels["nip-env"] == "test"
    error_message = "the stack sets nip-stack; a caller's nip-env (deprecated) is kept"
  }
  assert {
    condition     = local.gpu_platform == "gpu-h100-sxm" && local.gpu_preset == "1gpu-16vcpu-200gb"
    error_message = "eu-north1 should default to gpu-h100-sxm / 1gpu-16vcpu-200gb"
  }
  assert {
    condition     = output.node_groups.gpu.drivers_preset == "cuda13.0"
    error_message = "GPU nodes default to the managed cuda13.0 driver image (ADR-0003)"
  }
  assert {
    condition     = length(module.filestore) == 1 && length(module.filestore_csi) == 1 && length(module.o11y) == 1
    error_message = "filestore, its CSI driver and o11y enabled by default"
  }
}

run "gpu_node_count_zero_is_allowed" {
  command = plan

  variables {
    gpu_node_count = 0
  }

  assert {
    condition     = output.node_groups.gpu.count == 0
    error_message = "gpu_node_count=0 should plan cleanly (CPU layer first)"
  }
}

run "rejects_multi_gpu_preset_in_lab" {
  command = plan

  variables {
    gpu_preset = "8gpu-128vcpu-1600gb"
  }

  expect_failures = [var.gpu_preset]
}

run "sandbox_policy_rejects_three_gpu_nodes" {
  command = plan

  variables {
    gpu_node_count = 3
  }

  expect_failures = [terraform_data.stage_policy]
}

run "rejects_gpu_count_over_stack_cap" {
  command = plan

  variables {
    gpu_node_count = 9
  }

  expect_failures = [var.gpu_node_count]
}

run "rejects_unsupported_region" {
  command = plan

  variables {
    region = "ap-nowhere1"
  }

  expect_failures = [var.region]
}

run "uk_south1_defaults_to_single_b300" {
  command = plan

  variables {
    region = "uk-south1"
  }

  assert {
    condition     = local.gpu_platform == "gpu-b300-sxm" && local.gpu_preset == "1gpu-24vcpu-346gb" && local.gpu_drivers_preset == "cuda13.0"
    error_message = "uk-south1 should default to gpu-b300-sxm / 1gpu-24vcpu-346gb with the cuda13.0 image"
  }
}

run "b200_platform_follows_the_region_table" {
  command = plan

  variables {
    region       = "us-central1"
    gpu_platform = "gpu-b200-sxm"
  }

  assert {
    # The B200 1-GPU preset needs driver 580.x or newer, i.e. cuda13.0
    # (https://docs.nebius.com/compute/storage/boot-disk-images#images-for-gpu-vms); the value comes from platform/regions.yaml.
    condition     = local.gpu_preset == "1gpu-20vcpu-224gb" && local.gpu_drivers_preset == yamldecode(file("../../../platform/regions.yaml")).regions["us-central1"].platforms["gpu-b200-sxm"].drivers_preset && local.gpu_drivers_preset != "cuda12.8"
    error_message = "B200 takes the driver preset platform/regions.yaml names for it (not cuda12.8: the 1-GPU preset needs 580.x) and its own single-GPU preset"
  }
}

run "rejects_platform_absent_from_region" {
  command = plan

  variables {
    region       = "eu-west1"
    gpu_platform = "gpu-h100-sxm"
  }

  expect_failures = [terraform_data.platform_check]
}

run "prod_policy_etcd_three_and_private_endpoint" {
  command = plan

  variables {
    stage       = "prod"
    k8s_version = "1.35"
    labels      = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  assert {
    condition     = local.etcd_cluster_size == 3 && local.public_endpoint == false && output.public_endpoint_enabled == false
    error_message = "prod defaults to etcd 3 and a private control-plane endpoint (platform/stages.yaml)"
  }
}

run "prod_rejects_single_etcd" {
  command = plan

  variables {
    stage             = "prod"
    k8s_version       = "1.35"
    etcd_cluster_size = 1
    labels            = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "staging_rejects_preemptible_serving" {
  command = plan

  variables {
    stage           = "staging"
    k8s_version     = "1.35"
    gpu_preemptible = true
    labels          = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "x" }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "sandbox_defaults_single_etcd_public_endpoint" {
  command = plan

  assert {
    condition     = local.etcd_cluster_size == 1 && local.public_endpoint == true
    error_message = "sandbox policy: etcd 1, public endpoint on"
  }
}

run "rejects_unknown_stage" {
  command = plan

  variables {
    stage = "dev"
  }

  expect_failures = [var.stage]
}

run "rejects_labels_without_ttl" {
  command = plan

  variables {
    labels = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "x" }
  }

  expect_failures = [var.labels]
}

run "rejects_malformed_ttl" {
  command = plan

  variables {
    labels = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "x", "nip-ttl-expires" = "tomorrow" }
  }

  expect_failures = [var.labels]
}

run "rejects_impossible_ttl_date" {
  command = plan

  variables {
    labels = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "x", "nip-ttl-expires" = "2026-99-99T99:99:99Z" }
  }

  expect_failures = [var.labels]
}

run "rejects_eol_k8s_version" {
  command = plan

  variables {
    k8s_version = "1.31"
  }

  expect_failures = [var.k8s_version]
}

run "no_filestore_no_o11y" {
  command = plan

  variables {
    enable_filestore = false
    enable_o11y      = false
  }

  assert {
    condition     = length(module.filestore) == 0 && length(module.filestore_csi) == 0 && length(module.o11y) == 0 && output.filestore == null
    error_message = "optional modules should be absent when disabled"
  }
}

# ---- Stage-governed flags (ADR-0009) ----

run "prod_requires_pinned_k8s_version" {
  command = plan

  variables {
    stage  = "prod"
    labels = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "prod_refuses_newest_k8s_version" {
  command = plan

  variables {
    stage       = "prod"
    k8s_version = "1.36" # offset 1: prod runs at most 1.35
    labels      = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "staging_public_endpoint_needs_allowed_cidrs" {
  command = plan

  variables {
    stage       = "staging"
    k8s_version = "1.35"
    labels      = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "staging_refuses_documentation_cidrs" {
  command = plan

  variables {
    stage         = "staging"
    k8s_version   = "1.35"
    allowed_cidrs = ["203.0.113.0/24"]
    labels        = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "staging_with_allowed_cidrs_audit_logs_and_alertmanager" {
  command = plan

  variables {
    stage         = "staging"
    k8s_version   = "1.35"
    allowed_cidrs = ["10.10.0.0/16"]
    labels        = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  assert {
    condition     = module.cluster.allowed_cidrs == tolist(["10.10.0.0/16"])
    error_message = "allowed_cidrs must reach the control plane's public endpoint"
  }
  assert {
    condition     = module.cluster.audit_logs_enabled
    error_message = "staging turns audit logs on (platform/stages.yaml)"
  }
  assert {
    condition     = local.alertmanager == true && length(local.alerting_rules.groups) >= 4
    error_message = "staging enables Alertmanager and loads every rule group under platform/alerts/"
  }
}

run "prod_protects_filestore_and_takes_security_groups" {
  command = plan

  variables {
    stage              = "prod"
    k8s_version        = "1.35"
    security_group_ids = ["securitygroup-e00mock"]
    labels             = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  assert {
    condition     = module.filestore[0].forbid_deletion == true
    error_message = "prod forbids deleting the shared filesystem (stage policy forbid_deletion)"
  }
  assert {
    condition     = module.gpu_nodes[0].security_group_ids[0] == "securitygroup-e00mock" && module.cpu_nodes[0].security_group_ids[0] == "securitygroup-e00mock"
    error_message = "security groups must reach the node interfaces"
  }
  assert {
    condition     = module.cluster.public_endpoint_enabled == false
    error_message = "prod has no public endpoint by policy"
  }
}

run "sandbox_keeps_alertmanager_and_audit_logs_off" {
  command = plan

  assert {
    condition     = local.alertmanager == false && !module.cluster.audit_logs_enabled && module.filestore[0].forbid_deletion == false
    error_message = "sandbox: no Alertmanager, no audit logs, filesystem deletable (everything here is disposable)"
  }
}

# R14 provisioning, live-found 2026-10-12 (sandbox, TF_VAR_alertmanager_enabled=true): Grafana had
# none of the Nebius data sources because nothing sent them. The stack now passes R14's Grafana file and
# the rules to the module; the plan output says what is sent and what is still missing.
run "sandbox_alertmanager_override_sends_rules_alertmanager_and_datasources" {
  command = plan

  variables {
    alertmanager_enabled            = true
    grafana_datasource_token_secret = "grafana-nebius-token"
  }

  assert {
    condition     = output.o11y_provisioning.alerting.alertmanager && output.o11y_provisioning.alerting.receiver_config == "inline"
    error_message = "TF_VAR_alertmanager_enabled=true reaches the module in sandbox, with the inline null-receiver config"
  }
  assert {
    condition     = output.o11y_provisioning.alerting.rules == length(flatten([for g in local.alerting_rules.groups : g.rules])) && output.o11y_provisioning.alerting.rules >= 13
    error_message = "every rule under platform/alerts/ is sent"
  }
  assert {
    condition     = output.o11y_provisioning.datasources.provisioned && join(",", output.o11y_provisioning.datasources.uids) == "nebius-provider-metrics,nebius-ingested-metrics,nebius-logs,nebius-traces"
    error_message = "the four data sources of recipes/observability/grafana/datasources.yaml are provisioned"
  }
}

run "sandbox_default_ships_rules_and_names_the_missing_token" {
  command = plan

  assert {
    condition     = !output.o11y_provisioning.alerting.alertmanager && output.o11y_provisioning.alerting.rules >= 13
    error_message = "without Alertmanager the rules still load into Prometheus (visible, nobody notified)"
  }
  assert {
    condition     = !output.o11y_provisioning.datasources.provisioned && strcontains(output.o11y_provisioning.datasources.missing_input, "grafana_datasource_token_secret")
    error_message = "without the token Secret the plan says the data sources are not provisioned and why"
  }
}

run "prod_accepts_n_minus_one" {
  command = plan

  variables {
    stage       = "prod"
    k8s_version = "1.35"
    labels      = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  assert {
    condition     = module.stage_policy.k8s_version_max == "1.35"
    error_message = "prod's ceiling is one behind the newest accepted version"
  }
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

  variables {
    gpu_node_count = 0
  }

  assert {
    condition     = length(module.gpu_nodes) == 0 && output.node_groups.gpu.id == null
    error_message = "gpu_node_count = 0 must not create a GPU node group (R3-8)"
  }
}

run "gpu_autoscaling_replaces_fixed_count" {
  command = plan

  variables {
    gpu_autoscaling = { min = 0, max = 2 }
  }

  assert {
    condition     = length(module.gpu_nodes) == 1 && output.node_groups.gpu.autoscaling.max == 2 && output.node_groups.gpu.count == null
    error_message = "autoscaling creates the GPU node group sized by min/max instead of a fixed count"
  }
}

run "gpu_autoscaling_max_is_capped_by_the_stage" {
  command = plan

  variables {
    gpu_autoscaling = { min = 0, max = 3 }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "gpu_autoscaling_rejects_min_above_max" {
  command = plan

  variables {
    gpu_autoscaling = { min = 3, max = 1 }
  }

  expect_failures = [var.gpu_autoscaling]
}

run "regular_gpu_group_pins_the_common_pool" {
  command = plan

  variables {
    propagate_cost_labels = false
  }

  assert {
    condition     = module.gpu_nodes[0].reservation_policy.policy == "FORBID"
    error_message = "without gpu_reservation a regular GPU group must use FORBID, not the API default AUTO"
  }
  assert {
    condition     = length(local.instance_metadata_labels) == 0
    error_message = "no instance metadata labels unless propagate_cost_labels or journald_logs is set"
  }
}

run "preemptible_gpu_group_sends_no_reservation" {
  command = plan

  variables {
    gpu_preemptible = true
  }

  assert {
    condition     = module.gpu_nodes[0].reservation_policy == null
    error_message = "preemptible groups do not support reservations, so none is sent"
  }
}

run "journald_and_cost_labels_reach_instance_metadata" {
  command = plan

  variables {
    journald_logs         = true
    propagate_cost_labels = true
  }

  assert {
    condition     = local.instance_metadata_labels["nebius.o11y.systemd-logs-collection.enabled"] == "true" && local.instance_metadata_labels["nebius.o11y.systemd-logs-collection.units"] == "kubelet.service;containerd.service" && local.instance_metadata_labels["nip-stack"] == "inference"
    error_message = "journald keys and the cost labels must be merged into the node instance metadata"
  }
}

run "allowed_cidrs_rejects_host_bits" {
  command = plan

  variables {
    allowed_cidrs = ["203.0.113.5/24"]
  }

  expect_failures = [var.allowed_cidrs]
}

run "zero_cpus_create_no_cpu_node_group_and_untaint_gpu" {
  command = plan

  variables {
    cpu_node_count = 0
    gpu_node_count = 1
  }

  assert {
    condition     = length(module.cpu_nodes) == 0 && output.node_groups.cpu.id == null
    error_message = "cpu_node_count = 0 must not create a CPU node group"
  }
  assert {
    condition     = length(local.gpu_taints) == 0
    error_message = "with no CPU nodes the GPU node must host system add-ons, so it carries no NoSchedule taint"
  }
}

run "cpu_nodes_keep_the_gpu_taint" {
  command = plan

  assert {
    condition     = length(local.gpu_taints) == 1 && local.gpu_taints[0].key == "nvidia.com/gpu"
    error_message = "with CPU nodes, the GPU node keeps nvidia.com/gpu NoSchedule so system pods stay off it"
  }
}

run "no_nodes_at_all_refuses_add_ons_that_need_nodes" {
  command = plan

  variables {
    cpu_node_count = 0
    gpu_node_count = 0
  }

  expect_failures = [var.cpu_node_count]
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

# An allowlist that admits the whole internet is no allowlist (stages with require_allowed_cidrs).
run "staging_refuses_an_internet_wide_allowlist" {
  command = plan

  variables {
    stage         = "staging"
    k8s_version   = "1.35"
    allowed_cidrs = ["0.0.0.0/0"]
    labels        = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "staging_refuses_the_two_slash_one_halves" {
  command = plan

  variables {
    stage         = "staging"
    k8s_version   = "1.35"
    allowed_cidrs = ["0.0.0.0/1", "128.0.0.0/1"]
    labels        = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "staging_accepts_a_slash_eight" {
  command = plan

  variables {
    stage         = "staging"
    k8s_version   = "1.35"
    allowed_cidrs = ["10.0.0.0/8"]
    labels        = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  assert {
    condition     = length(module.stage_policy.violations) == 0
    error_message = "a /8 is the widest allowlist entry the stage policy accepts"
  }
}

# prod's private endpoint is the stage policy, not a default: a request cannot loosen it.
run "prod_refuses_a_public_endpoint_even_with_an_allowlist" {
  command = plan

  variables {
    stage           = "prod"
    k8s_version     = "1.35"
    public_endpoint = true
    allowed_cidrs   = ["10.10.0.0/16"]
    labels          = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  expect_failures = [terraform_data.stage_policy]
}

# The sandbox TTL must lie in the future and at most 7 days out, measured at plan time.
run "sandbox_refuses_a_past_ttl" {
  command = plan

  variables {
    labels = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "x", "nip-ttl-expires" = "2020-01-01T00:00:00Z" }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "sandbox_refuses_a_ttl_beyond_seven_days" {
  command = plan

  variables {
    labels = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "x", "nip-ttl-expires" = "2099-01-01T00:00:00Z" }
  }

  expect_failures = [terraform_data.stage_policy]
}

# "May tighten, never loosen" holds for etcd in staging too, not only prod.
run "staging_rejects_single_etcd" {
  command = plan

  variables {
    stage             = "staging"
    k8s_version       = "1.35"
    allowed_cidrs     = ["10.10.0.0/16"]
    etcd_cluster_size = 1
    labels            = { "nip-env" = "lab", "nip-owner" = "platform", "nip-run" = "release-1" }
  }

  expect_failures = [terraform_data.stage_policy]
}

# The committed run profile the 2026-10-11 sandbox runs reproduce (make plan PROFILE=l40s-gpu-only,
# platform/profiles/inference/l40s-gpu-only.json) plans under the sandbox policy with its own inputs.
run "run_profile_l40s_gpu_only_plans_in_sandbox" {
  command = plan

  variables {
    cpu_node_count     = jsondecode(file("../../../platform/profiles/inference/l40s-gpu-only.json")).vars.cpu_node_count
    gpu_platform       = jsondecode(file("../../../platform/profiles/inference/l40s-gpu-only.json")).vars.gpu_platform
    gpu_preset         = jsondecode(file("../../../platform/profiles/inference/l40s-gpu-only.json")).vars.gpu_preset
    gpu_node_count     = jsondecode(file("../../../platform/profiles/inference/l40s-gpu-only.json")).vars.gpu_node_count
    gpu_preemptible    = jsondecode(file("../../../platform/profiles/inference/l40s-gpu-only.json")).vars.gpu_preemptible
    enable_filestore   = jsondecode(file("../../../platform/profiles/inference/l40s-gpu-only.json")).vars.enable_filestore
    filestore_size_gib = jsondecode(file("../../../platform/profiles/inference/l40s-gpu-only.json")).vars.filestore_size_gib
    enable_o11y        = jsondecode(file("../../../platform/profiles/inference/l40s-gpu-only.json")).vars.enable_o11y
  }

  assert {
    condition     = output.node_groups.gpu.platform == "gpu-l40s-a" && output.node_groups.gpu.preset == "1gpu-8vcpu-32gb" && output.node_groups.gpu.count == 1 && module.gpu_nodes[0].reservation_policy == null
    error_message = "the profile plans one preemptible gpu-l40s-a / 1gpu-8vcpu-32gb node, as in the evidence runs"
  }
  assert {
    condition     = length(module.cpu_nodes) == 0 && length(local.gpu_taints) == 0 && length(module.filestore) == 1
    error_message = "the profile has no CPU node group, an untainted GPU node and the shared filesystem"
  }
}
