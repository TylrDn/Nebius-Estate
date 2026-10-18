# Sizing for stage lab of the network stack (hand-maintained; the stage policy is in platform/stages.yaml).
# parent_id, region and iam_token come from `source scripts/bootstrap-backend.sh lab network`; never commit them.
# lab is CPU-only and lives in its own project and region (uk-south1 on first bind), so the NAT VM
# (4 vCPU, cpu-d3) fits the 200 non-GPU vCPU default there (docs/capacity.md).

enable_nat     = true
enable_bastion = false          # WireGuard; needs TF_VAR_allowed_cidrs (office/VPN egress)
cidr           = "10.43.0.0/16" # one range per stage: peering and VPN routes never overlap

# lab requires nip-run and nip-ttl-expires (docs/cost.md); pass them per run:
#   export TF_VAR_labels='{"nip-owner":"platform","nip-run":"ticket-123","nip-ttl-expires":"2026-10-31T18:00:00Z"}'
