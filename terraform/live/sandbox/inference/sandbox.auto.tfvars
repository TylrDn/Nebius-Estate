# Sizing for stage sandbox of the inference stack (hand-maintained; the stage policy — etcd size,
# endpoint exposure, GPU caps, TTL labels, preemptible serving — is in platform/stages.yaml and
# enforced by the stack at plan time). parent_id, region and iam_token come from
# `source scripts/bootstrap-backend.sh sandbox inference`; never commit them.

cluster_name = "nip-sandbox-inference"
k8s_version  = "1.36" # offset 0: the version the docs recommend for new clusters

cpu_preset      = "8vcpu-32gb"
cpu_node_count  = 2
gpu_node_count  = 1    # cap 2 in sandbox; set 0 to apply the CPU layer first
gpu_preemptible = true # sandbox allows preemptible serving (follows_spot_price unless a policy id is set)

enable_filestore   = true
filestore_size_gib = 64
enable_o11y        = true


# Sandbox requires nip-run and nip-ttl-expires (docs/cost.md). They change per run, so pass
# them at plan time instead of editing this file:
#   export TF_VAR_labels='{"nip-stack":"inference","nip-owner":"platform","nip-run":"ticket-123","nip-ttl-expires":"2026-10-31T18:00:00Z"}'
