# Stage policy (platform/stages.yaml, ADR-0009) resolved and checked once for every stack.
# A stack passes its effective settings; the module returns the resolved values and the list of
# violations. Each stack asserts `violations == []` in one precondition, so a prod root cannot be
# planned with sandbox settings and every rule lives here, not copied per stack.

locals {
  policy = yamldecode(file("${path.module}/../../../platform/stages.yaml")).stages[var.stage].policy

  etcd_cluster_size = coalesce(var.etcd_cluster_size, local.policy.etcd_cluster_size)
  public_endpoint   = var.public_endpoint == null ? local.policy.public_endpoint : var.public_endpoint
  audit_logs        = var.audit_logs == null ? local.policy.audit_logs : var.audit_logs
  forbid_deletion   = var.forbid_deletion == null ? local.policy.forbid_deletion : var.forbid_deletion
  alertmanager      = var.alertmanager == null ? local.policy.alertmanager : var.alertmanager

  # Kubernetes versions the docs accept, newest last; the stage offset sets how far behind a stage may run.
  k8s_versions    = yamldecode(file("${path.module}/../../../platform/regions.yaml")).kubernetes_versions
  k8s_version_max = local.k8s_versions[length(local.k8s_versions) - 1 - local.policy.k8s_version_offset]

  # Sandbox TTL window, measured at plan time: in the future and at most ttl_max_hours ahead
  # (plantimestamp is the plan's own clock; a re-plan at apply measures again). The shape of the
  # label is each stack's variable validation; an unparsable value is left to it here.
  ttl_max_hours = 168
  ttl_in_window = var.ttl_expires == null ? true : try(timecmp(var.ttl_expires, plantimestamp()) > 0 && timecmp(var.ttl_expires, timeadd(plantimestamp(), "${local.ttl_max_hours}h")) <= 0, true)

  gpu_cap           = lookup(local.policy.max_gpu_nodes, var.stack, 0)
  strict_required   = lookup(local.policy.require_strict_reservation, var.stack, false)
  documentation_net = ["192.0.2.", "198.51.100.", "203.0.113."] # RFC 5737: never a real allowlist
  placeholder_cidrs = [for c in var.allowed_cidrs : c if anytrue([for p in local.documentation_net : startswith(cidrhost(c, 0), p)])]
  # An entry wider than /8 (0.0.0.0/0, or the two /1 halves) admits most of the internet: no allowlist.
  min_cidr_prefix = 8
  broad_cidrs     = [for c in var.allowed_cidrs : c if try(tonumber(split("/", c)[1]) < local.min_cidr_prefix, true)]

  rules = {
    audit_logs      = { ok = !local.policy.audit_logs || local.audit_logs, msg = "stage ${var.stage} requires control-plane audit logs (policy.audit_logs); audit_logs = false is not allowed here" }
    forbid_deletion = { ok = !local.policy.forbid_deletion || local.forbid_deletion, msg = "stage ${var.stage} requires deletion protection on data volumes (policy.forbid_deletion)" }
    alerting        = { ok = !var.has_cluster || !local.policy.alertmanager || (var.enable_o11y && local.alertmanager), msg = "stage ${var.stage} requires alerting (policy.alertmanager): keep enable_o11y = true and alertmanager_enabled unset or true" }
    # A request may tighten the stage's etcd size, never shrink it (staging and prod: 3).
    etcd          = { ok = !var.has_cluster || local.etcd_cluster_size >= local.policy.etcd_cluster_size, msg = "stage ${var.stage} requires etcd_cluster_size = ${local.policy.etcd_cluster_size} (policy.etcd_cluster_size); a request may raise it, never lower it" }
    ttl_window    = { ok = !local.policy.require_ttl_label || local.ttl_in_window, msg = "stage ${var.stage} needs labels[\"nip-ttl-expires\"] in the future and at most ${local.ttl_max_hours / 24} days ahead of the plan (got ${coalesce(var.ttl_expires, "none")}); set a new expiry for this run (docs/cost.md)" }
    gpu_cap       = { ok = var.gpu_node_count <= local.gpu_cap, msg = "stage ${var.stage} caps gpu_node_count for ${var.stack} at ${local.gpu_cap} (policy.max_gpu_nodes); raise the policy deliberately" }
    preemptible   = { ok = local.policy.allow_preemptible_serving || !var.gpu_preemptible, msg = "stage ${var.stage} does not allow preemptible GPU nodes (ADR-0007: interruptions are for checkpointed sweeps, not production runs)" }
    allowed_cidrs = { ok = !var.has_public_endpoint_control || !local.policy.require_allowed_cidrs || !local.public_endpoint || length(var.allowed_cidrs) > 0, msg = "stage ${var.stage} allows a public endpoint only behind allowed_cidrs (or set public_endpoint = false and work from inside the VPC)" }
    narrow_cidrs  = { ok = !(local.policy.require_allowed_cidrs || var.public_bastion) || length(local.broad_cidrs) == 0, msg = "allowed_cidrs entries must be /${local.min_cidr_prefix} or narrower where an allowlist is required (and for a public bastion in every stage); ${join(", ", local.broad_cidrs)} admits most of the internet" }
    # "A request may tighten the stage policy, never loosen it": where the stage keeps the
    # control-plane endpoint private (prod), public_endpoint = true is refused, allowlist or not.
    private_endpoint = { ok = !var.has_public_endpoint_control || local.policy.public_endpoint || !local.public_endpoint, msg = "stage ${var.stage} keeps the control-plane endpoint private (policy.public_endpoint = false); public_endpoint = true is not allowed here, reach the API from inside the VPC" }
    real_cidrs       = { ok = !local.policy.require_allowed_cidrs || length(local.placeholder_cidrs) == 0, msg = "allowed_cidrs contains documentation ranges (${join(", ", local.placeholder_cidrs)}); set your office/VPN egress CIDRs, e.g. TF_VAR_allowed_cidrs='[\"x.x.x.x/32\"]'" }
    k8s_pinned       = { ok = !var.has_cluster || !local.policy.k8s_version_pinned || var.k8s_version != null, msg = "stage ${var.stage} requires an explicit k8s_version (runbooks/upgrade.md)" }
    k8s_window       = { ok = var.k8s_version == null ? true : index(local.k8s_versions, var.k8s_version) <= index(local.k8s_versions, local.k8s_version_max), msg = "stage ${var.stage} runs at most Kubernetes ${local.k8s_version_max} (k8s_version_offset ${local.policy.k8s_version_offset}; runbooks/upgrade.md)" }
    reservation      = { ok = !local.strict_required || var.gpu_node_count == 0 || var.gpu_reservation_policy == "STRICT", msg = "stage ${var.stage} runs ${var.stack} GPU nodes on a STRICT capacity reservation only (runbooks/capacity-request.md)" }
    # Every stage, sandbox included: a public bastion port is never open to the whole internet.
    bastion = { ok = !var.public_bastion || length(var.allowed_cidrs) > 0, msg = "a public bastion needs allowed_cidrs in every stage: its WireGuard port is never open to the internet" }
  }
}
