mock_provider "nebius" {}

variables {
  cluster_id       = "mk8scluster-e00mock000000000"
  name             = "ng"
  subnet_id        = "vpcsubnet-e00mock0000000000"
  platform         = "gpu-h100-sxm"
  preset           = "1gpu-16vcpu-200gb"
  fixed_node_count = 1
}

run "gpu_cluster_requires_8gpu_preset" {
  command = plan

  variables {
    gpu_cluster_id     = "gpucluster-e00mock0000000000"
    boot_disk_size_gib = 512
  }

  expect_failures = [nebius_mk8s_v1_node_group.this]
}

run "gpu_node_needs_large_boot_disk" {
  command = plan

  variables {
    boot_disk_size_gib = 128
  }

  expect_failures = [nebius_mk8s_v1_node_group.this]
}

run "rejects_unknown_driver_preset" {
  command = plan

  variables {
    drivers_preset     = "cuda11"
    boot_disk_size_gib = 512
  }

  expect_failures = [var.drivers_preset]
}

run "cpu_node_with_filestore_mounts_it" {
  command = plan

  variables {
    platform = "cpu-d3"
    preset   = "8vcpu-32gb"
    filesystem = {
      id         = "computefilesystem-e00mock00"
      mount_tag  = "data"
      mount_path = "/mnt/data"
    }
  }

  # template.* is computed by the provider at plan time with mocks, so assert on
  # the locals/inputs that feed it.
  assert {
    condition     = strcontains(local.cloud_init, "virtiofs") && strcontains(local.cloud_init, "/mnt/data")
    error_message = "cloud-init must mount the filesystem via virtiofs at mount_path"
  }
  assert {
    condition     = strcontains(local.cloud_init, "\"defaults,nofail\"")
    error_message = "the virtiofs mount must carry nofail or a node whose filesystem is gone will not boot (docs)"
  }
  assert {
    condition     = !local.is_gpu && var.drivers_preset == null
    error_message = "CPU nodes must not be treated as GPU nodes"
  }
  assert {
    condition     = !strcontains(local.cloud_init, "package_update:")
    error_message = "mounting the filesystem needs no package, so no package_update"
  }
}

run "preemptible_follows_spot_price_by_default" {
  command = plan

  variables {
    boot_disk_size_gib = 512
    preemptible        = true
  }

  assert {
    condition     = nebius_mk8s_v1_node_group.this.template.preemptible != null && nebius_mk8s_v1_node_group.this.template.follows_spot_price != null && nebius_mk8s_v1_node_group.this.template.spot_pricing_policy == null
    error_message = "preemptible without a policy id must set follows_spot_price (docs: one spot pricing setting is required)"
  }
}

run "preemptible_with_policy_sets_no_follow" {
  command = plan

  variables {
    boot_disk_size_gib     = 512
    preemptible            = true
    spot_pricing_policy_id = "spotpricingpolicy-e00mock"
  }

  assert {
    condition     = nebius_mk8s_v1_node_group.this.template.spot_pricing_policy.id == "spotpricingpolicy-e00mock" && nebius_mk8s_v1_node_group.this.template.follows_spot_price == null
    error_message = "a spot pricing policy id must be passed through and exclude follows_spot_price"
  }
}

run "on_demand_sets_no_spot_fields" {
  command = plan

  variables {
    boot_disk_size_gib = 512
  }

  assert {
    condition     = nebius_mk8s_v1_node_group.this.template.preemptible == null && nebius_mk8s_v1_node_group.this.template.follows_spot_price == null && nebius_mk8s_v1_node_group.this.template.spot_pricing_policy == null
    error_message = "on-demand node groups carry no spot fields"
  }
}

run "rollout_surge_sets_surge_one_unavailable_zero" {
  command = plan

  variables {
    boot_disk_size_gib = 512
    rollout_surge      = true
  }

  assert {
    condition     = nebius_mk8s_v1_node_group.this.strategy.max_surge.count == 1 && nebius_mk8s_v1_node_group.this.strategy.max_unavailable.count == 0
    error_message = "rollout_surge must create the replacement node before draining the old one"
  }
}

run "no_filesystem_no_mount_block" {
  command = plan

  variables {
    boot_disk_size_gib = 512
  }

  assert {
    condition     = !strcontains(local.cloud_init, "mounts:") && !strcontains(local.cloud_init, "users:")
    error_message = "without a filesystem or ssh key cloud-init must contain no mounts/users"
  }
  assert {
    condition     = !strcontains(local.cloud_init, "package_update:") && !strcontains(local.cloud_init, "packages:")
    error_message = "node boot must not depend on a package mirror (no package step is needed)"
  }
}

run "rejects_both_sizing_modes" {
  command = plan

  variables {
    boot_disk_size_gib = 512
    autoscaling        = { min = 1, max = 2 }
  }

  expect_failures = [nebius_mk8s_v1_node_group.this]
}

run "strict_reservation_cannot_be_preemptible" {
  command = plan

  variables {
    preemptible = true
    reservation = { policy = "STRICT", reservation_ids = ["reservation-e00mock"] }
  }

  expect_failures = [nebius_mk8s_v1_node_group.this]
}

run "auto_reservation_cannot_be_preemptible" {
  command = plan

  variables {
    preemptible = true
    reservation = { policy = "AUTO" }
  }

  expect_failures = [nebius_mk8s_v1_node_group.this]
}

run "reservation_rejected_on_cpu_group" {
  command = plan

  variables {
    platform           = "cpu-d3"
    preset             = "4vcpu-16gb"
    drivers_preset     = null
    boot_disk_size_gib = 128
    reservation        = { policy = "AUTO" }
  }

  expect_failures = [nebius_mk8s_v1_node_group.this]
}

run "auto_reservation_reaches_the_template" {
  command = plan

  variables {
    reservation        = { policy = "AUTO" }
    security_group_ids = ["securitygroup-e00mock"]
    boot_disk_size_gib = 512
  }

  assert {
    condition     = output.reservation_policy.policy == "AUTO" && output.reservation_policy.reservation_ids == null && output.security_group_ids[0] == "securitygroup-e00mock"
    error_message = "AUTO reservation without ids and the security group must reach the template"
  }
}

run "forbid_reservation_reaches_the_template" {
  command = plan

  variables {
    reservation        = { policy = "FORBID" }
    boot_disk_size_gib = 512
  }

  assert {
    condition     = output.reservation_policy.policy == "FORBID" && output.reservation_policy.reservation_ids == null
    error_message = "FORBID (common pool only) must reach the template without ids"
  }
}

run "forbid_reservation_rejects_ids" {
  command = plan

  variables {
    reservation        = { policy = "FORBID", reservation_ids = ["capacityblockgroup-e00mock"] }
    boot_disk_size_gib = 512
  }

  expect_failures = [nebius_mk8s_v1_node_group.this]
}

run "preemptible_rejected_on_cpu_group" {
  command = plan

  variables {
    platform           = "cpu-d3"
    preset             = "8vcpu-32gb"
    boot_disk_size_gib = 128
    preemptible        = true
  }

  expect_failures = [nebius_mk8s_v1_node_group.this]
}

run "gpu_cluster_rejects_rtx6000_8gpu" {
  command = plan

  variables {
    platform           = "gpu-rtx6000"
    preset             = "8gpu-192vcpu-1744gb"
    gpu_cluster_id     = "gpucluster-e00mock0000000000"
    boot_disk_size_gib = 512
  }

  expect_failures = [nebius_mk8s_v1_node_group.this]
}

run "filestore_mount_uses_image_default_read_ahead" {
  command = plan

  variables {
    boot_disk_size_gib = 512
    filesystem = {
      id         = "computefilesystem-e00mock00"
      mount_tag  = "data"
      mount_path = "/mnt/data"
    }
  }

  assert {
    condition     = !can(yamldecode(local.cloud_init).write_files) && !strcontains(local.cloud_init, "udevadm")
    error_message = "a node must mount storage without installing optional documentation-derived tuning"
  }
  assert {
    condition     = can(yamldecode(local.cloud_init))
    error_message = "cloud-init must stay valid YAML"
  }
}

run "service_account_and_instance_metadata_reach_the_template" {
  command = plan

  variables {
    boot_disk_size_gib       = 512
    service_account_id       = "serviceaccount-e00mock"
    instance_metadata_labels = { "nebius.o11y.systemd-logs-collection.enabled" = "true" }
  }

  assert {
    condition     = nebius_mk8s_v1_node_group.this.template.service_account_id == "serviceaccount-e00mock" && nebius_mk8s_v1_node_group.this.template.instance_metadata.labels["nebius.o11y.systemd-logs-collection.enabled"] == "true"
    error_message = "service_account_id and instance_metadata_labels must reach the node template"
  }
}

run "no_instance_metadata_by_default" {
  command = plan

  variables {
    boot_disk_size_gib = 512
  }

  assert {
    condition     = nebius_mk8s_v1_node_group.this.template.instance_metadata == null && nebius_mk8s_v1_node_group.this.template.service_account_id == null
    error_message = "without inputs the template carries no instance metadata and no service account"
  }
}

# A "CPU" group carrying GPUs would bypass every stage GPU cap: an <n>gpu-* preset needs a gpu-*
# platform, and the platform must be cpu-* or gpu-* (the stacks also refuse gpu-* for their CPU group).
run "rejects_a_platform_outside_the_cpu_and_gpu_families" {
  command = plan

  variables {
    platform           = "h100"
    preset             = "1gpu-16vcpu-200gb"
    boot_disk_size_gib = 512
  }

  expect_failures = [var.platform]
}

run "rejects_gpu_preset_on_cpu_platform" {
  command = plan

  variables {
    platform           = "cpu-d3"
    preset             = "8gpu-128vcpu-1600gb"
    boot_disk_size_gib = 512
  }

  expect_failures = [var.platform]
}

run "ssh_key_is_rendered_as_one_yaml_string" {
  command = plan

  variables {
    boot_disk_size_gib = 512
    ssh_public_key     = "ssh-ed25519 AAAAC3Nza mock\n    sudo: ALL=(ALL) NOPASSWD:ALL\n  - name: intruder"
  }

  assert {
    condition     = length(yamldecode(local.cloud_init).users) == 1 && yamldecode(local.cloud_init).users[0].ssh_authorized_keys == ["ssh-ed25519 AAAAC3Nza mock\n    sudo: ALL=(ALL) NOPASSWD:ALL\n  - name: intruder"]
    error_message = "the SSH key must be rendered as a single YAML string (yamlencode), never as raw YAML that can add users or keys"
  }
}
