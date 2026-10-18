# R9: the finance and governance controls the Nebius provider can hold, per stage project.
#  - Spot price caps: one pricing policy per GPU platform (docs: signup-billing/pricing-policy).
#  - Project limits on capacity block groups, so one stage cannot take another's reserved GPUs
#    (docs: overview/limits/project-limits).
#  - Read-only quota usage (docs: overview/quotas).
# Budgets and the periodic FOCUS export have no provider resource at 0.6.67: they are console
# steps in recipes/finance/README.md. Nothing here creates compute or storage.

locals {
  labels = merge({ "nip-env" = "governance" }, var.labels, { "nip-region" = var.region, "nip-stage" = var.stage, "nip-stack" = "governance" })
  policy = yamldecode(file("${path.module}/../../../platform/stages.yaml")).stages[var.stage].policy

  # The most GPUs this stage may ever plan: every stack's node cap times 8 GPUs per node (the
  # largest preset per node in platform/regions.yaml). A project limit above it is a typo or a
  # policy change, never a sizing decision made here.
  stage_gpu_ceiling = sum(values(local.policy.max_gpu_nodes)) * 8
}

# Shared stage rules (platform/stages.yaml) that apply to a stack without compute: the sandbox TTL window.
module "stage_policy" {
  source = "../../modules/stage-policy"

  stage                       = var.stage
  stack                       = "governance"
  has_cluster                 = false
  has_public_endpoint_control = false
  ttl_expires                 = lookup(var.labels, "nip-ttl-expires", null)
}

resource "terraform_data" "stage_policy" {
  lifecycle {
    precondition {
      condition     = length(module.stage_policy.violations) == 0
      error_message = "stage ${var.stage} policy (platform/stages.yaml): ${join("; ", module.stage_policy.violations)}."
    }
  }
}

resource "nebius_billing_v1_pricing_policy" "spot_cap" {
  for_each = var.spot_price_caps

  parent_id = var.parent_id
  name      = "${var.name}-${var.stage}-spot-${each.key}"
  # No labels: the API keeps none, so the provider reports "inconsistent result after apply" for each
  # one (live apply 2026-10-11). The name carries the stage; scripts/leftovers.sh lists these by name.

  compute_instance_spec = {
    v1 = { platform = each.key }
  }
  pricing = {
    # The API stores the canonical decimal ("1.000" comes back as "1", "2.500" as "2.5"); sending that
    # form keeps the plan and the stored value equal (live apply 2026-10-11).
    max_price_v1 = { max_price = tostring(tonumber(each.value)) }
  }
}

resource "nebius_capacity_v1_capacity_allowance" "project_limit" {
  for_each = var.capacity_limits

  parent_id               = var.parent_id
  name                    = "${var.name}-${var.stage}-cbg-${each.key}"
  capacity_block_group_id = each.value.capacity_block_group_id
  limit                   = each.value.limit
  labels                  = local.labels

  lifecycle {
    precondition {
      condition     = each.value.limit <= local.stage_gpu_ceiling
      error_message = "capacity_limits.${each.key}.limit (${each.value.limit} GPUs) exceeds what stage ${var.stage} may ever plan (${local.stage_gpu_ceiling} = sum of max_gpu_nodes x 8, platform/stages.yaml). Change the stage policy first."
    }
  }
}

data "nebius_quotas_v1_quota_allowance" "watch" {
  for_each = toset(var.quota_watch)

  by_name_in_region = {
    name      = each.key
    parent_id = var.parent_id
    region    = var.region
  }
}
