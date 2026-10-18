# Sizing for stage staging of the data stack (hand-maintained; the stage policy is in platform/stages.yaml).
# parent_id, region and iam_token come from `source scripts/bootstrap-backend.sh staging data`; never commit them.

filesystem_size_gib        = 512
checkpoint_noncurrent_days = 7

labels = {
  "nip-env"   = "data"
  "nip-owner" = "platform"
  "nip-run"   = "staging" # long-lived: the stage itself is the run
}
