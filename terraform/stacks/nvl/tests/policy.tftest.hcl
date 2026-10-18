# Stage policy for the GB300 NVL72 stack, with the real modules/stage-policy (mocked provider,
# no spend). The cap is max_gpu_nodes["nvl"] in platform/stages.yaml (0 in every stage until a
# reservation is approved) and require_strict_reservation["nvl"]; these runs read both from the
# file instead of hard-coding them, so they keep holding when a reviewed change raises the cap.

mock_provider "nebius" {
  override_during = plan

  mock_resource "nebius_compute_v1_nvl_instance_group" {
    defaults = { id = "nvlinstancegroup-e00mock000" }
  }
  mock_resource "nebius_mk8s_v1_node_group" {
    defaults = { id = "mk8snodegroup-e00mock00000" }
  }
}

variables {
  parent_id  = "project-e00mock"
  cluster_id = "mk8scluster-e00mock0000000"
  subnet_id  = "vpcsubnet-e00mock0000000000"
  labels = {
    "nip-env"         = "nvl"
    "nip-owner"       = "ci"
    "nip-run"         = "mock"
    "nip-ttl-expires" = timeadd(timestamp(), "24h") # inside the 7-day sandbox window
  }
}

# The module as the stack calls it for one rack (18 nodes), in each stage.
run "sandbox_cap_comes_from_stages_yaml" {
  command = plan

  module {
    source = "../../modules/stage-policy"
  }

  variables {
    stage                       = "sandbox"
    stack                       = "nvl"
    has_cluster                 = false
    has_public_endpoint_control = false
    gpu_node_count              = 18
    gpu_reservation_policy      = "STRICT"
  }

  assert {
    condition = length([for v in output.violations : v if strcontains(v, "caps gpu_node_count for nvl")]) == (
      lookup(yamldecode(file("../../../platform/stages.yaml")).stages.sandbox.policy.max_gpu_nodes, "nvl", 0) >= 18 ? 0 : 1
    )
    error_message = "one rack is refused in sandbox exactly when stages.yaml gives nvl fewer than 18 nodes there"
  }
}

run "prod_cap_comes_from_stages_yaml" {
  command = plan

  module {
    source = "../../modules/stage-policy"
  }

  variables {
    stage                       = "prod"
    stack                       = "nvl"
    has_cluster                 = false
    has_public_endpoint_control = false
    gpu_node_count              = 18
    gpu_reservation_policy      = "STRICT"
  }

  assert {
    condition = length([for v in output.violations : v if strcontains(v, "caps gpu_node_count for nvl")]) == (
      lookup(yamldecode(file("../../../platform/stages.yaml")).stages.prod.policy.max_gpu_nodes, "nvl", 0) >= 18 ? 0 : 1
    )
    error_message = "one rack is refused in prod exactly when stages.yaml gives nvl fewer than 18 nodes there"
  }
}

# Where the stage requires STRICT for nvl, a rack on anything else is refused.
run "prod_requires_a_strict_reservation" {
  command = plan

  module {
    source = "../../modules/stage-policy"
  }

  variables {
    stage                       = "prod"
    stack                       = "nvl"
    has_cluster                 = false
    has_public_endpoint_control = false
    gpu_node_count              = 18
    gpu_reservation_policy      = "AUTO"
  }

  assert {
    condition = length([for v in output.violations : v if strcontains(v, "STRICT capacity reservation")]) == (
      lookup(yamldecode(file("../../../platform/stages.yaml")).stages.prod.policy.require_strict_reservation, "nvl", false) ? 1 : 0
    )
    error_message = "prod refuses nvl nodes off a STRICT reservation when require_strict_reservation.nvl is true"
  }
}

# The whole stack with the real policy: zero racks plans cleanly in every stage.
run "zero_racks_plan_in_prod" {
  command = plan

  variables {
    stage  = "prod"
    labels = { "nip-env" = "nvl", "nip-owner" = "ci", "nip-run" = "prod" }
  }

  assert {
    condition     = length(nebius_mk8s_v1_node_group.rack) == 0
    error_message = "racks = 0 plans nothing and passes the stage policy"
  }
}

# Whatever the cap, a rack without a reservation never plans.
run "stack_refuses_a_rack_without_a_reservation_in_staging" {
  command = plan

  variables {
    stage  = "staging"
    racks  = 1
    labels = { "nip-env" = "nvl", "nip-owner" = "ci", "nip-run" = "mock" }
  }

  expect_failures = [terraform_data.stage_policy]
}
