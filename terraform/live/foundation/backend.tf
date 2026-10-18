# The foundation's own state: a bucket bootstrapped by hand once
# (`source scripts/bootstrap-backend.sh foundation foundation`) — nothing can create the first
# bucket for you. Key: stages/foundation/foundation.tfstate.
terraform {
  backend "s3" {
    skip_region_validation      = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    skip_metadata_api_check     = true
    use_lockfile                = true
  }
}
