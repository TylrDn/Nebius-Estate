# Sizing for stage sandbox of the data stack (hand-maintained; the stage policy is in platform/stages.yaml).
# parent_id, region and iam_token come from `source scripts/bootstrap-backend.sh sandbox data`; never commit them.

filesystem_size_gib        = 256
checkpoint_noncurrent_days = 7

# Sandbox requires nip-run and nip-ttl-expires (docs/cost.md); pass them per run:
#   export TF_VAR_labels='{"nip-owner":"platform","nip-run":"ticket-123","nip-ttl-expires":"2026-10-31T18:00:00Z"}'
