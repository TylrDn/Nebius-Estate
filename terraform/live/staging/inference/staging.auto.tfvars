# Sizing for stage staging of the inference stack (hand-maintained; the stage policy — etcd size,
# endpoint exposure, GPU caps, TTL labels, preemptible serving — is in platform/stages.yaml and
# enforced by the stack at plan time). parent_id, region and iam_token come from
# `source scripts/bootstrap-backend.sh staging inference`; never commit them.

cluster_name = "nip-staging-inference"
k8s_version  = "1.35" # offset 1 (N-1): what prod runs next

# Staging keeps a public control-plane endpoint only behind an allowlist (stage policy). The
# allowlist is your office/VPN egress (max 8 CIDRs) and is passed at plan time, not committed:
#   export TF_VAR_allowed_cidrs='["x.x.x.x/32"]'
# An empty list or a documentation range (RFC 5737) fails the plan.

cpu_preset      = "8vcpu-32gb"
cpu_node_count  = 2
gpu_node_count  = 1     # production shape at reduced size (cap 2)
gpu_preemptible = false # staging refuses preemptible serving

enable_filestore   = true
filestore_size_gib = 256
enable_o11y        = true

labels = {
  "nip-env"   = "inference"
  "nip-owner" = "platform"
  "nip-run"   = "staging" # long-lived: the stage itself is the run; no TTL in staging (platform/stages.yaml)
}
