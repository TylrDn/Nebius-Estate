variable "cluster_id" {
  description = "Managed Kubernetes cluster ID (parent of the node group)."
  type        = string
}

variable "name" {
  type = string
}

variable "k8s_version" {
  description = "Kubernetes version for the nodes; null = cluster default."
  type        = string
  default     = null
}

variable "platform" {
  description = "Compute platform, e.g. cpu-d3, gpu-h100-sxm, gpu-l40s-a."
  type        = string

  validation {
    # Platform and preset families must agree. The stacks also refuse a gpu-* platform or an
    # <n>gpu-* preset for their CPU group, which no stage GPU cap counts (modules/stage-policy).
    condition     = startswith(var.platform, "gpu-") || (startswith(var.platform, "cpu-") && !can(regex("^[0-9]+gpu-", var.preset)))
    error_message = "platform must be a cpu-* or gpu-* platform, and an <n>gpu-* preset needs a gpu-* platform (a cpu-* platform takes a CPU preset such as 8vcpu-32gb)."
  }
}

variable "preset" {
  description = "Resource preset for the platform, e.g. 8vcpu-32gb, 1gpu-16vcpu-200gb."
  type        = string
}

variable "fixed_node_count" {
  type    = number
  default = null
}

variable "autoscaling" {
  description = "Set instead of fixed_node_count to let the cluster autoscaler manage size."
  type = object({
    min = number
    max = number
  })
  default = null
}

variable "rollout_surge" {
  description = "Rolling updates (any template change replaces every node) create the new node before draining the old one: max_surge 1 / max_unavailable 0. Needs quota for one extra node. Default (false) is the platform default: one node unavailable at a time, no surge."
  type        = bool
  default     = false
}

variable "strategy" {
  description = "Rollout strategy on template changes (max_surge / max_unavailable, by count or percent)."
  type = object({
    max_surge = optional(object({
      count   = optional(number)
      percent = optional(number)
    }))
    max_unavailable = optional(object({
      count   = optional(number)
      percent = optional(number)
    }))
    drain_timeout = optional(string)
  })
  default = null
}

variable "subnet_id" {
  type = string
}

variable "security_group_ids" {
  description = "VPC security groups attached to every node's interface (empty = the network's default security group). The cluster's managed system security group is always attached as well (https://docs.nebius.com/kubernetes/networking/security-groups). Prod attaches the stage's groups."
  type        = list(string)
  default     = []
}

variable "reservation" {
  description = "Capacity reservation policy: STRICT = only reserved capacity (committed training; cannot be preemptible), AUTO = reserved first, then on-demand, FORBID = common pool only (no reservation_ids). null = no policy sent, so the API default AUTO applies: a regular GPU group then draws on any matching capacity block group in the tenant (https://docs.nebius.com/kubernetes/node-groups/reservations). Pass FORBID to guarantee on-demand only."
  type = object({
    policy          = string
    reservation_ids = optional(list(string), [])
  })
  default = null

  validation {
    condition     = var.reservation == null || contains(["STRICT", "AUTO", "FORBID"], try(var.reservation.policy, ""))
    error_message = "reservation.policy must be STRICT, AUTO or FORBID."
  }
}

variable "public_ip" {
  description = "Give each node a public IP. Keep false unless nodes must be reachable from the internet."
  type        = bool
  default     = false
}

variable "boot_disk_size_gib" {
  type    = number
  default = 128
}

variable "boot_disk_type" {
  type    = string
  default = "NETWORK_SSD"
}

variable "filesystem" {
  description = "Shared filesystem to attach and mount on every node (from modules/filestore)."
  type = object({
    id         = string
    mount_tag  = string
    mount_path = string
  })
  default = null
}

variable "gpu_cluster_id" {
  description = "nebius_compute_v1_gpu_cluster ID for InfiniBand; 8-GPU presets only."
  type        = string
  default     = null
}

variable "drivers_preset" {
  description = "Managed GPU driver image preset (cuda12.8 or cuda13.0). null = install drivers with the GPU Operator instead."
  type        = string
  default     = null

  validation {
    condition     = var.drivers_preset == null || contains(["cuda12.8", "cuda13.0"], coalesce(var.drivers_preset, "x"))
    error_message = "drivers_preset must be cuda12.8 or cuda13.0 (https://docs.nebius.com/kubernetes/gpu/set-up)."
  }
}

variable "preemptible" {
  description = "Use interruptible (spot) capacity. Spot GPU prices can change every 15 minutes (ADR-0007). The docs require a spot pricing setting alongside it: spot_pricing_policy_id, or follows_spot_price when that is null."
  type        = bool
  default     = false
}

variable "spot_pricing_policy_id" {
  description = "ID of a spot pricing policy (max price) for preemptible nodes. null = follows_spot_price, i.e. pay the current spot price with no cap (https://docs.nebius.com/kubernetes/node-groups/manage)."
  type        = string
  default     = null
}

variable "taints" {
  type = list(object({
    key    = string
    value  = optional(string)
    effect = string
  }))
  default = null
}

variable "node_labels" {
  description = "Kubernetes node labels applied by the node group."
  type        = map(string)
  default     = {}
}

variable "labels" {
  description = "Nebius resource labels."
  type        = map(string)
  default     = {}
}

variable "ssh_user_name" {
  type    = string
  default = "ubuntu"
}

variable "ssh_public_key" {
  description = "Optional SSH public key for node access (break-glass only)."
  type        = string
  default     = null
}

variable "service_account_id" {
  description = "Service account whose credentials the nodes carry (template.service_account_id): pods pull from Nebius Container Registry without image pull secrets, and the nebius CLI works on the node. The project's default k8s-node-group-sa (viewers group) is enough for pulls; the caller needs resource.serviceaccount.issueAccessToken. null = none. https://docs.nebius.com/kubernetes/workloads/images-container-registry"
  type        = string
  default     = null
}

variable "instance_metadata_labels" {
  description = "Labels propagated into the Compute instance metadata of every node (template.instance_metadata.labels), e.g. cost labels or the journald collection keys nebius.o11y.systemd-logs-collection.*. Set them at creation: changing them recreates every node in the group (https://docs.nebius.com/kubernetes/logs#how-to-enable-journald-logs)."
  type        = map(string)
  default     = {}
}
