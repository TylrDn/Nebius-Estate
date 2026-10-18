variable "stage" {
  description = "Lifecycle stage this root belongs to (platform/stages.yaml): sandbox, staging or prod. Its GPU caps bound the project limits below (ADR-0009)."
  type        = string

  validation {
    condition     = contains(keys(yamldecode(file("${path.module}/../../../platform/stages.yaml")).stages), var.stage)
    error_message = "stage must be one of the stages in platform/stages.yaml (sandbox, staging, prod)."
  }
}

variable "parent_id" {
  description = "Nebius project ID of the stage (project-...). Pricing policies and project limits both belong to a project."
  type        = string

  validation {
    condition     = startswith(var.parent_id, "project-")
    error_message = "parent_id must be a Nebius project ID (project-...)."
  }
}

variable "region" {
  description = "Region of the stage project (platform/regions.yaml). The project fixes the region; this value only checks that every capped platform is offered there."
  type        = string
  default     = "eu-north1"

  validation {
    condition     = contains(keys(yamldecode(file("${path.module}/../../../platform/regions.yaml")).regions), var.region)
    error_message = "region is not in platform/regions.yaml."
  }
}

variable "name" {
  description = "Name prefix. Resources are named <name>-<stage>-spot-<platform> and <name>-<stage>-cbg-<key>."
  type        = string
  default     = "nip"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,19}$", var.name))
    error_message = "name must be lowercase letters, digits and hyphens, starting with a letter, at most 20 characters."
  }
}

variable "spot_price_caps" {
  description = "Spot price cap per GPU platform: { \"gpu-h100-sxm\" = \"2.500\" }, the max price per GPU-hour in the billing currency as a decimal string with at most 3 decimals (docs: signup-billing/manage-pricing-policy). One nebius_billing_v1_pricing_policy per entry; pass its id to R1/R3 as gpu_spot_pricing_policy_id. {} = no caps (preemptible groups then follow the spot price)."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for p, v in var.spot_price_caps : can(regex("^[0-9]+(\\.[0-9]{1,3})?$", v)) && tonumber(v) > 0])
    error_message = "every spot_price_caps value must be a positive decimal string with at most 3 decimals, e.g. \"2.500\" (provider: max_price, 3 digits precision)."
  }
  validation {
    condition     = alltrue([for p, v in var.spot_price_caps : startswith(p, "gpu-")])
    error_message = "spot_price_caps keys must be GPU platform IDs (gpu-...): pricing policies apply to one GPU platform."
  }
  validation {
    condition = alltrue([
      for p, v in var.spot_price_caps :
      try(yamldecode(file("${path.module}/../../../platform/regions.yaml")).regions[var.region].platforms[p].spot_price_cap, false)
    ])
    error_message = "every spot_price_caps platform must be one the pricing-policy API accepts in var.region (spot_price_cap: true in platform/regions.yaml; L40S has no spot cap, 2026-10-11 live run)."
  }
}

variable "capacity_limits" {
  description = "Project limits on capacity block groups: { <key> = { capacity_block_group_id = \"...\", limit = <GPUs> } }. limit 0 disables CBG use for this project; omit a CBG to leave its effective limit at the CBG size (docs: overview/limits/project-limits). Needs the admin role in the tenant."
  type = map(object({
    capacity_block_group_id = string
    limit                   = number
  }))
  default = {}

  validation {
    condition     = alltrue([for k, v in var.capacity_limits : can(regex("^[a-z0-9][a-z0-9-]{0,29}$", k))])
    error_message = "capacity_limits keys must be lowercase letters, digits and hyphens (at most 30 characters): they become part of the resource name."
  }
  validation {
    condition     = alltrue([for k, v in var.capacity_limits : length(trimspace(v.capacity_block_group_id)) > 0])
    error_message = "every capacity_limits entry needs a capacity_block_group_id (nebius capacity capacity-block-group list)."
  }
  validation {
    condition     = alltrue([for k, v in var.capacity_limits : v.limit >= 0 && floor(v.limit) == v.limit])
    error_message = "capacity_limits limit must be a whole number of GPUs, 0 or more (0 disables CBG use for the project)."
  }
}

variable "quota_watch" {
  description = "Quota names to read in the stage project and region, e.g. [\"compute.instance.gpu.h100\"]. Read-only data sources; the API returns usage but has omitted the limit (docs/solutions/gaps-and-discrepancies.md), so read limits in the console."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for q in var.quota_watch : can(regex("^[a-z0-9][a-z0-9.-]+$", q))])
    error_message = "quota_watch entries are quota names such as compute.instance.gpu.h100."
  }
}

variable "labels" {
  description = "Labels applied to every resource (docs/cost.md). nip-run is required; nip-ttl-expires where the stage requires it; nip-region, nip-stage and nip-stack are added automatically (nip-env, deprecated, defaults to the stack)."
  type        = map(string)
  default = {
    "nip-env"   = "governance"
    "nip-owner" = "platform"
  }

  validation {
    condition     = try(length(var.labels["nip-run"]) > 0, false)
    error_message = "labels must carry nip-run (a ticket, date or run id) so leftovers can be attributed (docs/cost.md)."
  }
  validation {
    condition     = !yamldecode(file("${path.module}/../../../platform/stages.yaml")).stages[var.stage].policy.require_ttl_label || (can(regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$", lookup(var.labels, "nip-ttl-expires", ""))) && can(formatdate("YYYY", lookup(var.labels, "nip-ttl-expires", ""))))
    error_message = "this stage requires labels[\"nip-ttl-expires\"] as an RFC 3339 UTC timestamp, e.g. 2026-10-31T18:00:00Z (docs/cost.md)."
  }
}
