variable "stage" {
  description = "Lifecycle stage this root belongs to (platform/stages.yaml): sandbox, staging or prod. Selects the policy the stack enforces at plan time (ADR-0009)."
  type        = string

  validation {
    condition     = contains(keys(yamldecode(file("${path.module}/../../../platform/stages.yaml")).stages), var.stage)
    error_message = "stage must be one of the stages in platform/stages.yaml (sandbox, staging, prod)."
  }
}

variable "parent_id" {
  description = "Nebius project ID that owns every training resource (project-...)."
  type        = string

  validation {
    condition     = startswith(var.parent_id, "project-")
    error_message = "parent_id must be a Nebius project ID (project-...)."
  }
}

variable "region" {
  description = "Nebius region. Drives the GPU platform, 8-GPU preset and InfiniBand fabric defaults (platform/regions.yaml)."
  type        = string
  default     = "eu-north1"

  validation {
    condition     = contains(keys(yamldecode(file("${path.module}/../../../platform/regions.yaml")).regions), var.region)
    error_message = "region is not in platform/regions.yaml; add it there (with its GPU platforms, presets and fabrics) before using it."
  }
}

variable "cluster_name" {
  description = "Name prefix for the managed Kubernetes cluster, node groups, GPU cluster and filesystem. null = nip-<stage>-training (docs/naming.md): node group and filesystem names are unique in the whole tenant, so the stage is always in them. Names are fixed at creation: changing this replaces the cluster."
  type        = string
  default     = null

  validation {
    condition     = var.cluster_name == null || can(regex("^[a-z][a-z0-9-]{0,39}$", var.cluster_name))
    error_message = "cluster_name must be lowercase letters, digits and hyphens, starting with a letter, at most 40 characters (docs/naming.md)."
  }
}

variable "subnet_id" {
  description = "VPC subnet ID for the cluster: the project's default subnet (exported as TF_VAR_subnet_id by `source scripts/bootstrap-backend.sh`) or, with R7, the network stack's subnet_id output. null = look up subnet_name, which has no default."
  type        = string
  default     = null
}

variable "subnet_name" {
  description = "Name of an existing subnet to look up when subnet_id is null. No default: real default subnets are named default-subnet-<suffix>, so pass subnet_id instead (`source scripts/bootstrap-backend.sh` exports the project's default subnet as TF_VAR_subnet_id; with R7, use the network stack's subnet_id output)."
  type        = string
  default     = null
}

variable "service_cidr" {
  description = "Kubernetes Service range reserved inside the cluster subnet (CIDR or prefix such as \"/20\"). null = the API default /16, which fits the project's default subnet but not R7's workload subnet: pass the network stack's service_cidr output with its subnet_id."
  type        = string
  default     = null

  validation {
    condition     = var.service_cidr == null || can(regex("^(\\d+\\.\\d+\\.\\d+\\.\\d+)?/(1[2-9]|2[0-8])$", coalesce(var.service_cidr, "x")))
    error_message = "service_cidr must be a CIDR or prefix length between /12 and /28 (kubernetes/networking/requirements)."
  }
}

variable "k8s_version" {
  description = "Kubernetes control-plane version. null = the Managed Kubernetes default (1.36 at verification). Pin it explicitly; versions below 1.34 are end-of-life (https://docs.nebius.com/kubernetes/versions)."
  type        = string
  default     = null

  validation {
    condition     = var.k8s_version == null || contains(yamldecode(file("${path.module}/../../../platform/regions.yaml")).kubernetes_versions, coalesce(var.k8s_version, "x"))
    error_message = "k8s_version must be one of the versions Managed Kubernetes accepts for new clusters (platform/regions.yaml: kubernetes_versions)."
  }
}

variable "etcd_cluster_size" {
  description = "etcd member count for the control plane; null = the stage policy (platform/stages.yaml). Keep 3 anywhere that outlives a session: the control plane has no price line and a single member is unavailable during upgrades."
  type        = number
  default     = null

  validation {
    condition     = var.etcd_cluster_size == null || contains([1, 3], coalesce(var.etcd_cluster_size, 0))
    error_message = "etcd_cluster_size must be 1 or 3."
  }
}

variable "public_endpoint" {
  description = "Expose the control plane on a public endpoint; null = the stage policy (platform/stages.yaml: on for sandbox/staging, off for prod). With a private endpoint Terraform and kubectl must run on a VM in the cluster's subnet (https://docs.nebius.com/kubernetes/connect)."
  type        = bool
  default     = null
}

variable "cpu_platform" {
  description = "Platform of the CPU node group (system add-ons). Must be a cpu-* platform: this group is outside the stage GPU caps (platform/stages.yaml), so it never carries GPUs."
  type        = string
  default     = "cpu-d3"

  validation {
    condition     = startswith(var.cpu_platform, "cpu-")
    error_message = "cpu_platform must be a cpu-* platform (e.g. cpu-d3); GPU nodes belong in the GPU group, where the stage policy caps them."
  }
}

variable "cpu_preset" {
  description = "CPU node preset for system add-ons (o11y, CSI, operators)."
  type        = string
  default     = "8vcpu-32gb"

  validation {
    condition     = !can(regex("^[0-9]+gpu-", var.cpu_preset))
    error_message = "cpu_preset must be a CPU preset (e.g. 8vcpu-32gb), not an <n>gpu-* preset; GPU nodes belong in the GPU group, where the stage policy caps them."
  }
}

variable "cpu_node_count" {
  description = "CPU nodes for system add-ons (1 to 16). The CPU group always exists here: it hosts the operators while the GPU group is 0."
  type        = number
  default     = 2

  validation {
    condition     = var.cpu_node_count >= 1 && var.cpu_node_count <= 16 && floor(var.cpu_node_count) == var.cpu_node_count
    error_message = "cpu_node_count must be a whole number from 1 to 16 (system add-ons only; raise the bound by a reviewed change)."
  }
}

variable "gpu_platform" {
  description = "GPU platform; null = the region's default in platform/regions.yaml (gpu-h100-sxm in eu-north1, gpu-b300-sxm in uk-south1/eu-west2/us-north1, gpu-b200-sxm in us-central1 when chosen)."
  type        = string
  default     = null
}

variable "gpu_preset" {
  description = "GPU preset; null = the platform's 8-GPU preset from platform/regions.yaml (8gpu-128vcpu-1600gb H100/H200, 8gpu-160vcpu-1792gb B200, 8gpu-192vcpu-2768gb B300). Must be 8gpu-* when enable_gpu_cluster = true."
  type        = string
  default     = null

  validation {
    condition     = !var.enable_gpu_cluster || var.gpu_preset == null || startswith(coalesce(var.gpu_preset, "8gpu-"), "8gpu-")
    error_message = "An InfiniBand GPU cluster requires an 8-GPU preset. Set enable_gpu_cluster = false for single-GPU presets."
  }
}

variable "gpu_node_count" {
  description = "Number of 8-GPU nodes. 0 = plan-only (default). 2 is the minimum for a multi-node NCCL test; the stage policy caps it (sandbox 4, staging 8, prod 32)."
  type        = number
  default     = 0

  validation {
    condition     = var.gpu_node_count >= 0 && var.gpu_node_count <= 32
    error_message = "gpu_node_count is capped at 32 (256 GPUs) by this stack; the stage policy (platform/stages.yaml) caps it lower outside prod."
  }
}

variable "gpu_boot_disk_size_gib" {
  type    = number
  default = 1023 # upstream default; operator-managed drivers + container caches
}

variable "gpu_rollout_surge" {
  description = "Create the replacement GPU node before draining the old one on template changes (needs quota for one extra GPU node). Off by default: the group is replaced one 8-GPU node at a time, without extra quota."
  type        = bool
  default     = false
}

variable "gpu_spot_pricing_policy_id" {
  description = "Spot pricing policy (price cap) for a preemptible GPU node group; null = follow the spot price (ADR-0007)."
  type        = string
  default     = null
}

variable "gpu_preemptible" {
  type    = bool
  default = false
}

variable "enable_gpu_cluster" {
  description = "Place GPU nodes in an InfiniBand GPU cluster (required for multi-node NCCL at IB speed)."
  type        = bool
  default     = true
}

variable "infiniband_fabric" {
  description = "null = the (region, platform) default from platform/regions.yaml (fabric-3 for H100 in eu-north1, uk-south1-a for B300, ...)."
  type        = string
  default     = null
}

variable "gpu_drivers_preset" {
  description = "Managed driver image for GPU nodes (ADR-0003). null = the platform's preset from platform/regions.yaml (cuda13.0; cuda12.8 = 570.x is opt-in only). Ignored when enable_gpu_operator = true."
  type        = string
  default     = null

  validation {
    condition     = var.gpu_drivers_preset == null || contains(["cuda12.8", "cuda13.0"], coalesce(var.gpu_drivers_preset, "x"))
    error_message = "gpu_drivers_preset must be cuda12.8 or cuda13.0 (https://docs.nebius.com/kubernetes/gpu/set-up)."
  }
}

variable "enable_gpu_operator" {
  description = "Opt in to the Network Operator -> GPU Operator path instead of the managed driver image (ADR-0003): needed for MIG, CDI or a custom device plugin. Nodes then boot without drivers and the cluster autoscaler can over-provision while both operators initialise."
  type        = bool
  default     = false
}

variable "gpu_operator_driver_version" {
  description = "GPU Operator driver version override. null = the platform's operator_driver_version from platform/regions.yaml (580.95.05 on B300, as the docs require), else the chart default. Only used with enable_gpu_operator."
  type        = string
  default     = null
}

variable "mig_strategy" {
  description = "GPU Operator MIG strategy (none | single | mixed); null = chart default. Only used with enable_gpu_operator."
  type        = string
  default     = null
}

variable "ssh_public_key" {
  type    = string
  default = null
}

variable "enable_filestore" {
  type    = bool
  default = true
}

variable "filestore_size_gib" {
  description = "Dataset/checkpoint share. Size for the customer's data; 256 GiB here is an example."
  type        = number
  default     = 256
}

variable "existing_filesystem_id" {
  description = "Attach an existing shared filesystem (e.g. the data stack's filesystem_id, R8) instead of creating one; it then outlives this cluster."
  type        = string
  default     = null
}

variable "filestore_mount_path" {
  type    = string
  default = "/mnt/data"
}

variable "enable_o11y" {
  type    = bool
  default = true
}

variable "enable_nebius_agent" {
  type    = bool
  default = true
}

variable "labels" {
  description = "Labels applied to every resource for cost attribution and the residue check (scripts/leftovers.sh). nip-run and nip-ttl-expires are required (sandbox); nip-region, nip-stage and nip-stack are added automatically (nip-env, deprecated, defaults to the stack)."
  type        = map(string)
  default = {
    "nip-env"   = "training"
    "nip-owner" = "platform"
  }

  validation {
    condition     = try(length(var.labels["nip-run"]) > 0, false)
    error_message = "labels must carry nip-run (a ticket, date or run id) so leftovers can be attributed (docs/cost.md)."
  }
  validation {
    # Required only where the stage policy says so (platform/stages.yaml). Shape check (UTC, no offset)
    # plus a real parse: formatdate rejects impossible dates such as 2026-99-99T99:99:99Z.
    condition     = !yamldecode(file("${path.module}/../../../platform/stages.yaml")).stages[var.stage].policy.require_ttl_label || (can(regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$", lookup(var.labels, "nip-ttl-expires", ""))) && can(formatdate("YYYY", lookup(var.labels, "nip-ttl-expires", ""))))
    error_message = "this stage requires labels[\"nip-ttl-expires\"] as an RFC 3339 UTC timestamp, e.g. 2026-10-31T18:00:00Z, that ends inside the approved session (docs/cost.md)."
  }
}

# ---- Stage-governed protection and exposure flags (ADR-0009; null = the stage policy) ----

variable "allowed_cidrs" {
  description = "CIDR allowlist for the public control-plane endpoint (max 8, host bits zero). Staging/prod require it whenever the public endpoint is on."
  type        = list(string)
  default     = []

  validation {
    # https://docs.nebius.com/kubernetes/networking/limit-access-to-public-endpoint: "Bits for hosts must be equal to zero."
    condition     = length(var.allowed_cidrs) <= 8 && alltrue([for c in var.allowed_cidrs : can(cidrnetmask(c)) && try(cidrhost(c, 0) == split("/", c)[0], false)])
    error_message = "allowed_cidrs holds at most 8 IPv4 CIDR blocks with the host bits zero (e.g. 203.0.113.0/24, not 203.0.113.5/24)."
  }
}

variable "security_group_ids" {
  description = "VPC security groups attached to every node interface (empty = the network's default security group). With R7: the network stack's security_group_ids output."
  type        = list(string)
  default     = []
}

variable "audit_logs" {
  description = "Push the Kubernetes audit log to service logs; null = the stage policy (on in staging/prod)."
  type        = bool
  default     = null
}

variable "filestore_forbid_deletion" {
  description = "API-level deletion protection on the shared filesystem; null = the stage policy (on in prod)."
  type        = bool
  default     = null
}

variable "gpu_reservation" {
  description = "Capacity reservation for the GPU node group: { policy = STRICT|AUTO|FORBID, reservation_ids = [...] }. null = FORBID (common pool only) for a regular GPU group, nothing for a preemptible one; never the API default AUTO, which would draw on any matching capacity block group in the tenant. Prod training requires STRICT whenever GPU nodes are requested."
  type = object({
    policy          = string
    reservation_ids = optional(list(string), [])
  })
  default = null
}

variable "grafana_admin_secret_id" {
  description = "SecretStash secret (mbsec-...) holding the Grafana admin password under the key admin-password (docs/credentials.md#secretstash). Set: the password comes from TF_VAR_grafana_admin_password at apply and reaches neither plan nor state; the grafana_admin_password output is null. null = a generated password kept in state."
  type        = string
  default     = null
}

variable "grafana_admin_secret_version_id" {
  description = "SecretStash version (mbsecver-...) the password was read from; pin the new version id to roll out a rotation (runbooks/credential-rotation.md). null = the primary version."
  type        = string
  default     = null
}

variable "grafana_admin_password" {
  description = "Grafana admin password read from grafana_admin_secret_id (TF_VAR_grafana_admin_password). Ephemeral and write-only: never in a plan or the state. Not needed for a plan that is only reviewed; set it before the plan that is applied."
  type        = string
  default     = null
  sensitive   = true
  ephemeral   = true
}

variable "alertmanager_config_secret" {
  description = "Name of a pre-created Kubernetes Secret (key alertmanager.yml) in the o11y namespace with the real Alertmanager routes and receivers. Keeps receiver credentials out of state; see runbooks/alerting.md. Null = the module's null receiver (alerts visible, nobody paged)."
  type        = string
  default     = null
}

variable "grafana_datasource_token_secret" {
  description = "Name of a pre-created Kubernetes Secret in the o11y namespace (key PROMETHEUS_TOKEN: an OBSERVABILITY static key of a viewer service account, docs/credentials.md#observability-static-key). Set: the in-cluster Grafana gets the Nebius data sources of recipes/observability/grafana/datasources.yaml, and the key never passes through Terraform. Null = no data sources; the plan warns (runbooks/observability.md)."
  type        = string
  default     = null
}

variable "alertmanager_config" {
  description = "Inline Alertmanager config for receivers WITHOUT credentials (null = module default). Use alertmanager_config_secret for anything with a webhook URL or key."
  type        = any
  default     = null
}

variable "alertmanager_enabled" {
  description = "Alertmanager + the rule groups under platform/alerts/; null = the stage policy (on in staging/prod)."
  type        = bool
  default     = null
}

# ---- node identity and node metadata ------------------------------------------------------

variable "node_service_account_id" {
  description = "Service account attached to every node group (template.service_account_id): pods pull from Nebius Container Registry without pull secrets. The project's k8s-node-group-sa is enough; null = none (https://docs.nebius.com/kubernetes/workloads/images-container-registry)."
  type        = string
  default     = null
}

variable "propagate_cost_labels" {
  description = "Copy the resource labels (nip-*) into every node's Compute instance metadata so the node VMs carry the cost allocation labels (Billing -> Usage can then split GPU node spend by nip-*; docs/cost.md). The per-run nip-run / nip-ttl-expires are left out so a new run does not recreate nodes. Changing this flag on an existing cluster, or changing any other label while it is true, recreates every node: decide before the first apply."
  type        = bool
  default     = true
}

variable "journald_logs" {
  description = "Ship journald logs of journald_units from every node to Observability Logs (instance metadata labels nebius.o11y.systemd-logs-collection.*; https://docs.nebius.com/kubernetes/logs#how-to-enable-journald-logs). Changing it later recreates every node."
  type        = bool
  default     = false
}

variable "journald_units" {
  description = "systemd units collected when journald_logs = true, separated by semicolons."
  type        = string
  default     = "kubelet.service;containerd.service"
}
