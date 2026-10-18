locals {
  private_ip = split("/", nebius_vpc_v1_allocation.private.status.details.allocated_cidr)[0]
  public_ip  = var.public_ip ? split("/", nebius_vpc_v1_allocation.public[0].status.details.allocated_cidr)[0] : null
  ssh_host   = coalesce(local.public_ip, local.private_ip)
}

output "stage" {
  description = "Stage this root was planned for."
  value       = var.stage
}

output "instance_id" {
  description = "Compute instance ID (computeinstance-...)."
  value       = nebius_compute_v1_instance.this.id
}

output "private_ip" {
  description = "The VM's private address (reachable from the VPC, e.g. through R7's WireGuard bastion)."
  value       = local.private_ip
}

output "public_ip" {
  description = "Reserved public address (an allocation), reachable from allowed_cidrs only; null without public_ip."
  value       = local.public_ip
}

output "platform" {
  description = "Platform, preset and boot image family the VM runs."
  value       = { platform = local.platform, preset = local.preset, image_family = local.image_family, gpus = local.gpus }
}

output "model" {
  description = "Served model (Hugging Face repo and pinned revision) and the vLLM image (pinned by digest)."
  value       = { repo = local.model_repo, revision = local.model_revision, image = local.vllm_image }
}

output "how_to_reach" {
  description = "Commands to reach the OpenAI-compatible API. The key is generated on the VM and read over SSH."
  value = {
    tunnel   = "ssh -N -L ${var.api_port}:127.0.0.1:${var.api_port} ${var.admin_user}@${local.ssh_host}"
    base_url = var.expose_api ? "http://${local.ssh_host}:${var.api_port}/v1" : "http://127.0.0.1:${var.api_port}/v1 (through the tunnel)"
    api_key  = "ssh ${var.admin_user}@${local.ssh_host} sudo sed -n 's/^VLLM_API_KEY=//p' /etc/vllm/env"
    logs     = "ssh ${var.admin_user}@${local.ssh_host} sudo docker logs -f vllm"
    from     = var.public_ip ? "an address in allowed_cidrs" : "inside the VPC: a VM in the same network or a WireGuard tunnel through R7's bastion"
  }
}
