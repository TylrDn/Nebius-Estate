# Plan-mode tests for the governance controls (mocked provider, no spend, no API calls).

mock_provider "nebius" {
  override_during = plan

  mock_resource "nebius_billing_v1_pricing_policy" {
    defaults = { id = "billingpricingpolicy-e00mock", status = { scheduling_state = "SCHEDULING_STATE_ALLOWED" } }
  }
  mock_resource "nebius_capacity_v1_capacity_allowance" {
    defaults = { id = "capacityallowance-e00mock", status = { usage = 0 } }
  }
  mock_data "nebius_quotas_v1_quota_allowance" {
    defaults = { limit = null, status = { usage = 2, usage_state = "USAGE_STATE_USED", unit = "count" } }
  }
}

variables {
  stage     = "sandbox"
  parent_id = "project-e00mock"
  region    = "eu-north1"
  labels = {
    "nip-env"         = "governance"
    "nip-owner"       = "ci"
    "nip-run"         = "mock"
    "nip-ttl-expires" = timeadd(timestamp(), "24h") # inside the 7-day sandbox window
  }
}

run "defaults_create_nothing" {
  command = plan

  assert {
    condition     = length(nebius_billing_v1_pricing_policy.spot_cap) == 0 && length(nebius_capacity_v1_capacity_allowance.project_limit) == 0
    error_message = "controls are opt-in: no caps or limits without inputs"
  }
  assert {
    condition     = output.stage_gpu_ceiling == 56
    error_message = "sandbox ceiling is (2 + 4 + 1) nodes x 8 GPUs from platform/stages.yaml (inference, training, gpu-vm)"
  }
}

run "spot_caps_and_project_limits" {
  command = plan

  variables {
    spot_price_caps = { "gpu-h100-sxm" = "2.500", "gpu-h200-sxm" = "3.1" }
    capacity_limits = {
      h100 = { capacity_block_group_id = "capacityblockgroup-e00mock", limit = 0 }
    }
  }

  assert {
    condition     = nebius_billing_v1_pricing_policy.spot_cap["gpu-h100-sxm"].name == "nip-sandbox-spot-gpu-h100-sxm"
    error_message = "pricing policy name is <name>-<stage>-spot-<platform>"
  }
  assert {
    condition     = nebius_billing_v1_pricing_policy.spot_cap["gpu-h100-sxm"].parent_id == "project-e00mock"
    error_message = "a pricing policy belongs to the stage project"
  }
  assert {
    condition     = nebius_billing_v1_pricing_policy.spot_cap["gpu-h100-sxm"].compute_instance_spec.v1.platform == "gpu-h100-sxm"
    error_message = "one policy per GPU platform"
  }
  assert {
    condition     = nebius_billing_v1_pricing_policy.spot_cap["gpu-h200-sxm"].pricing.max_price_v1.max_price == "3.1" && nebius_billing_v1_pricing_policy.spot_cap["gpu-h100-sxm"].pricing.max_price_v1.max_price == "2.5"
    error_message = "max price is sent in the canonical form the API stores (\"2.500\" -> \"2.5\"; live apply 2026-10-11)"
  }
  assert {
    condition     = nebius_billing_v1_pricing_policy.spot_cap["gpu-h100-sxm"].labels == null && nebius_billing_v1_pricing_policy.spot_cap["gpu-h100-sxm"].name == "nip-sandbox-spot-gpu-h100-sxm"
    error_message = "pricing policies get no labels (the API keeps none; live apply 2026-10-11); the name carries the stage for scripts/leftovers.sh"
  }
  assert {
    condition     = nebius_capacity_v1_capacity_allowance.project_limit["h100"].labels["nip-stage"] == "sandbox" && nebius_capacity_v1_capacity_allowance.project_limit["h100"].labels["nip-stack"] == "governance"
    error_message = "nip-stage and nip-stack are set by the stack (docs/naming.md)"
  }
  assert {
    condition     = nebius_capacity_v1_capacity_allowance.project_limit["h100"].limit == 0 && nebius_capacity_v1_capacity_allowance.project_limit["h100"].parent_id == "project-e00mock"
    error_message = "limit 0 is kept (it disables CBG use for the project)"
  }
  assert {
    condition     = nebius_capacity_v1_capacity_allowance.project_limit["h100"].name == "nip-sandbox-cbg-h100"
    error_message = "project limit name is <name>-<stage>-cbg-<key>"
  }
  assert {
    condition     = output.pricing_policy_ids["gpu-h100-sxm"] == "billingpricingpolicy-e00mock"
    error_message = "pricing policy ids are exported per platform for gpu_spot_pricing_policy_id"
  }
}

run "price_with_four_decimals_is_refused" {
  command = plan

  variables {
    spot_price_caps = { "gpu-h100-sxm" = "2.5001" }
  }
  expect_failures = [var.spot_price_caps]
}

run "platform_not_in_region_is_refused" {
  command = plan

  variables {
    spot_price_caps = { "gpu-b300-sxm" = "3.000" }
  }
  expect_failures = [var.spot_price_caps]
}

# The pricing-policy API refused gpu-l40s-a in eu-north1 at apply (2026-10-11); the platform is in
# the region but takes no spot cap, so the plan must stop first.
run "platform_without_spot_cap_is_refused" {
  command = plan
  variables {
    spot_price_caps = { "gpu-l40s-a" = "1.000" }
  }
  expect_failures = [var.spot_price_caps]
}

run "cpu_platform_is_refused" {
  command = plan

  variables {
    spot_price_caps = { "cpu-d3" = "1.000" }
  }
  expect_failures = [var.spot_price_caps]
}

run "fractional_limit_is_refused" {
  command = plan

  variables {
    capacity_limits = { h100 = { capacity_block_group_id = "capacityblockgroup-e00mock", limit = 1.5 } }
  }
  expect_failures = [var.capacity_limits]
}

run "limit_above_stage_ceiling_is_refused" {
  command = plan

  variables {
    capacity_limits = { h100 = { capacity_block_group_id = "capacityblockgroup-e00mock", limit = 57 } }
  }
  expect_failures = [nebius_capacity_v1_capacity_allowance.project_limit]
}

run "prod_ceiling_follows_stage_policy" {
  command = plan

  variables {
    stage           = "prod"
    labels          = { "nip-env" = "governance", "nip-owner" = "ci", "nip-run" = "prod" }
    capacity_limits = { h100 = { capacity_block_group_id = "capacityblockgroup-e00mock", limit = 320 } }
  }

  assert {
    condition     = output.stage_gpu_ceiling == 320 && nebius_capacity_v1_capacity_allowance.project_limit["h100"].limit == 320
    error_message = "prod ceiling is (8 + 32 + 0) nodes x 8 GPUs"
  }
}

run "quota_watch_reports_usage_and_a_missing_limit" {
  command = plan

  variables {
    quota_watch = ["compute.instance.gpu.h100"]
  }

  assert {
    condition     = output.quota_usage["compute.instance.gpu.h100"].usage == 2 && output.quota_usage["compute.instance.gpu.h100"].limit == null
    error_message = "quota usage is read; an omitted limit stays null, never a guessed number"
  }
}

run "sandbox_requires_ttl_label" {
  command = plan

  variables {
    labels = { "nip-env" = "governance", "nip-owner" = "ci", "nip-run" = "mock" }
  }
  expect_failures = [var.labels]
}

run "nip_run_is_required" {
  command = plan

  variables {
    stage  = "staging"
    labels = { "nip-env" = "governance", "nip-owner" = "ci" }
  }
  expect_failures = [var.labels]
}

run "sandbox_refuses_a_ttl_beyond_seven_days" {
  command = plan

  variables {
    labels = { "nip-env" = "governance", "nip-owner" = "ci", "nip-run" = "mock", "nip-ttl-expires" = "2099-01-01T00:00:00Z" }
  }

  expect_failures = [terraform_data.stage_policy]
}
