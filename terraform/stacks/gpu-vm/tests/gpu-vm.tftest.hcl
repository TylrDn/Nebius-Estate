# Plan-mode tests for the GPU VM quickstart (mocked provider, no spend).
#
# The shared stage policy is overridden to "no violations" here so these runs pin the VM's shape
# whatever platform/stages.yaml caps gpu-vm at; policy.tftest.hcl runs the real module. The stack's
# own exposure rules (public address needs an allowlist) are not part of the module and still apply.

mock_provider "nebius" {
  override_during = plan

  mock_resource "nebius_compute_v1_instance" {
    defaults = { id = "computeinstance-e00mock00000" }
  }
  mock_resource "nebius_vpc_v1_allocation" {
    defaults = { id = "vpcallocation-e00mock000000", status = { details = { allocated_cidr = "10.40.0.17/32" } } }
  }
  mock_resource "nebius_vpc_v1_security_group" {
    defaults = { id = "vpcsecuritygroup-e00mock000" }
  }
  mock_data "nebius_vpc_v1_subnet" {
    defaults = { network_id = "vpcnetwork-e00mock000000000" }
  }
}

override_module {
  target  = module.stage_policy
  outputs = { violations = [] }
}

variables {
  stage          = "sandbox"
  parent_id      = "project-e00mock"
  region         = "eu-north1"
  subnet_id      = "vpcsubnet-e00mock0000000000"
  ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyForPlanTestsOnly0000000000000000"
  labels = {
    "nip-env"         = "gpu-vm"
    "nip-owner"       = "ci"
    "nip-run"         = "mock"
    "nip-ttl-expires" = timeadd(timestamp(), "24h") # inside the 7-day sandbox window
  }
}

run "defaults_follow_regions_yaml_and_stay_private" {
  command = plan

  assert {
    condition     = nebius_compute_v1_instance.this.resources.platform == "gpu-h100-sxm" && nebius_compute_v1_instance.this.resources.preset == "1gpu-16vcpu-200gb"
    error_message = "eu-north1 defaults to its regions.yaml platform and that platform's 1-GPU preset"
  }
  assert {
    condition     = nebius_compute_v1_instance.this.boot_disk.managed_disk.spec.source_image_family.image_family == "ubuntu24.04-cuda13.0" && nebius_compute_v1_instance.this.boot_disk.managed_disk.name == "nip-sandbox-gpu-vm-boot"
    error_message = "VM-managed boot disk from the stable CUDA 13 family, named after the VM"
  }
  assert {
    condition     = nebius_compute_v1_instance.this.name == "nip-sandbox-gpu-vm" && nebius_compute_v1_instance.this.labels["nip-stage"] == "sandbox" && nebius_compute_v1_instance.this.labels["nip-stack"] == "gpu-vm" && nebius_compute_v1_instance.this.labels["nip-ttl-expires"] == var.labels["nip-ttl-expires"]
    error_message = "nip-<stage>-gpu-vm, with the stage, stack and TTL labels"
  }
  assert {
    condition     = nebius_compute_v1_instance.this.network_interfaces[0].public_ip_address == null && length(nebius_vpc_v1_allocation.public) == 0 && length(nebius_vpc_v1_security_group.access) == 0
    error_message = "no public address and no access group by default"
  }
  assert {
    condition     = nebius_compute_v1_instance.this.network_interfaces[0].ip_address.allocation_id == "vpcallocation-e00mock000000" && nebius_compute_v1_instance.this.network_interfaces[0].security_groups == null
    error_message = "the private address is an allocation, stable across VM replacement; no groups unless given"
  }
  assert {
    condition     = nebius_compute_v1_instance.this.preemptible == null && nebius_compute_v1_instance.this.recovery_policy == null && nebius_compute_v1_instance.this.filesystems == null
    error_message = "regular VM, no filesystem by default"
  }
  assert {
    condition     = strcontains(nebius_compute_v1_instance.this.cloud_init_user_data, "-p 127.0.0.1:8000:8000")
    error_message = "the API is published on loopback only (SSH tunnel)"
  }
  assert {
    condition     = strcontains(nebius_compute_v1_instance.this.cloud_init_user_data, "vllm/vllm-openai:v0.31.0@sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3")
    error_message = "the vLLM image is pinned by digest from platform/versions.yaml"
  }
  assert {
    condition     = strcontains(nebius_compute_v1_instance.this.cloud_init_user_data, "'Qwen/Qwen2.5-1.5B-Instruct' '--revision' '989aa7980e4cf806f80c7fef2b1adb7bc71aa306'") && strcontains(nebius_compute_v1_instance.this.cloud_init_user_data, "'--tensor-parallel-size' '1'")
    error_message = "model and revision from platform/versions.yaml, one GPU"
  }
  assert {
    condition     = can(yamldecode(nebius_compute_v1_instance.this.cloud_init_user_data)) && yamldecode(nebius_compute_v1_instance.this.cloud_init_user_data).users[0].name == "nip-admin"
    error_message = "user data is valid YAML with the admin user"
  }
  assert {
    condition     = !can(regex("VLLM_API_KEY=[0-9a-f]", nebius_compute_v1_instance.this.cloud_init_user_data))
    error_message = "no API key in user data: it is generated on the VM"
  }
  assert {
    condition     = output.private_ip == "10.40.0.17" && output.public_ip == null && output.how_to_reach.tunnel == "ssh -N -L 8000:127.0.0.1:8000 nip-admin@10.40.0.17"
    error_message = "outputs carry the bare private IP and the tunnel command"
  }
}

run "network_from_r7" {
  command = plan

  variables {
    security_group_ids = ["vpcsecuritygroup-e00r7workload"]
  }

  assert {
    condition     = nebius_compute_v1_instance.this.network_interfaces[0].subnet_id == "vpcsubnet-e00mock0000000000" && nebius_compute_v1_instance.this.network_interfaces[0].security_groups[0].id == "vpcsecuritygroup-e00r7workload"
    error_message = "R7's subnet and security group are attached"
  }
}

run "public_address_needs_an_allowlist_in_every_stage" {
  command = plan

  variables {
    public_ip = true
  }

  expect_failures = [terraform_data.stage_policy]
}

run "rejects_an_open_allowlist" {
  command = plan

  variables {
    public_ip     = true
    allowed_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [var.allowed_cidrs]
}

run "public_address_behind_the_allowlist" {
  command = plan

  variables {
    public_ip          = true
    expose_api         = true
    allowed_cidrs      = ["10.10.0.0/16"]
    security_group_ids = ["vpcsecuritygroup-e00r7workload"]
  }

  assert {
    condition     = length(nebius_vpc_v1_allocation.public) == 1 && nebius_compute_v1_instance.this.network_interfaces[0].public_ip_address.allocation_id == "vpcallocation-e00mock000000"
    error_message = "the public address is a reserved allocation: it survives a stop (a preempted VM loses a dynamic one)"
  }
  assert {
    condition     = nebius_vpc_v1_security_rule.access_allow[0].ingress.source_cidrs == tolist(["10.10.0.0/16"]) && nebius_vpc_v1_security_rule.access_allow[0].ingress.destination_ports == tolist([22, 8000]) && nebius_vpc_v1_security_rule.access_allow[0].priority < 400
    error_message = "SSH and the API open to the allowlist only, ahead of the deny"
  }
  assert {
    condition     = nebius_vpc_v1_security_rule.access_deny[0].access == "DENY" && nebius_vpc_v1_security_rule.access_deny[0].priority < 500 && nebius_vpc_v1_security_rule.access_egress[0].type == "STATEFUL"
    error_message = "other ingress denied ahead of the default group's ALLOW at 500; egress stateful"
  }
  assert {
    condition     = nebius_vpc_v1_security_group.access[0].network_id == "vpcnetwork-e00mock000000000" && length(nebius_compute_v1_instance.this.network_interfaces[0].security_groups) == 2
    error_message = "the access group lives in the subnet's network and joins the given groups"
  }
  assert {
    condition     = strcontains(nebius_compute_v1_instance.this.cloud_init_user_data, "-p 8000:8000") && output.how_to_reach.base_url == "http://10.40.0.17:8000/v1"
    error_message = "expose_api publishes the port on every interface"
  }
}

run "public_ssh_only_without_expose_api" {
  command = plan

  variables {
    public_ip     = true
    allowed_cidrs = ["10.10.0.0/16"]
  }

  assert {
    condition     = nebius_vpc_v1_security_rule.access_allow[0].ingress.destination_ports == tolist([22]) && strcontains(nebius_compute_v1_instance.this.cloud_init_user_data, "-p 127.0.0.1:8000:8000")
    error_message = "a public VM without expose_api opens SSH only; the API stays on loopback"
  }
}

run "preemptible_where_allowed" {
  command = plan

  variables {
    preemptible = true
  }

  assert {
    condition     = nebius_compute_v1_instance.this.preemptible.on_preemption == "STOP" && nebius_compute_v1_instance.this.recovery_policy == "FAIL"
    error_message = "preemptible VMs support only STOP on preemption and recovery policy FAIL"
  }
  assert {
    condition     = nebius_compute_v1_instance.this.follows_spot_price != null && nebius_compute_v1_instance.this.spot_pricing_policy == null
    error_message = "without a pricing policy the VM follows the spot price"
  }
}

run "preemptible_with_a_price_cap" {
  command = plan

  variables {
    preemptible            = true
    spot_pricing_policy_id = "pricingpolicy-e00mock"
  }

  assert {
    condition     = nebius_compute_v1_instance.this.spot_pricing_policy.id == "pricingpolicy-e00mock" && nebius_compute_v1_instance.this.follows_spot_price == null
    error_message = "a pricing policy caps the spot price"
  }
}

run "price_cap_needs_preemptible" {
  command = plan

  variables {
    spot_pricing_policy_id = "pricingpolicy-e00mock"
  }

  expect_failures = [terraform_data.stage_policy]
}

run "b300_uses_cuda13" {
  command = plan

  variables {
    region = "eu-west2"
  }

  assert {
    condition     = nebius_compute_v1_instance.this.resources.platform == "gpu-b300-sxm" && nebius_compute_v1_instance.this.resources.preset == "1gpu-24vcpu-346gb" && nebius_compute_v1_instance.this.boot_disk.managed_disk.spec.source_image_family.image_family == "ubuntu24.04-cuda13.0"
    error_message = "B300: its 1-GPU preset on the CUDA 13 (580.x) image"
  }
}

run "b200_uses_cuda13" {
  command = plan

  variables {
    region   = "us-central1"
    platform = "gpu-b200-sxm"
  }

  assert {
    condition     = nebius_compute_v1_instance.this.resources.preset == "1gpu-20vcpu-224gb" && nebius_compute_v1_instance.this.boot_disk.managed_disk.spec.source_image_family.image_family == "ubuntu24.04-cuda13.0"
    error_message = "B200 1-GPU preset needs driver 580.x: the CUDA 13 image"
  }
}

run "b300_refuses_the_cuda12_image" {
  command = plan

  variables {
    region       = "eu-west2"
    image_family = "ubuntu24.04-cuda12"
  }

  expect_failures = [nebius_compute_v1_instance.this]
}

run "hopper_accepts_the_cuda12_image" {
  command = plan

  variables {
    image_family = "ubuntu24.04-cuda12"
  }

  assert {
    condition     = nebius_compute_v1_instance.this.boot_disk.managed_disk.spec.source_image_family.image_family == "ubuntu24.04-cuda12"
    error_message = "H100 lists ubuntu24.04-cuda12 as an alternative image"
  }
}

run "refuses_a_platform_outside_the_region" {
  command = plan

  variables {
    platform = "gpu-b300-sxm"
  }

  expect_failures = [nebius_compute_v1_instance.this]
}

run "l40s_override_and_multi_gpu_preset" {
  command = plan

  variables {
    platform = "gpu-l40s-d"
    preset   = "2gpu-64vcpu-384gb"
  }

  assert {
    condition     = nebius_compute_v1_instance.this.resources.preset == "2gpu-64vcpu-384gb" && strcontains(nebius_compute_v1_instance.this.cloud_init_user_data, "'--tensor-parallel-size' '2'") && output.platform.gpus == 2
    error_message = "a 2-GPU preset runs vLLM with tensor parallelism 2"
  }
}

run "filesystem_from_r8" {
  command = plan

  variables {
    existing_filesystem_id = "computefilesystem-e00mock000"
  }

  assert {
    condition     = nebius_compute_v1_instance.this.filesystems[0].existing_filesystem.id == "computefilesystem-e00mock000" && nebius_compute_v1_instance.this.filesystems[0].attach_mode == "READ_WRITE" && nebius_compute_v1_instance.this.filesystems[0].mount_tag == "nip-fs"
    error_message = "R8's filesystem is attached read-write under a fixed mount tag"
  }
  assert {
    condition     = strcontains(nebius_compute_v1_instance.this.cloud_init_user_data, "nip-fs /mnt/fs virtiofs rw,nofail 0 0") && strcontains(nebius_compute_v1_instance.this.cloud_init_user_data, "RequiresMountsFor=/mnt/fs") && strcontains(nebius_compute_v1_instance.this.cloud_init_user_data, "mkdir -p /mnt/fs/vllm-cache")
    error_message = "mounted as virtiofs with nofail; the model cache lives on it and vLLM waits for the mount"
  }
  assert {
    condition     = can(yamldecode(nebius_compute_v1_instance.this.cloud_init_user_data))
    error_message = "user data with the mount is still valid YAML"
  }
}

run "rejects_reserved_user_names" {
  command = plan

  variables {
    admin_user = "admin"
  }

  expect_failures = [var.admin_user]
}

run "sandbox_requires_a_ttl" {
  command = plan

  variables {
    labels = { "nip-env" = "gpu-vm", "nip-owner" = "ci", "nip-run" = "mock" }
  }

  expect_failures = [var.labels]
}

run "rejects_a_model_not_pinned_in_versions_yaml" {
  command = plan

  variables {
    model = "pytorch"
  }

  expect_failures = [var.model]
}

run "rejects_the_two_slash_one_halves" {
  command = plan

  variables {
    public_ip     = true
    allowed_cidrs = ["0.0.0.0/1", "128.0.0.0/1"]
  }

  expect_failures = [var.allowed_cidrs]
}
