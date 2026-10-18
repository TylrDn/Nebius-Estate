# Sizing for stage prod of the data stack (hand-maintained; the stage policy is in platform/stages.yaml).
# parent_id, region and iam_token come from `source scripts/bootstrap-backend.sh prod data`; never commit them.

filesystem_size_gib        = 2048
checkpoint_noncurrent_days = 30
dataset_storage_class      = "ENHANCED_THROUGHPUT"

labels = {
  "nip-env"   = "data"
  "nip-owner" = "platform"
  "nip-run"   = "prod" # long-lived: the stage itself is the run
}
