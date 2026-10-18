# Stage policy for the GPU VM, with the real modules/stage-policy (mocked provider, no spend).
#
# The GPU cap is max_gpu_nodes["gpu-vm"] in platform/stages.yaml, 0 where the stage does not list
# the stack, so a stage plans a GPU VM only once the policy grants it one. These runs hold whatever
# the file says: they read the cap from it instead of hard-coding it.

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

variables {
  parent_id      = "project-e00mock"
  subnet_id      = "vpcsubnet-e00mock0000000000"
  ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyForPlanTestsOnly0000000000000000"
  labels = {
    "nip-env"         = "gpu-vm"
    "nip-owner"       = "ci"
    "nip-run"         = "mock"
    "nip-ttl-expires" = timeadd(timestamp(), "24h") # inside the 7-day sandbox window
  }
}

# The module as the stack calls it: one GPU VM counted against the stage's gpu-vm cap.
run "gpu_cap_comes_from_stages_yaml" {
  command = plan

  module {
    source = "../../modules/stage-policy"
  }

  variables {
    stage                       = "sandbox"
    stack                       = "gpu-vm"
    has_cluster                 = false
    has_public_endpoint_control = false
    gpu_node_count              = 1
  }

  assert {
    condition = length([for v in output.violations : v if strcontains(v, "caps gpu_node_count for gpu-vm")]) == (
      lookup(yamldecode(file("../../../platform/stages.yaml")).stages.sandbox.policy.max_gpu_nodes, "gpu-vm", 0) >= 1 ? 0 : 1
    )
    error_message = "one GPU VM is refused exactly when stages.yaml gives gpu-vm no sandbox cap"
  }
}

run "staging_policy_refuses_preemptible_gpus" {
  command = plan

  module {
    source = "../../modules/stage-policy"
  }

  variables {
    stage                       = "staging"
    stack                       = "gpu-vm"
    has_cluster                 = false
    has_public_endpoint_control = false
    gpu_preemptible             = true
  }

  assert {
    condition     = length([for v in output.violations : v if strcontains(v, "does not allow preemptible GPU nodes")]) == 1
    error_message = "staging refuses preemptible GPU capacity (allow_preemptible_serving: false)"
  }
}

run "sandbox_policy_allows_preemptible_gpus" {
  command = plan

  module {
    source = "../../modules/stage-policy"
  }

  variables {
    stage                       = "sandbox"
    stack                       = "gpu-vm"
    has_cluster                 = false
    has_public_endpoint_control = false
    gpu_preemptible             = true
  }

  assert {
    condition     = length([for v in output.violations : v if strcontains(v, "preemptible")]) == 0
    error_message = "sandbox allows preemptible GPU capacity"
  }
}

# The whole stack: whatever the cap, staging never plans a preemptible GPU VM.
run "stack_refuses_preemptible_in_staging" {
  command = plan

  variables {
    stage       = "staging"
    preemptible = true
    labels      = { "nip-env" = "gpu-vm", "nip-owner" = "ci", "nip-run" = "mock" }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "stack_refuses_documentation_ranges_in_prod" {
  command = plan

  variables {
    stage         = "prod"
    public_ip     = true
    allowed_cidrs = ["203.0.113.0/24"]
    labels        = { "nip-env" = "gpu-vm", "nip-owner" = "ci", "nip-run" = "prod" }
  }

  expect_failures = [terraform_data.stage_policy]
}

# The module: wherever an allowlist is required, an entry wider than /8 is refused.
run "module_refuses_allowlist_entries_wider_than_slash_eight" {
  command = plan

  module {
    source = "../../modules/stage-policy"
  }

  variables {
    stage                       = "staging"
    stack                       = "gpu-vm"
    has_cluster                 = false
    has_public_endpoint_control = false
    allowed_cidrs               = ["10.0.0.0/8", "0.0.0.0/1"]
  }

  assert {
    condition     = length([for v in output.violations : v if strcontains(v, "0.0.0.0/1") && !strcontains(v, "10.0.0.0/8")]) == 1
    error_message = "the stage policy must name 0.0.0.0/1 (wider than /8) and accept 10.0.0.0/8"
  }
}

run "module_refuses_a_wide_bastion_allowlist_in_sandbox" {
  command = plan

  module {
    source = "../../modules/stage-policy"
  }

  variables {
    stage                       = "sandbox"
    stack                       = "network"
    has_cluster                 = false
    has_public_endpoint_control = false
    public_bastion              = true
    allowed_cidrs               = ["0.0.0.0/0"]
  }

  assert {
    condition     = length([for v in output.violations : v if strcontains(v, "0.0.0.0/0")]) == 1
    error_message = "a public bastion never takes an allowlist wider than /8, sandbox included"
  }
}
