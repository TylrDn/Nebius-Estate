# Sizing for stage prod of the inference stack (hand-maintained; the stage policy — etcd size,
# endpoint exposure, GPU caps, TTL labels, preemptible serving — is in platform/stages.yaml and
# enforced by the stack at plan time). parent_id, region and iam_token come from
# `source scripts/bootstrap-backend.sh prod inference`; never commit them.

cluster_name = "nip-prod-inference"
k8s_version  = "1.35" # offset 1 (N-1); upgrade on the staging-proven version only

cpu_preset      = "8vcpu-32gb"
cpu_node_count  = 3
gpu_node_count  = 2     # cap 8; raise by a reviewed change on a tagged release
gpu_preemptible = false # prod refuses preemptible serving
# public_endpoint stays off: the stage policy refuses public_endpoint = true in prod (modules/stage-policy, private_endpoint rule); reach the API from inside the VPC (get-kubeconfig.sh --internal)
# gpu_reservation    = { policy = "AUTO", reservation_ids = ["reservation-..."] } # reserved first, on-demand burst (docs/capacity.md)

# With the R7 network and R8 data stacks applied, pass their outputs at plan time (ids are never committed):
#   export TF_VAR_subnet_id=... TF_VAR_security_group_ids='["..."]' TF_VAR_service_cidr=/20   # terraform -chdir=terraform/live/prod/network output
#   export TF_VAR_existing_filesystem_id=...                                                    # terraform -chdir=terraform/live/prod/data output filesystem_id

enable_filestore   = true
filestore_size_gib = 1024
enable_o11y        = true

labels = {
  "nip-env"   = "inference"
  "nip-owner" = "platform"
  "nip-run"   = "prod" # long-lived: the stage itself is the run; no TTL in prod (platform/stages.yaml)
}
