# Sizing for stage prod of the network stack (hand-maintained; the stage policy is in platform/stages.yaml).
# parent_id, region and iam_token come from `source scripts/bootstrap-backend.sh prod network`; never commit them.

enable_nat     = true
enable_bastion = true           # WireGuard; needs TF_VAR_allowed_cidrs (office/VPN egress)
cidr           = "10.42.0.0/16" # one range per stage: peering and VPN routes never overlap

labels = {
  "nip-env"   = "network"
  "nip-owner" = "platform"
  "nip-run"   = "prod" # long-lived: the stage itself is the run
}
