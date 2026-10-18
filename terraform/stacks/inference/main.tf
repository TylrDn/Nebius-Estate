# Layer 1 + 2 — Infrastructure and platform for the R1 inference lab.
#
# Provision: subnet lookup -> cluster -> CPU node group -> GPU node group
#            (managed driver image) -> Filestore + CSI
# Enable:    NVIDIA device plugin (+DCGM) -> Prometheus/Grafana -> Nebius agent
# Run/Operate: workloads/inference (kubectl), tests/validate, runbooks/
#
# Sizing here is a lab example, not a recommendation (P7).

locals {
  # <prefix>-<stage>-<stack> (docs/naming.md); every stage's tfvars sets the same value explicitly.
  cluster_name = coalesce(var.cluster_name, "nip-${var.stage}-inference")
  # Stage policy (platform/stages.yaml, ADR-0009) is resolved and checked by modules/stage-policy.
  etcd_cluster_size = module.stage_policy.etcd_cluster_size
  public_endpoint   = module.stage_policy.public_endpoint
  audit_logs        = module.stage_policy.audit_logs
  forbid_deletion   = module.stage_policy.forbid_deletion
  alertmanager      = module.stage_policy.alertmanager
  # With autoscaling the stage cap applies to the group's maximum size.
  gpu_max_nodes = var.gpu_autoscaling == null ? var.gpu_node_count : var.gpu_autoscaling.max
  # Alerting rules shared by every stage: one file per concern under platform/alerts/.
  alerting_rules = { groups = flatten([for f in sort(fileset("${path.module}/../../../platform/alerts", "*.yaml")) : yamldecode(file("${path.module}/../../../platform/alerts/${f}")).groups]) }
  # Region and stage ride along on every resource label so cost reports and the
  # post-destroy residue check (scripts/leftovers.sh --stage) can filter by them.
  labels = merge({ "nip-env" = "inference" }, var.labels, { "nip-region" = var.region, "nip-stage" = var.stage, "nip-stack" = "inference" })

  # Reservation: null in the API means AUTO, which draws on any matching capacity block group in the
  # tenant (docs kubernetes/node-groups/reservations). A regular GPU group without an explicit
  # gpu_reservation is therefore pinned to the common pool with FORBID; preemptible groups take none.
  gpu_reservation = var.gpu_reservation != null ? var.gpu_reservation : (var.gpu_preemptible ? null : { policy = "FORBID", reservation_ids = [] })

  # Compute instance metadata labels on every node (template.instance_metadata.labels). Set at
  # creation: changing them recreates the nodes (docs kubernetes/logs#how-to-enable-journald-logs).
  # The per-run nip-run / nip-ttl-expires change every sandbox run, so they stay on the node group
  # resource only; copying them would recreate every node on each run.
  gpu_taints = var.cpu_node_count > 0 ? [{ key = "nvidia.com/gpu", value = "present", effect = "NO_SCHEDULE" }] : []

  instance_metadata_labels = merge(
    var.propagate_cost_labels ? { for k, v in local.labels : k => v if !contains(["nip-run", "nip-ttl-expires"], k) } : {},
    var.journald_logs ? {
      "nebius.o11y.systemd-logs-collection.enabled" = "true"
      "nebius.o11y.systemd-logs-collection.units"   = var.journald_units
    } : {},
  )

  # Region -> platform -> preset table shared by every root (platform/regions.yaml,
  # sourced from the Nebius docs). Override with gpu_platform / gpu_preset.
  regions      = yamldecode(file("${path.module}/../../../platform/regions.yaml")).regions
  region       = local.regions[var.region]
  gpu_platform = coalesce(var.gpu_platform, local.region.default)
  platform     = lookup(local.region.platforms, local.gpu_platform, null)
  gpu_preset   = var.gpu_preset != null ? var.gpu_preset : try(local.platform.single_gpu_preset, "unknown")
  # The driver image must match the platform (platform/regions.yaml: cuda13.0 everywhere; the B200
  # 1-GPU preset needs driver 580.x); an explicit preset wins.
  gpu_drivers_preset = coalesce(var.gpu_drivers_preset, try(local.platform.drivers_preset, "cuda13.0"))
}

# The platform must be one the region offers; otherwise the preset default is unknown.
resource "terraform_data" "platform_check" {
  lifecycle {
    precondition {
      condition     = local.platform != null
      error_message = "Platform ${local.gpu_platform} is not listed for ${var.region} in platform/regions.yaml; pick one of ${join(", ", keys(local.region.platforms))} or add it there with its presets."
    }
  }
}

module "stage_policy" {
  source = "../../modules/stage-policy"

  stage                  = var.stage
  ttl_expires            = lookup(var.labels, "nip-ttl-expires", null)
  stack                  = "inference"
  etcd_cluster_size      = var.etcd_cluster_size
  public_endpoint        = var.public_endpoint
  audit_logs             = var.audit_logs
  forbid_deletion        = var.filestore_forbid_deletion
  alertmanager           = var.alertmanager_enabled
  enable_o11y            = var.enable_o11y
  gpu_node_count         = local.gpu_max_nodes
  gpu_preemptible        = var.gpu_preemptible
  gpu_reservation_policy = try(var.gpu_reservation.policy, "")
  allowed_cidrs          = var.allowed_cidrs
  k8s_version            = var.k8s_version
}

# Stage policy enforced at plan time (ADR-0009): the error lists every rule the settings break.
resource "terraform_data" "stage_policy" {
  lifecycle {
    precondition {
      condition     = length(module.stage_policy.violations) == 0
      error_message = "stage ${var.stage} policy (platform/stages.yaml): ${join("; ", module.stage_policy.violations)}."
    }
  }
}

module "network" {
  source = "../../modules/network"

  parent_id   = var.parent_id
  subnet_id   = var.subnet_id
  subnet_name = var.subnet_name
}

module "cluster" {
  source = "../../modules/mk8s-cluster"

  parent_id         = var.parent_id
  name              = local.cluster_name
  subnet_id         = module.network.subnet_id
  service_cidr      = var.service_cidr
  k8s_version       = var.k8s_version
  etcd_cluster_size = local.etcd_cluster_size
  public_endpoint   = local.public_endpoint
  allowed_cidrs     = var.allowed_cidrs
  audit_logs        = local.audit_logs
  labels            = local.labels
}

module "filestore" {
  source = "../../modules/filestore"
  count  = var.enable_filestore ? 1 : 0

  parent_id       = var.parent_id
  name            = "${local.cluster_name}-shared-fs"
  size_gib        = var.filestore_size_gib
  mount_path      = var.filestore_mount_path
  forbid_deletion = local.forbid_deletion
  labels          = local.labels

  existing_filesystem_id = var.existing_filesystem_id
}

# No CPU node group while cpu_node_count = 0 (for example a project whose non-GPU vCPU quota is 0):
# the GPU node then hosts the system add-ons, so it is created without its NoSchedule taint.
module "cpu_nodes" {
  count  = var.cpu_node_count > 0 ? 1 : 0
  source = "../../modules/node-group"

  cluster_id         = module.cluster.id
  name               = "${local.cluster_name}-ng-cpu"
  k8s_version        = var.k8s_version
  platform           = var.cpu_platform
  preset             = var.cpu_preset
  fixed_node_count   = var.cpu_node_count
  subnet_id          = module.network.subnet_id
  security_group_ids = var.security_group_ids
  boot_disk_size_gib = 128
  filesystem         = var.enable_filestore ? module.filestore[0].attachment : null
  ssh_public_key     = var.ssh_public_key
  labels             = local.labels

  service_account_id       = var.node_service_account_id
  instance_metadata_labels = local.instance_metadata_labels
}

# R3-8: no GPU node group at all while gpu_node_count = 0. The docs never show a node group with
# fixed_node_count = 0, and mocks cannot prove the API accepts it, so plan-only roots create none.
module "gpu_nodes" {
  count  = local.gpu_max_nodes > 0 ? 1 : 0
  source = "../../modules/node-group"

  cluster_id             = module.cluster.id
  name                   = "${local.cluster_name}-ng-gpu"
  k8s_version            = var.k8s_version
  platform               = local.gpu_platform
  preset                 = local.gpu_preset
  fixed_node_count       = var.gpu_autoscaling == null ? var.gpu_node_count : null
  autoscaling            = var.gpu_autoscaling
  subnet_id              = module.network.subnet_id
  boot_disk_size_gib     = var.gpu_boot_disk_size_gib
  drivers_preset         = local.gpu_drivers_preset
  preemptible            = var.gpu_preemptible
  spot_pricing_policy_id = var.gpu_spot_pricing_policy_id
  reservation            = local.gpu_reservation
  security_group_ids     = var.security_group_ids
  rollout_surge          = var.gpu_rollout_surge
  filesystem             = var.enable_filestore ? module.filestore[0].attachment : null
  ssh_public_key         = var.ssh_public_key
  labels                 = local.labels

  service_account_id       = var.node_service_account_id
  instance_metadata_labels = local.instance_metadata_labels

  node_labels = {
    "nip.nebius.io/gpu" = "true"
  }
  taints = local.gpu_taints
}

# ---- Layer 2: platform ------------------------------------------------------

# Order: filesystem -> node groups (mount it) -> CSI driver (needs schedulable nodes).
module "filestore_csi" {
  source = "../../modules/filestore-csi"
  count  = var.enable_filestore ? 1 : 0

  mount_path = var.filestore_mount_path

  depends_on = [module.cpu_nodes, module.gpu_nodes]
}

module "device_plugin" {
  source = "../../modules/device-plugin"

  parent_id             = var.parent_id
  cluster_id            = module.cluster.id
  dcgm_exporter_enabled = true

  depends_on = [module.gpu_nodes]
}

module "o11y" {
  source = "../../modules/o11y"
  count  = var.enable_o11y ? 1 : 0

  parent_id                  = var.parent_id
  cluster_id                 = module.cluster.id
  prometheus_enabled         = true
  nebius_agent_enabled       = var.enable_nebius_agent
  retention                  = "7d"
  alertmanager_enabled       = local.alertmanager
  alertmanager_config_secret = var.alertmanager_config_secret
  alertmanager_config        = var.alertmanager_config
  alerting_rules             = local.alerting_rules

  # The Nebius data sources of R14's Grafana file, provisioned in the in-cluster Grafana once a
  # Secret with an OBSERVABILITY static key is named (otherwise the plan warns; runbooks/observability.md).
  grafana_datasources             = yamldecode(file("${path.module}/../../../recipes/observability/grafana/datasources.yaml")).datasources
  grafana_datasource_token_secret = var.grafana_datasource_token_secret

  # Grafana admin password from SecretStash (write-only, never in plan or state) or, without a
  # secret id, generated and kept in state (modules/o11y).
  grafana_admin_secret_id         = var.grafana_admin_secret_id
  grafana_admin_secret_version_id = var.grafana_admin_secret_version_id
  grafana_admin_password          = var.grafana_admin_password

  # After the CSI driver: the default StorageClass is settled before Prometheus binds its PVC.
  depends_on = [module.cpu_nodes, module.filestore_csi]
}

