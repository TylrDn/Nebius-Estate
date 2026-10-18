variable "stage" {
  description = "Lifecycle stage this root belongs to (platform/stages.yaml): sandbox, staging or prod. Selects the policy the stack enforces at plan time (ADR-0009)."
  type        = string

  validation {
    condition     = contains(keys(yamldecode(file("${path.module}/../../../platform/stages.yaml")).stages), var.stage)
    error_message = "stage must be one of the stages in platform/stages.yaml (sandbox, staging, prod)."
  }
}

variable "parent_id" {
  description = "Nebius project ID that owns the VM (project-...)."
  type        = string

  validation {
    condition     = startswith(var.parent_id, "project-")
    error_message = "parent_id must be a Nebius project ID (project-...)."
  }
}

variable "region" {
  description = "Nebius region (platform/regions.yaml). Selects the default GPU platform and its 1-GPU preset."
  type        = string
  default     = "eu-north1"

  validation {
    condition     = contains(keys(yamldecode(file("${path.module}/../../../platform/regions.yaml")).regions), var.region)
    error_message = "region is not in platform/regions.yaml."
  }
}

variable "name" {
  description = "Name of the VM; its boot disk is <name>-boot and its access group <name>-access. null = nip-<stage>-gpu-vm (docs/naming.md)."
  type        = string
  default     = null

  validation {
    condition     = var.name == null || can(regex("^[a-z][a-z0-9-]{0,49}$", var.name))
    error_message = "name must be lowercase letters, digits and hyphens, starting with a letter, at most 50 characters."
  }
}

# ---- Compute -------------------------------------------------------------------------------

variable "platform" {
  description = "GPU platform. null = the region's default in platform/regions.yaml (eu-north1: gpu-h100-sxm). Must be one of the region's platforms there."
  type        = string
  default     = null
}

variable "preset" {
  description = "Preset of the platform. null = its single_gpu_preset in platform/regions.yaml. Multi-GPU presets run vLLM with tensor parallelism across all GPUs of the VM."
  type        = string
  default     = null

  validation {
    condition     = var.preset == null || can(regex("^[1-9][0-9]*gpu-[0-9]+vcpu-[0-9]+gb$", var.preset))
    error_message = "preset must be a GPU preset such as 1gpu-16vcpu-200gb (compute/virtual-machines/types)."
  }
}

variable "image_family" {
  description = "Boot image family. null = the family that carries the platform's drivers_preset in platform/regions.yaml (cuda13.0 -> ubuntu24.04-cuda13.0, the stable family). An override must be one the docs list for the platform."
  type        = string
  default     = null
}

variable "boot_disk_size_gib" {
  description = "Boot disk size. Holds the vLLM image and, without a filesystem, the model weights cache."
  type        = number
  default     = 200

  validation {
    condition     = var.boot_disk_size_gib >= 100 && var.boot_disk_size_gib <= 30720
    error_message = "boot_disk_size_gib must be between 100 (image + a small model) and 30720 (the documented maximum)."
  }
}

variable "preemptible" {
  description = "Run on preemptible (spot) capacity: Compute may stop the VM at any time, 60 s after SIGTERM. Only where the stage allows preemptible serving (sandbox)."
  type        = bool
  default     = false
}

variable "spot_pricing_policy_id" {
  description = "Pricing policy that caps the spot price of a preemptible VM. null = follow the current spot price."
  type        = string
  default     = null
}

# ---- Network -------------------------------------------------------------------------------

variable "subnet_id" {
  description = "Subnet for the VM: R7's subnet_id (no public addresses; egress through its NAT) or a subnet with a public pool when public_ip is set."
  type        = string

  validation {
    condition     = startswith(var.subnet_id, "vpcsubnet-")
    error_message = "subnet_id must be a VPC subnet ID (vpcsubnet-...)."
  }
}

variable "security_group_ids" {
  description = "Existing security groups for the VM's interface, e.g. R7's security_group_ids."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for id in var.security_group_ids : startswith(id, "vpcsecuritygroup-")])
    error_message = "security_group_ids must be VPC security group IDs (vpcsecuritygroup-...)."
  }
}

variable "public_ip" {
  description = "Give the VM a static public address. Needs allowed_cidrs in every stage: the stack then adds a security group that admits SSH (and the API with expose_api) from the allowlist only and denies other ingress."
  type        = bool
  default     = false
}

variable "allowed_cidrs" {
  description = "Office/VPN egress CIDRs allowed to reach the public address, max 8. Pass with TF_VAR_allowed_cidrs; staging and prod refuse documentation ranges."
  type        = list(string)
  default     = []

  validation {
    # /8 or narrower: 0.0.0.0/0, or the two /1 halves, would open SSH and the API to the internet.
    condition     = length(var.allowed_cidrs) <= 8 && alltrue([for c in var.allowed_cidrs : can(cidrhost(c, 0)) && try(tonumber(split("/", c)[1]) >= 8, false)])
    error_message = "allowed_cidrs takes at most 8 CIDR blocks, each /8 or narrower (never 0.0.0.0/0 or its /1 halves)."
  }
}

variable "expose_api" {
  description = "Publish the API port on the VM's interfaces instead of 127.0.0.1 only. Off: reach it through an SSH tunnel. On: reachable from the VPC (as the security groups allow) and, with public_ip, from allowed_cidrs."
  type        = bool
  default     = false
}

# ---- Access and serving --------------------------------------------------------------------

variable "admin_user" {
  description = "Login user created by cloud-init. root and admin are reserved by Compute and cannot connect by SSH."
  type        = string
  default     = "nip-admin"

  validation {
    condition     = can(regex("^[a-z_][a-z0-9_-]{0,31}$", var.admin_user)) && !contains(["root", "admin"], var.admin_user)
    error_message = "admin_user must be a Linux user name other than root or admin (reserved by Compute)."
  }
}

variable "ssh_public_key" {
  description = "Public key for admin_user (the only way in: the API listens on 127.0.0.1 unless expose_api)."
  type        = string

  validation {
    condition     = can(regex("^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+", var.ssh_public_key))
    error_message = "ssh_public_key must be an OpenSSH public key (ssh-ed25519, ssh-rsa or ecdsa-sha2-*)."
  }
}

variable "model" {
  description = "Model to serve: a key under workloads in platform/versions.yaml whose source is a Hugging Face URL; the pinned revision comes from there too."
  type        = string
  default     = "qwen2.5-1.5b-instruct"

  validation {
    condition     = startswith(try(yamldecode(file("${path.module}/../../../platform/versions.yaml")).workloads[var.model].source, ""), "https://huggingface.co/")
    error_message = "model must be a workloads entry in platform/versions.yaml with a https://huggingface.co/ source."
  }
}

variable "api_port" {
  description = "Port of the OpenAI-compatible API on the VM."
  type        = number
  default     = 8000

  validation {
    condition     = var.api_port >= 1024 && var.api_port <= 65535 && var.api_port != 22
    error_message = "api_port must be an unprivileged port (1024-65535)."
  }
}

variable "vllm_extra_args" {
  description = "Extra arguments for vllm serve, e.g. [\"--max-model-len\", \"8192\"]."
  type        = list(string)
  default     = []
}

variable "existing_filesystem_id" {
  description = "Attach an existing shared filesystem (R8 filesystem_id) at /mnt/fs; the model cache then lives there and survives the VM."
  type        = string
  default     = null

  validation {
    condition     = var.existing_filesystem_id == null || startswith(coalesce(var.existing_filesystem_id, "-"), "computefilesystem-")
    error_message = "existing_filesystem_id must be a Compute filesystem ID (computefilesystem-...)."
  }
}

variable "labels" {
  description = "Labels applied to every resource (docs/cost.md). nip-run is required; nip-ttl-expires where the stage requires it; nip-region, nip-stage and nip-stack are added automatically (nip-env, deprecated, defaults to the stack)."
  type        = map(string)
  default = {
    "nip-env"   = "gpu-vm"
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
