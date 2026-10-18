variable "stage" {
  description = "Lifecycle stage this root belongs to (platform/stages.yaml): sandbox, staging or prod. Selects the policy the stack enforces at plan time (ADR-0009)."
  type        = string

  validation {
    condition     = contains(keys(yamldecode(file("${path.module}/../../../platform/stages.yaml")).stages), var.stage)
    error_message = "stage must be one of the stages in platform/stages.yaml (sandbox, staging, prod)."
  }
}

variable "parent_id" {
  description = "Nebius project ID that owns the NVLink instance groups (project-...): the project of the Managed Kubernetes cluster."
  type        = string

  validation {
    condition     = startswith(var.parent_id, "project-")
    error_message = "parent_id must be a Nebius project ID (project-...)."
  }
}

variable "region" {
  description = "Nebius region of the project (platform/regions.yaml). The docs do not list GB300 per region; confirm the region with Nebius before a reservation is requested (README.md)."
  type        = string
  default     = "eu-north1"

  validation {
    condition     = contains(keys(yamldecode(file("${path.module}/../../../platform/regions.yaml")).regions), var.region)
    error_message = "region is not in platform/regions.yaml."
  }
}

variable "cluster_id" {
  description = "Managed Kubernetes cluster the rack node groups join (mk8scluster-...), e.g. the R3 training stack's cluster_id."
  type        = string

  validation {
    condition     = startswith(var.cluster_id, "mk8scluster-")
    error_message = "cluster_id must be a Managed Kubernetes cluster ID (mk8scluster-...)."
  }
}

variable "subnet_id" {
  description = "Subnet for the rack nodes (vpcsubnet-...): R7's subnet_id or the cluster's subnet. Nodes get no public address."
  type        = string

  validation {
    condition     = startswith(var.subnet_id, "vpcsubnet-")
    error_message = "subnet_id must be a VPC subnet ID (vpcsubnet-...)."
  }
}

variable "racks" {
  description = "Number of GB300 NVL72 racks. Each rack is one NVLink instance group of 18 VMs and one fixed 18-node node group (72 GPUs). 0 = plan nothing. Counted as racks x 18 nodes against max_gpu_nodes.nvl in platform/stages.yaml, which is 0 in every stage until a reservation is approved."
  type        = number
  default     = 0

  validation {
    condition     = var.racks >= 0 && var.racks == floor(var.racks) && var.racks <= 8
    error_message = "racks must be a whole number between 0 and 8 (each rack is 18 nodes, 72 GPUs)."
  }
}

variable "capacity_reservation_ids" {
  description = "Capacity block group IDs (the reservation) the rack nodes run on, in the order to draw from them. Required for any rack: rack-scale capacity is reserved capacity, so the node groups use reservation policy STRICT and fail rather than fall back to the common pool (https://docs.nebius.com/kubernetes/node-groups/reservations#how-to-add-reservations-to-node-groups)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for id in var.capacity_reservation_ids : length(trimspace(id)) > 0])
    error_message = "capacity_reservation_ids must not contain empty IDs (nebius capacity capacity-block-group list)."
  }
}

variable "gpu_cluster_id" {
  description = "Existing InfiniBand GPU cluster (computegpucluster-...) for traffic between racks. Required for two or more racks (as in the upstream k8s-training GB300 path); one rack may omit it. The docs list no InfiniBand fabric for gpu-gb300: confirm the fabric with Nebius."
  type        = string
  default     = null

  validation {
    condition     = var.gpu_cluster_id == null || startswith(coalesce(var.gpu_cluster_id, "x"), "computegpucluster-")
    error_message = "gpu_cluster_id must be a GPU cluster ID (computegpucluster-...)."
  }
}

variable "k8s_version" {
  description = "Kubernetes version of the rack node groups. null = the cluster's version. Must be a version platform/regions.yaml lists and inside the stage's window."
  type        = string
  default     = null

  validation {
    condition     = var.k8s_version == null || contains(yamldecode(file("${path.module}/../../../platform/regions.yaml")).kubernetes_versions, coalesce(var.k8s_version, "x"))
    error_message = "k8s_version must be one of the versions Managed Kubernetes accepts (platform/regions.yaml: kubernetes_versions)."
  }
}

variable "boot_disk_size_gib" {
  description = "Network SSD boot disk per node. The upstream GB300 path defaults to 1024 GiB; GPU nodes need at least 256 GiB for the driver image and container caches."
  type        = number
  default     = 1024

  validation {
    condition     = var.boot_disk_size_gib >= 256 && var.boot_disk_size_gib == floor(var.boot_disk_size_gib)
    error_message = "boot_disk_size_gib must be a whole number of at least 256."
  }
}

variable "node_service_account_id" {
  description = "Service account attached to the rack nodes (template.service_account_id), e.g. R12's node identity for registry pulls; null = none."
  type        = string
  default     = null
}

variable "labels" {
  description = "Labels applied to every resource (docs/cost.md). nip-run is required; nip-ttl-expires where the stage requires it; nip-region, nip-stage and nip-stack are added automatically (nip-env, deprecated, defaults to the stack)."
  type        = map(string)
  default = {
    "nip-env"   = "nvl"
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
