# Overrides applied after the upstream example terraform.tfvars (Terraform: last -var-file wins).
# Everything not listed here keeps the upstream value at tag soperator-v4.1.13-2.
#
# This is the LAB PROFILE: the smallest cluster the recipe's own validation accepts, shaped after
# the configuration that ran live on 2026-10-08 (docs/evidence/raw/2026-10-08-soperator-4.1.13, run 7:
# apply -> sbatch on a CPU worker -> destroy, 43 min). The example's defaults are production-sized
# (3,720 GiB IO_M3 NFS, accounting DB, telemetry stack, 16-vCPU controller, a GPU cluster) and
# fail mid-apply on an ordinary project quota; see docs/capacity.md ("Quotas per stack").

company_name = "nip"
production   = false

slurm_operator_version = "4.1.13"
slurm_operator_stable  = true

# The release supports Kubernetes 1.32-1.35 only (driver_presets.tf); the Managed Kubernetes
# default is 1.36, so the version is pinned here and asserted by tests/overrides.tftest.hcl.
k8s_version = "1.35"

# ---- shared filesystems ------------------------------------------------------------------------
# The example attaches EXISTING filesystems by placeholder id ("computefilesystem-<YOUR-FILESTORE-ID>"),
# which fails on apply. Create them instead; forbid_deletion stays false for a lab (set true for
# anything a customer keeps; attaching an existing filesystem as the jail overwrites its data).
filestore_jail = {
  spec = {
    size_gibibytes       = 256
    block_size_kibibytes = 4
    forbid_deletion      = false
  }
}
filestore_jail_submounts = [{
  name       = "data"
  mount_path = "/data"
  spec = {
    size_gibibytes       = 64
    block_size_kibibytes = 4
    forbid_deletion      = false
  }
}]
# Still a required variable at this release (deprecated upstream "since 1.22").
filestore_controller_spool = {
  spec = {
    size_gibibytes       = 128
    block_size_kibibytes = 4
    forbid_deletion      = false
  }
}
# Off: the example enables a 3,720 GiB IO_M3 NFS server on a 32-vCPU node. The disk and
# filesystem types are required by the variable's validation even when disabled. Network SSD IO M3
# disks are NOT encrypted unless encryption is enabled at creation (docs: security/encryption,
# compute/storage/types#encryption-of-disks); check the recipe sets it before turning this on.
nfs_in_k8s = {
  enabled         = false
  disk_type       = "NETWORK_SSD_IO_M3"
  filesystem_type = "ext4"
}

# ---- node sets ---------------------------------------------------------------------------------
# system: the recipe enforces min_size >= 3; 8vcpu-32gb is the smallest preset that fits system pods.
slurm_nodeset_system = {
  min_size = 3
  max_size = 3
  resource = { platform = "cpu-d3", preset = "8vcpu-32gb" }
  boot_disk = {
    type                 = "NETWORK_SSD"
    size_gibibytes       = 128
    block_size_kibibytes = 4
  }
}
# controller: 2vcpu-8gb passes the table but leaves slurmctld no CPU after the node reserve.
slurm_nodeset_controller = {
  size     = 1
  resource = { platform = "cpu-d3", preset = "4vcpu-16gb" }
  boot_disk = {
    type                 = "NETWORK_SSD"
    size_gibibytes       = 128
    block_size_kibibytes = 4
  }
}
# login: smallest preset the recipe allows for login nodes; boot disk must be >= 256 GiB.
slurm_nodeset_login = {
  size     = 1
  resource = { platform = "cpu-d3", preset = "16vcpu-64gb" }
  boot_disk = {
    type                 = "NETWORK_SSD"
    size_gibibytes       = 256
    block_size_kibibytes = 4
  }
}
# workers: one CPU worker, no GPU cluster. The recipe requires a GPU cluster (fabric or id) for
# every GPU worker and creates one from a fabric even at size 0, which needs GPU-cluster quota;
# a CPU worker is what ran live. Worker boot disks must be >= 512 GiB at this release.
slurm_nodeset_workers = [
  {
    name        = "cpu"
    size        = 1
    autoscaling = { enabled = false }
    resource    = { platform = "cpu-d3", preset = "8vcpu-32gb" }
    boot_disk = {
      type                 = "NETWORK_SSD"
      size_gibibytes       = 512
      block_size_kibibytes = 4
    }
    node_local_jail_submounts = []
    node_local_image_disk     = { enabled = false }
  },
]
# After a spend approval, replace the worker above with an 8-GPU nodeset, e.g. eu-north1 H100:
#   { name = "gpu", size = 2, autoscaling = { enabled = false },
#     resource = { platform = "gpu-h100-sxm", preset = "8gpu-128vcpu-1600gb" },
#     boot_disk = { type = "NETWORK_SSD", size_gibibytes = 512, block_size_kibibytes = 4 },
#     gpu_cluster = { infiniband_fabric = "fabric-3" },   # (region, platform) fabric: platform/regions.yaml
#     node_local_jail_submounts = [], node_local_image_disk = { enabled = false } }
# and raise the GPU-cluster quota to 1 first.

slurm_nodesets_partitions = [
  { name = "main", is_all = true, config = "Default=YES PriorityTier=10 PreemptMode=OFF MaxTime=INFINITE State=UP OverSubscribe=YES" },
  { name = "hidden", is_all = true, config = "Default=NO PriorityTier=10 PreemptMode=OFF Hidden=YES MaxTime=INFINITE State=UP OverSubscribe=YES" },
]
slurm_shared_memory_size_gibibytes = 8
use_preinstalled_gpu_drivers       = true

# AppArmor: with the recipe default (true) the login and worker pods stayed in CreateContainerError
# on four consecutive live runs because the profile was never loaded on the nodes; false leaves the
# Slurm chart at appArmorProfile: unconfined (docs/soperator-compatibility.md records the trade-off).
use_default_apparmor_profile = false

# The recipe rejects empty SSH keys, so the operator's public key is supplied at
# plan time and never committed:
#   export TF_VAR_slurm_login_ssh_root_public_keys='["ssh-ed25519 AAAA... you@host"]'
slurm_login_public_ip = true

# ---- observability, accounting, backups ----------------------------------------------------------
# telemetry off: the default VictoriaMetrics stack alone requests 6 CPU / 24 GiB and a 558 GiB IO_M3
# volume. Soperator 4.1.13 still renders four ServiceMonitors and the dashboards release with
# telemetry off (the soperator HelmRelease then fails on the missing CRD); overrides/modules/slurm/
# nip_monitoring_override.tf switches them off through the recipe's own values ConfigMaps.
telemetry_enabled      = false
slurm_exporter_enabled = false
public_o11y_enabled    = false
# accounting off: no MariaDB node, no 512 GiB accounting filesystem. Consequence: Soperator creates no
# Slurm REST API, so slurmJob active checks cannot report and the recipe's 240-minute wait would never
# finish; overrides/modules/slurm/nip_activechecks_override.tf skips that wait when accounting is off
# and `sbatch` (runbooks/soperator-jobs.md) is the health gate.
accounting_enabled = false
backups_enabled    = "force_disable"

# The example leaves this empty (""), which the recipe's own validation rejects; "essential" is the
# smallest bootstrap check set (dev | testing | prod_quick | prod_acceptance | essential). Its
# ensure-healthy-nodes check depends on GPU checks the scope disables; the activechecks override
# narrows that dependency the way the recipe already does for GB300.
active_checks_scope = "essential"
