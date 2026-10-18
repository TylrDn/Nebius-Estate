# Mocked tests for the o11y module (no cluster, no spend): where the Grafana admin password
# comes from. command = apply runs against the mock provider only.

mock_provider "nebius" {}
mock_provider "random" {}

run "alertmanager_uses_block_storage_when_filestore_is_default" {
  command = plan

  variables {
    alertmanager_enabled = true
  }

  assert {
    condition     = try(local.prometheus_set["prometheus.alertmanager.persistence.storageClass"], null) == "compute-csi-default-sc"
    error_message = "Alertmanager must explicitly select block storage, independent of the cluster default StorageClass."
  }
}

variables {
  cluster_id = "mk8scluster-e00mock"
  parent_id  = "project-e00mock"
}

run "fallback_generates_a_password_held_in_state" {
  command = plan

  assert {
    condition     = length(random_password.grafana_admin) == 1 && output.grafana_admin_secret.source == "state"
    error_message = "without a SecretStash secret the module falls back to random_password"
  }
}

run "secretstash_plan_needs_no_payload" {
  command = plan

  variables {
    grafana_admin_secret_id = "mbsec-e00mock"
  }

  assert {
    condition     = length(random_password.grafana_admin) == 0 && output.grafana_admin_password == null
    error_message = "with a SecretStash secret no password is generated or output"
  }
  assert {
    condition     = output.grafana_admin_secret.source == "secretstash" && output.grafana_admin_secret.secret_id == "mbsec-e00mock" && output.grafana_admin_secret.version_id == null
    error_message = "only the secret reference (no value) is reported"
  }
  assert {
    condition     = length(nebius_applications_v1alpha1_k8s_release.prometheus) == 1
    error_message = "the plan identity can plan the release without reading the payload"
  }
}

run "secretstash_apply_without_the_payload_is_refused" {
  command = apply

  variables {
    grafana_admin_secret_id = "mbsec-e00mock"
  }

  expect_failures = [nebius_applications_v1alpha1_k8s_release.prometheus]
}

run "secretstash_apply_with_the_payload" {
  command = apply

  variables {
    grafana_admin_secret_id         = "mbsec-e00mock"
    grafana_admin_secret_version_id = "mbsecver-e00mock"
    grafana_admin_password          = "mock-password"
  }

  assert {
    condition     = length(random_password.grafana_admin) == 0 && output.grafana_admin_password == null && output.grafana_admin_secret.version_id == "mbsecver-e00mock"
    error_message = "the password comes from the ephemeral variable; nothing is generated or output"
  }
}

run "password_without_its_secret_is_refused" {
  command = plan

  variables {
    grafana_admin_password = "mock-password"
  }

  expect_failures = [nebius_applications_v1alpha1_k8s_release.prometheus]
}

run "rejects_a_malformed_secret_id" {
  command = plan

  variables {
    grafana_admin_secret_id = "e00mock"
  }

  expect_failures = [var.grafana_admin_secret_id]
}

run "rejects_a_malformed_version_id" {
  command = plan

  variables {
    grafana_admin_secret_id         = "mbsec-e00mock"
    grafana_admin_secret_version_id = "v2"
  }

  expect_failures = [var.grafana_admin_secret_version_id]
}

run "grafana_off_has_no_password" {
  command = plan

  variables {
    prometheus_enabled = false
  }

  assert {
    condition     = length(random_password.grafana_admin) == 0 && output.grafana_admin_secret == null && output.grafana_admin_password == null
    error_message = "no Prometheus/Grafana: no password from either path"
  }
}

# ---- what the grafana-and-prometheus release is sent (R14 provisioning, live-found 2026-10-12) ----
# The release's `sensitive.values` is write-only (absent from the plan), so these runs assert on the
# document the module builds (local.prometheus_values) and on the non-secret `provisioning` output.

run "rules_ship_with_prometheus_even_without_alertmanager" {
  command = plan

  variables {
    alerting_rules = { groups = [{ name = "nip-test", rules = [{ alert = "NipTestRule", expr = "up == 0" }] }] }
  }

  assert {
    condition     = yamldecode(local.prometheus_values).prometheus.serverFiles["alerting_rules.yml"].groups[0].rules[0].alert == "NipTestRule"
    error_message = "the rule groups reach serverFiles.alerting_rules.yml whether or not Alertmanager runs"
  }
  assert {
    condition     = contains(yamldecode(local.prometheus_values).prometheus.serverFiles["prometheus.yml"].rule_files, "/etc/config/alerting_rules.yml")
    error_message = "prometheus.yml names the rule file explicitly instead of relying on the app's defaults"
  }
  assert {
    condition     = !can(yamldecode(local.prometheus_values).prometheus.alertmanager) && local.prometheus_set["prometheus.alertmanager.enabled"] == "false"
    error_message = "no Alertmanager values while it is off"
  }
  assert {
    condition     = output.provisioning.alerting.rules == 1 && output.provisioning.alerting.rule_groups == ["nip-test"] && output.provisioning.alerting.alertmanager == false
    error_message = "the plan reports what alerting is sent"
  }
}

run "alertmanager_inline_config" {
  command = plan

  variables {
    alertmanager_enabled = true
    alerting_rules       = { groups = [{ name = "nip-test", rules = [{ alert = "NipTestRule", expr = "up == 0" }] }] }
  }

  assert {
    condition     = local.prometheus_set["prometheus.alertmanager.enabled"] == "true" && yamldecode(local.prometheus_values).prometheus.alertmanager.config.route.receiver == "null"
    error_message = "Alertmanager on with the inline (null-receiver) config"
  }
  assert {
    condition     = !can(yamldecode(local.prometheus_values).prometheus.server.alertmanagers)
    error_message = "Prometheus finds the Alertmanager by the chart's own pod discovery; no static target"
  }
  assert {
    condition     = output.provisioning.alerting.receiver_config == "inline"
    error_message = "the plan says where the receivers come from"
  }
}

run "alertmanager_config_from_a_secret_uses_the_subchart_keys" {
  command = plan

  variables {
    alertmanager_enabled       = true
    alertmanager_config_secret = "alertmanager-config"
  }

  assert {
    condition = (
      yamldecode(local.prometheus_values).prometheus.alertmanager.extraSecretMounts[0].secretName == "alertmanager-config" &&
      yamldecode(local.prometheus_values).prometheus.alertmanager.extraSecretMounts[0].mountPath == "/etc/alertmanager-secret" &&
      yamldecode(local.prometheus_values).prometheus.alertmanager.extraArgs["config.file"] == "/etc/alertmanager-secret/alertmanager.yml"
    )
    error_message = "the Secret is mounted and named as the config file (alertmanager chart extraSecretMounts + extraArgs)"
  }
  assert {
    condition     = !can(yamldecode(local.prometheus_values).prometheus.alertmanager.config) && !contains(keys(local.prometheus_set), "prometheus.alertmanager.configFromSecret")
    error_message = "no inline config, and not the configFromSecret key the alertmanager subchart (2.x) does not have"
  }
  assert {
    condition     = output.provisioning.alerting.receiver_config == "secret/alertmanager-config"
    error_message = "the plan names the Secret"
  }
}

run "datasources_provisioned_with_a_token_secret" {
  command = plan

  variables {
    grafana_datasources             = yamldecode(file("../../../recipes/observability/grafana/datasources.yaml")).datasources
    grafana_datasource_token_secret = "grafana-nebius-token"
  }

  assert {
    condition = (
      [for d in yamldecode(local.prometheus_values).grafana.datasources["nebius.yaml"].datasources : d.uid] == ["nebius-provider-metrics", "nebius-ingested-metrics", "nebius-logs", "nebius-traces"] &&
      yamldecode(local.prometheus_values).grafana.datasources["nebius.yaml"].apiVersion == 1
    )
    error_message = "the four data sources of grafana/datasources.yaml are provisioned in the in-cluster Grafana, in their own file"
  }
  assert {
    condition     = alltrue([for d in yamldecode(local.prometheus_values).grafana.datasources["nebius.yaml"].datasources : d.isDefault == false])
    error_message = "none is marked default: the app may provision its own default source, and Grafana refuses two defaults"
  }
  assert {
    condition = (
      yamldecode(local.prometheus_values).grafana.env.NEBIUS_PROJECT_ID == "project-e00mock" &&
      yamldecode(local.prometheus_values).grafana.envFromSecrets == [{ name = "grafana-nebius-token", optional = true }]
    )
    error_message = "the project comes from parent_id; the token only by reference to an optional Secret (never in Terraform)"
  }
  assert {
    condition     = strcontains(local.prometheus_values, "$${PROMETHEUS_TOKEN}") && strcontains(local.prometheus_values, "$${NEBIUS_PROJECT_ID}")
    error_message = "Grafana expands the placeholders from its environment; no value is substituted by Terraform"
  }
  assert {
    condition     = output.provisioning.datasources.provisioned && length(output.provisioning.datasources.uids) == 4 && output.provisioning.datasources.missing_input == null
    error_message = "the plan reports the provisioned sources"
  }
}

run "datasources_without_a_token_secret_are_not_provisioned_and_the_plan_says_why" {
  command = plan

  variables {
    grafana_datasources = yamldecode(file("../../../recipes/observability/grafana/datasources.yaml")).datasources
  }

  assert {
    condition     = !can(yamldecode(local.prometheus_values).grafana)
    error_message = "without a token there is nothing to authenticate with: no data sources are sent"
  }
  assert {
    condition     = !output.provisioning.datasources.provisioned && strcontains(output.provisioning.datasources.missing_input, "OBSERVABILITY static key")
    error_message = "the plan names the missing Nebius-side input"
  }
}

run "rejects_a_malformed_token_secret_name" {
  command = plan

  variables {
    grafana_datasource_token_secret = "Grafana_Token"
  }

  expect_failures = [var.grafana_datasource_token_secret]
}
