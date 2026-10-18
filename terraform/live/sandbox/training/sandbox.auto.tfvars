# Sizing for stage sandbox of the training stack (hand-maintained; the stage policy — etcd size,
# endpoint exposure, GPU caps, TTL labels, preemptible serving — is in platform/stages.yaml and
# enforced by the stack at plan time). parent_id, region and iam_token come from
# `source scripts/bootstrap-backend.sh sandbox training`; never commit them.

cluster_name = "nip-sandbox-training"
k8s_version  = "1.36"

cpu_node_count     = 2
gpu_node_count     = 0    # plan-only until a written spend approval; then 2 (cap 4): 2 x 8 GPUs in one fabric
enable_gpu_cluster = true # the GPU cluster is created only when gpu_node_count > 0

enable_filestore   = true
filestore_size_gib = 256

# Sandbox requires nip-run and nip-ttl-expires (docs/cost.md). They change per run, so pass
# them at plan time instead of editing this file:
#   export TF_VAR_labels='{"nip-owner":"platform","nip-run":"ticket-123","nip-ttl-expires":"2026-10-31T18:00:00Z"}'
