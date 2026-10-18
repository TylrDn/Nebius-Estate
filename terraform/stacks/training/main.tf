# Layer 1 + 2 — Infrastructure and platform for the R3 distributed-training
# environment: 8-GPU nodes in an InfiniBand GPU cluster on the managed driver image
# plus the device plugin (ADR-0003, the docs' own InfiniBand example). The
# Network Operator -> GPU Operator path is opt-in (enable_gpu_operator) for MIG,
# CDI or a custom device plugin; the docs require the Network Operator only for
# node groups WITHOUT the driver image.
#
# PLAN-ONLY BY DEFAULT: gpu_node_count = 0. Raising it is a separate, reviewed
# change gated on spend approval (P7). Sizing is an example, not a recommendation.

locals {
  # <prefix>-<stage>-<stack> (docs/naming.md); every stage's tfvars sets the same value explicitly.
  cluster_name = coalesce(var.cluster_name, "nip-${var.stage}-training")
  # Stage policy (platform/stages.yaml, ADR-0009) is resolved and checked by modules/stage-policy.
  etcd_cluster_size = module.stage_policy.etcd_cluster_size
  public_endpoint   = module.stage_policy.public_endpoint
  audit_logs        = module.stage_policy.audit_logs
  forbid_deletion   = module.stage_policy.forbid_deletion
  alertmanager      = module.stage_policy.alertmanager
  # Alerting rules shared by every stage: one file per concern under platform/alerts/.
  alerting_rules = { groups = flatten([for f in sort(fileset("${path.module}/../../../platform/alerts", "*.yaml")) : yamldecode(file("${path.module}/../../../platform/alerts/${f}")).groups]) }
  labels         = merge({ "nip-env" = "training" }, var.labels, { "nip-region" = var.region, "nip-stage" = var.stage, "nip-stack" = "training" })

  # Reservation: null in the API means AUTO, which draws on any matching capacity block group in the
  # tenant (docs kubernetes/node-groups/reservations). A regular GPU group without an explicit
  # gpu_reservation is therefore pinned to the common pool with FORBID; preemptible groups take none.
  gpu_reservation = var.gpu_reservation != null ? var.gpu_reservation : (var.gpu_preemptible ? null : { policy = "FORBID", reservation_ids = [] })

  # Compute instance metadata labels on every node (template.instance_metadata.labels). Set at
  # creation: changing them recreates the nodes (docs kubernetes/logs#how-to-enable-journald-logs).
  # The per-run nip-run / nip-ttl-expires change every sandbox run, so they stay on the node group
  # resource only; copying them would recreate every node on each run.
  instance_metadata_labels = merge(
    var.propagate_cost_labels ? { for k, v in local.labels : k => v if !contains(["nip-run", "nip-ttl-expires"], k) } : {},
    var.journald_logs ? {
      "nebius.o11y.systemd-logs-collection.enabled" = "true"
      "nebius.o11y.systemd-logs-collection.units"   = var.journald_units
    } : {},
  )

  # Region -> platform -> preset/fabric table shared by every root (platform/regions.yaml,
  # sourced from the Nebius docs; a fabric accepts exactly one GPU platform).
  regions      = yamldecode(file("${path.module}/../../../platform/regions.yaml")).regions
  region       = local.regions[var.region]
  gpu_platform = coalesce(var.gpu_platform, local.region.default)
  platform     = lookup(local.region.platforms, local.gpu_platform, null)
  # Default preset: the platform's 8-GPU preset; without a GPU cluster its single-GPU preset
  # is acceptable too (L40S has no 8-GPU preset at all). null = nothing usable, caught below.
  gpu_preset        = var.gpu_preset != null ? var.gpu_preset : try(local.platform.ib_preset, var.enable_gpu_cluster ? null : try(local.platform.single_gpu_preset, null))
  default_fabric    = try(local.platform.fabric, null)
  infiniband_fabric = var.enable_gpu_cluster ? try(coalesce(var.infiniband_fabric, local.default_fabric), null) : null
  # The driver image must match the platform (platform/regions.yaml: cuda13.0 everywhere; the B200
  # 1-GPU preset needs driver 580.x); an explicit preset wins.
  gpu_drivers_preset = coalesce(var.gpu_drivers_preset, try(local.platform.drivers_preset, "cuda13.0"))
}

module "stage_policy" {
  source = "../../modules/stage-policy"

  stage                  = var.stage
  ttl_expires            = lookup(var.labels, "nip-ttl-expires", null)
  stack                  = "training"
  etcd_cluster_size      = var.etcd_cluster_size
  public_endpoint        = var.public_endpoint
  audit_logs             = var.audit_logs
  forbid_deletion        = var.filestore_forbid_deletion
  alertmanager           = var.alertmanager_enabled
  enable_o11y            = var.enable_o11y
  gpu_node_count         = var.gpu_node_count
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

# No silent mismatch: the platform must be listed for the region, and an explicit
# fabric is required when the table has none for (region, platform).
resource "terraform_data" "fabric_check" {
  lifecycle {
    precondition {
      condition     = local.platform != null
      error_message = "Platform ${local.gpu_platform} is not listed for ${var.region} in platform/regions.yaml; pick one of ${join(", ", keys(local.region.platforms))} or add it there."
    }
    precondition {
      condition     = local.gpu_preset != null
      error_message = "No default preset for ${local.gpu_platform} in ${var.region} (platform/regions.yaml has no 8-GPU preset for it); set gpu_preset explicitly."
    }
    precondition {
      condition     = !var.enable_gpu_cluster || var.infiniband_fabric != null || local.default_fabric != null
      error_message = "No InfiniBand fabric is known for ${var.region}/${local.gpu_platform}; set infiniband_fabric explicitly (see https://docs.nebius.com/compute/clusters/gpu) or enable_gpu_cluster = false."
    }
  }
}

module "gpu_cluster" {
  source = "../../modules/gpu-cluster"
  # Only when the fabric is known (the precondition above reports the gap) AND a GPU
  # node is actually requested: the plan-only default must not hold GPU-cluster quota.
  count = var.enable_gpu_cluster && local.infiniband_fabric != null && var.gpu_node_count > 0 ? 1 : 0

  parent_id         = var.parent_id
  name              = "${local.cluster_name}-${coalesce(local.infiniband_fabric, "none")}"
  infiniband_fabric = coalesce(local.infiniband_fabric, "none")
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

module "cpu_nodes" {
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
  count  = var.gpu_node_count > 0 ? 1 : 0
  source = "../../modules/node-group"

  cluster_id             = module.cluster.id
  name                   = "${local.cluster_name}-ng-gpu"
  k8s_version            = var.k8s_version
  platform               = local.gpu_platform
  preset                 = coalesce(local.gpu_preset, "unset") # null is rejected by fabric_check first
  fixed_node_count       = var.gpu_node_count
  subnet_id              = module.network.subnet_id
  boot_disk_size_gib     = var.gpu_boot_disk_size_gib
  drivers_preset         = var.enable_gpu_operator ? null : local.gpu_drivers_preset # ADR-0003
  gpu_cluster_id         = try(module.gpu_cluster[0].id, null)
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
    "nip.nebius.io/gpu"        = "true"
    "nip.nebius.io/infiniband" = tostring(var.enable_gpu_cluster && var.gpu_node_count > 0)
  }
  taints = [
    { key = "nvidia.com/gpu", value = "present", effect = "NO_SCHEDULE" }
  ]
}

# ---- Layer 2: platform ---------------------------------------------------------

# filesystem -> node groups (mount it) -> CSI driver (needs schedulable nodes).
module "filestore_csi" {
  source = "../../modules/filestore-csi"
  count  = var.enable_filestore ? 1 : 0

  mount_path = var.filestore_mount_path

  depends_on = [module.cpu_nodes, module.gpu_nodes]
}

# Default path: the device plugin (+ DCGM exporter) on top of the managed driver image.
module "device_plugin" {
  source = "../../modules/device-plugin"
  count  = var.enable_gpu_operator ? 0 : 1

  parent_id             = var.parent_id
  cluster_id            = module.cluster.id
  dcgm_exporter_enabled = true

  depends_on = [module.gpu_nodes]
}

# Opt-in operator path (no driver image on the nodes): Network Operator first, wait
# for its OFED state, then the GPU Operator (docs/kubernetes/gpu/set-up).
module "network_operator" {
  source = "../../modules/network-operator"
  count  = var.enable_gpu_operator ? 1 : 0

  parent_id  = var.parent_id
  cluster_id = module.cluster.id

  depends_on = [module.cpu_nodes, module.gpu_nodes]
}

# depends_on only orders the creates; the docs say to install the GPU Operator once the
# NicClusterPolicy reports state-OFED ready, so this gate polls it (scripts/wait-for-ofed.sh).
resource "terraform_data" "ofed_ready" {
  count = var.enable_gpu_operator ? 1 : 0

  triggers_replace = [module.network_operator[0].release_id]

  # The script authenticates with the token Terraform runs on: the local-exec inherits
  # TF_VAR_iam_token from Terraform's environment and the script hands it to the CLI as
  # NEBIUS_IAM_TOKEN, so it also works in CI, where no CLI profile exists (R13 / key path alike).
  provisioner "local-exec" {
    command = "${path.module}/../../../scripts/wait-for-ofed.sh ${module.cluster.id}"
  }

  depends_on = [module.network_operator]
}

module "gpu_operator" {
  source = "../../modules/gpu-operator"
  count  = var.enable_gpu_operator ? 1 : 0

  parent_id            = var.parent_id
  cluster_id           = module.cluster.id
  enable_dcgm_exporter = true
  mig_strategy         = var.mig_strategy
  driver_version       = coalesce(var.gpu_operator_driver_version, try(local.platform.operator_driver_version, "chart-default")) == "chart-default" ? null : coalesce(var.gpu_operator_driver_version, try(local.platform.operator_driver_version, "chart-default"))

  depends_on = [terraform_data.ofed_ready]
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

