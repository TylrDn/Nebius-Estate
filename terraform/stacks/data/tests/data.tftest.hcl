# Plan-mode tests for the data plane (mocked provider, no spend).

mock_provider "nebius" {
  mock_resource "nebius_storage_v1_bucket" {
    defaults = { id = "storagebucket-e00mock00000000" }
  }
  mock_resource "nebius_compute_v1_filesystem" {
    defaults = { id = "computefilesystem-e00mock00" }
  }
}

variables {
  stage     = "sandbox"
  parent_id = "project-e00mock"
  region    = "eu-north1"
  labels = {
    "nip-env"         = "data"
    "nip-owner"       = "ci"
    "nip-run"         = "mock"
    "nip-ttl-expires" = timeadd(timestamp(), "24h") # inside the 7-day sandbox window
  }
}

run "checkpoints_are_versioned_and_expire_datasets_are_not" {
  command = plan

  assert {
    condition     = nebius_storage_v1_bucket.checkpoints.versioning_policy == "ENABLED" && nebius_storage_v1_bucket.datasets.versioning_policy == "DISABLED"
    error_message = "versioning on checkpoints only"
  }
  assert {
    condition     = one([for r in nebius_storage_v1_bucket.checkpoints.lifecycle_configuration.rules : r.noncurrent_version_expiration.noncurrent_days if r.id == "expire-replaced-checkpoints"]) == 14
    error_message = "replaced checkpoints expire after the default 14 days"
  }
  assert {
    condition     = alltrue([for b in [nebius_storage_v1_bucket.datasets, nebius_storage_v1_bucket.checkpoints] : anytrue([for r in b.lifecycle_configuration.rules : r.id == "abort-incomplete-multipart"])])
    error_message = "both buckets abort stale multipart uploads"
  }
  assert {
    condition     = nebius_storage_v1_bucket.datasets.name == "nip-sandbox-datasets-e00mock"
    error_message = "bucket name carries the stage and project suffix"
  }
  assert {
    condition     = length(nebius_storage_v1_transfer.ingest) == 0 && length(module.filesystem) == 1
    error_message = "filesystem on, transfer off by default"
  }
  assert {
    condition     = anytrue([for r in nebius_storage_v1_bucket.checkpoints.lifecycle_configuration.rules : try(r.expiration.expired_object_delete_marker, false)])
    error_message = "orphaned delete markers are cleaned up once their versions expire"
  }
  assert {
    condition     = nebius_storage_v1_bucket.datasets.object_audit_logging == null
    error_message = "sandbox does not require audit logs (platform/stages.yaml)"
  }
}

run "rejects_a_prefix_that_breaks_bucket_naming" {
  command = plan

  variables {
    name = "Team_Data"
  }

  expect_failures = [var.name]
}

run "prod_protects_the_filesystem" {
  command = plan

  variables {
    stage  = "prod"
    labels = { "nip-env" = "data", "nip-owner" = "ci", "nip-run" = "prod" }
  }

  assert {
    condition     = module.filesystem[0].forbid_deletion == true
    error_message = "prod filesystem is deletion-protected by the stage policy"
  }
  assert {
    condition     = nebius_storage_v1_bucket.datasets.object_audit_logging == "MUTATE_ONLY" && nebius_storage_v1_bucket.checkpoints.object_audit_logging == "MUTATE_ONLY"
    error_message = "prod requires audit logs: bucket writes and deletes are logged"
  }
}

run "prod_refuses_an_unprotected_filesystem" {
  command = plan

  variables {
    stage           = "prod"
    forbid_deletion = false
    labels          = { "nip-env" = "data", "nip-owner" = "ci", "nip-run" = "prod" }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "transfer_without_secret_is_refused" {
  command = plan

  variables {
    transfer = {
      source_endpoint           = "https://s3.example.invalid"
      source_region             = "us-east-1"
      source_bucket             = "corpus"
      source_access_key_id      = "AKIAEXAMPLE"
      destination_access_key_id = "mock-key-id"
    }
  }

  expect_failures = [terraform_data.stage_policy]
}

run "public_source_transfer_stops_after_one_pass" {
  command = plan

  variables {
    transfer = {
      source_endpoint           = "https://s3.example.invalid"
      source_region             = "us-east-1"
      source_bucket             = "public-corpus"
      destination_access_key_id = "mock-key-id"
    }
    transfer_destination_secret_key = "mock-secret"
  }

  assert {
    condition     = nebius_storage_v1_transfer.ingest[0].overwrite_strategy == "NEVER" && nebius_storage_v1_transfer.ingest[0].after_one_iteration != null
    error_message = "safe defaults: never overwrite, one pass"
  }
  assert {
    condition     = nebius_storage_v1_transfer.ingest[0].source.s3_compatible.anonymous != null
    error_message = "no source key means an anonymous (public) source"
  }
}

run "rejects_unknown_overwrite_strategy" {
  command = plan

  variables {
    transfer = {
      source_endpoint           = "https://s3.example.invalid"
      source_region             = "us-east-1"
      source_bucket             = "corpus"
      destination_access_key_id = "mock-key-id"
      overwrite_strategy        = "ALWAYS"
    }
  }

  expect_failures = [var.transfer]
}

run "source_key_without_its_secret_is_refused" {
  command = plan

  variables {
    transfer = {
      source_endpoint           = "https://s3.example.invalid"
      source_region             = "us-east-1"
      source_bucket             = "corpus"
      source_access_key_id      = "AKIAEXAMPLE"
      destination_access_key_id = "mock-key-id"
    }
    transfer_destination_secret_key = "mock-secret"
  }

  expect_failures = [terraform_data.stage_policy]
}

run "default_region_uses_standard" {
  command = plan

  assert {
    condition     = nebius_storage_v1_bucket.datasets.default_storage_class == "STANDARD" && nebius_storage_v1_bucket.checkpoints.default_storage_class == "STANDARD"
    error_message = "eu-north1 offers STANDARD, the region default"
  }
}

run "restricted_region_defaults_to_enhanced_throughput" {
  command = plan

  variables {
    region = "uk-south1"
  }

  assert {
    condition     = nebius_storage_v1_bucket.datasets.default_storage_class == "ENHANCED_THROUGHPUT" && nebius_storage_v1_bucket.checkpoints.default_storage_class == "ENHANCED_THROUGHPUT"
    error_message = "STANDARD is not offered in uk-south1 (object-storage/storage-classes)"
  }
}

run "rejects_standard_where_not_offered" {
  command = plan

  variables {
    region                = "eu-west2"
    dataset_storage_class = "STANDARD"
  }

  expect_failures = [nebius_storage_v1_bucket.datasets]
}

run "rejects_an_undocumented_filesystem_type" {
  command = plan

  variables {
    filesystem_type = "NETWORK_HDD"
  }

  expect_failures = [var.filesystem_type]
}

run "filesystem_bucket_is_off_by_default" {
  command = plan

  assert {
    condition     = length(nebius_storage_v1_bucket.filesystem) == 0
    error_message = "the filesystem bucket (preview) is opt-in"
  }
}

run "transfer_can_write_straight_onto_the_filesystem" {
  command = plan

  variables {
    filesystem_bucket = true
    transfer = {
      source_endpoint           = "https://s3.example.invalid"
      source_region             = "us-east-1"
      source_bucket             = "public-corpus"
      source_prefix             = "corpus/v1/"
      destination_prefix        = "corpus/v1/"
      destination_access_key_id = "mock-key-id"
      requests_per_second       = 500
      to_filesystem             = true
    }
    transfer_destination_secret_key = "mock-secret"
  }

  assert {
    condition     = nebius_storage_v1_bucket.filesystem[0].filesystem_bucket.directory == "/datasets" && nebius_storage_v1_bucket.filesystem[0].name == "nip-sandbox-fs-e00mock"
    error_message = "filesystem bucket rooted at /datasets"
  }
  assert {
    condition     = nebius_storage_v1_transfer.ingest[0].destination.nebius.bucket_name == "nip-sandbox-fs-e00mock"
    error_message = "to_filesystem targets the filesystem bucket"
  }
  assert {
    condition     = nebius_storage_v1_transfer.ingest[0].limiters.requests_per_second == 500 && nebius_storage_v1_transfer.ingest[0].limiters.bandwidth_bytes_per_second == null
    error_message = "request-rate limiter passed through"
  }
}

run "transfer_to_filesystem_needs_the_filesystem_bucket" {
  command = plan

  variables {
    transfer = {
      source_endpoint           = "https://s3.example.invalid"
      source_region             = "us-east-1"
      source_bucket             = "public-corpus"
      destination_access_key_id = "mock-key-id"
      to_filesystem             = true
    }
    transfer_destination_secret_key = "mock-secret"
  }

  expect_failures = [terraform_data.stage_policy]
}

run "rejects_a_source_endpoint_with_a_trailing_slash" {
  command = plan

  variables {
    transfer = {
      source_endpoint           = "https://s3.example.invalid/"
      source_region             = "us-east-1"
      source_bucket             = "corpus"
      destination_access_key_id = "mock-key-id"
    }
  }

  expect_failures = [var.transfer]
}

# ---- Transfer keys from SecretStash (transfer_secret_id) ----

run "secretstash_transfer_plans_without_the_keys" {
  command = plan

  variables {
    transfer = {
      source_endpoint           = "https://s3.example.invalid"
      source_region             = "us-east-1"
      source_bucket             = "corpus"
      source_access_key_id      = "AKIAEXAMPLE"
      destination_access_key_id = "mock-key-id"
    }
    transfer_secret_id         = "mbsec-e00mock"
    transfer_secret_version_id = "mbsecver-e00mock"
  }

  assert {
    condition     = nebius_storage_v1_transfer.ingest[0].sensitive.version == "1/mbsec-e00mock/mbsecver-e00mock"
    error_message = "the secret reference (never a value) versions the write-only keys"
  }
}

run "secretstash_transfer_apply_without_the_keys_is_refused" {
  command = apply

  variables {
    transfer = {
      source_endpoint           = "https://s3.example.invalid"
      source_region             = "us-east-1"
      source_bucket             = "corpus"
      source_access_key_id      = "AKIAEXAMPLE"
      destination_access_key_id = "mock-key-id"
    }
    transfer_secret_id              = "mbsec-e00mock"
    transfer_destination_secret_key = "mock-secret"
  }

  expect_failures = [terraform_data.stage_policy]
}

run "secretstash_transfer_applies_with_the_keys" {
  command = apply

  variables {
    transfer = {
      source_endpoint           = "https://s3.example.invalid"
      source_region             = "us-east-1"
      source_bucket             = "corpus"
      source_access_key_id      = "AKIAEXAMPLE"
      destination_access_key_id = "mock-key-id"
    }
    transfer_secret_id              = "mbsec-e00mock"
    transfer_source_secret_key      = "mock-source-secret"
    transfer_destination_secret_key = "mock-secret"
  }

  assert {
    condition     = length(nebius_storage_v1_transfer.ingest) == 1 && nebius_storage_v1_transfer.ingest[0].sensitive.version == "1/mbsec-e00mock"
    error_message = "unpinned: the version names the secret only"
  }
}

run "manual_keys_keep_the_plain_secrets_version" {
  command = plan

  variables {
    transfer = {
      source_endpoint           = "https://s3.example.invalid"
      source_region             = "us-east-1"
      source_bucket             = "public-corpus"
      destination_access_key_id = "mock-key-id"
      secrets_version           = "2"
    }
    transfer_destination_secret_key = "mock-secret"
  }

  assert {
    condition     = nebius_storage_v1_transfer.ingest[0].sensitive.version == "2"
    error_message = "the TF_VAR fallback is versioned by transfer.secrets_version alone"
  }
}

run "secret_id_without_a_transfer_is_refused" {
  command = plan

  variables {
    transfer_secret_id = "mbsec-e00mock"
  }

  expect_failures = [terraform_data.stage_policy]
}

run "rejects_a_malformed_transfer_secret_id" {
  command = plan

  variables {
    transfer_secret_id = "secret-e00mock"
  }

  expect_failures = [var.transfer_secret_id]
}
