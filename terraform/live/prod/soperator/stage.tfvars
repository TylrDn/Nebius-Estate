# Stage overrides applied after profiles/lab.tfvars (last -var-file wins). Hand-maintained.
# prod: the recipe's production gate (merge-request URL), data-holding filesystems protected
# from deletion, backups on. Sizing (GPU nodesets, accounting, telemetry) is a customer
# decision recorded in docs/evidence when it is made; the lab sizing is the floor, not a target.
company_name = "nip-prod"
production   = true
# iam_merge_request_url is required when production = true. The recipe's own terraform.tfvars
# sets it to "" and a var file beats TF_VAR_*, so pass it on the command line at plan time:
#   terraform plan ... -var iam_merge_request_url='https://<your-git-host>/.../merge_requests/<id>'
filestore_jail = {
  spec = {
    size_gibibytes       = 2048
    block_size_kibibytes = 4
    forbid_deletion      = true
  }
}
filestore_jail_submounts = [{
  name       = "data"
  mount_path = "/data"
  spec = {
    size_gibibytes       = 2048
    block_size_kibibytes = 4
    forbid_deletion      = true
  }
}]
backups_enabled = "auto" # jails <= 12 TiB; backups_password via TF_VAR_backups_password, never committed
