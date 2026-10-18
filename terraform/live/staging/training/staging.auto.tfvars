# Sizing for stage staging of the training stack (hand-maintained; the stage policy — etcd size,
# endpoint exposure, GPU caps, TTL labels, preemptible serving — is in platform/stages.yaml and
# enforced by the stack at plan time). parent_id, region and iam_token come from
# `source scripts/bootstrap-backend.sh staging training`; never commit them.

cluster_name = "nip-staging-training"
k8s_version  = "1.35"

# Staging keeps a public control-plane endpoint only behind an allowlist (stage policy). The
# allowlist is your office/VPN egress (max 8 CIDRs) and is passed at plan time, not committed:
#   export TF_VAR_allowed_cidrs='["x.x.x.x/32"]'
# An empty list or a documentation range (RFC 5737) fails the plan.

cpu_node_count     = 2
gpu_node_count     = 0 # 2 for a staging NCCL run (cap 8); 0 between runs so no 8-GPU node idles
enable_gpu_cluster = true

enable_filestore   = true
filestore_size_gib = 1024

labels = {
  "nip-env"   = "training"
  "nip-owner" = "platform"
  "nip-run"   = "staging" # long-lived: the stage itself is the run; no TTL in staging (platform/stages.yaml)
}
