# Sizing for stage sandbox of the network stack (hand-maintained; the stage policy is in platform/stages.yaml).
# parent_id, region and iam_token come from `source scripts/bootstrap-backend.sh sandbox network`; never commit them.

enable_nat     = true
enable_bastion = false          # WireGuard; needs TF_VAR_allowed_cidrs (office/VPN egress)
cidr           = "10.40.0.0/16" # one range per stage: peering and VPN routes never overlap

# Sandbox requires nip-run and nip-ttl-expires (docs/cost.md); pass them per run:
#   export TF_VAR_labels='{"nip-owner":"platform","nip-run":"ticket-123","nip-ttl-expires":"2026-10-31T18:00:00Z"}'
