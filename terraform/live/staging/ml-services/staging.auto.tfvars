# Sizing for stage staging (hand-maintained; the stage policy is in platform/stages.yaml).
# parent_id, region and iam_token come from scripts/bootstrap-backend.sh staging ml-services.
# CI has editor, not admin. Provision pull IAM separately; see runbooks/ml-services.md.
create_node_service_account = false
