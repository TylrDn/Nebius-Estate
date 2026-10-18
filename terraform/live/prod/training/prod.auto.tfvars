# Sizing for stage prod of the training stack (hand-maintained; the stage policy — etcd size,
# endpoint exposure, GPU caps, TTL labels, preemptible serving — is in platform/stages.yaml and
# enforced by the stack at plan time). parent_id, region and iam_token come from
# `source scripts/bootstrap-backend.sh prod training`; never commit them.

cluster_name = "nip-prod-training"
k8s_version  = "1.35"

cpu_node_count = 3
gpu_node_count = 0 # committed capacity is a customer decision (cap 32): set it with the reservation on a tagged release
# gpu_reservation = { policy = "STRICT", reservation_ids = ["reservation-..."] } # required by the prod policy whenever gpu_node_count > 0 (runbooks/capacity-request.md)
enable_gpu_cluster = true

# With the R7 network and R8 data stacks applied, pass their outputs at plan time (ids are never committed):
#   export TF_VAR_subnet_id=... TF_VAR_security_group_ids='["..."]' TF_VAR_service_cidr=/20   # terraform -chdir=terraform/live/prod/network output
#   export TF_VAR_existing_filesystem_id=...                                                    # terraform -chdir=terraform/live/prod/data output filesystem_id

enable_filestore   = true
filestore_size_gib = 4096

labels = {
  "nip-env"   = "training"
  "nip-owner" = "platform"
  "nip-run"   = "prod" # long-lived: the stage itself is the run; no TTL in prod (platform/stages.yaml)
}
