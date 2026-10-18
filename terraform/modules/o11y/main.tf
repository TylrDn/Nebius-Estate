# Observability from the Nebius Marketplace, as in
# nebius-solutions-library/modules/o11y @ soperator-v4.1.13-2 (d1c15ca):
#   - nebius/grafana-and-prometheus  (Prometheus + Grafana; admin password below). Kept for
#     evaluating the PromQL rules in platform/alerts: Nebius-managed alerts cover only Compute VMs
#     and Object Storage buckets (https://docs.nebius.com/observability/alerts).
#   - nebius/nebius-observability-agent: ships metrics, container logs and traces to Nebius
#     Observability (preview, free of charge; 14-day retention for metrics and logs,
#     https://docs.nebius.com/observability/resources/quotas-limits). Logs are queried in the
#     console, with `nebius` CLI or LogCLI (https://docs.nebius.com/observability/logs/nebius-cli).
# Loki is intentionally not included: the agent already keeps container logs for 14 days in
# Nebius Logging. Add it only when logs must be kept longer than that; upstream's Loki path
# needs a MysteryBox-delivered S3 key and three buckets.
#
# Grafana is reached with `kubectl port-forward`, never a public LoadBalancer
# (docs/security.md). Its admin password comes from exactly one of two places:
#   - SecretStash (grafana_admin_secret_id set): the password is a payload entry of a SecretStash
#     secret (API/CLI/provider name `mysterybox`) created out of band. The caller reads it right
#     before `terraform apply` and passes it as the ephemeral variable grafana_admin_password
#     (TF_VAR_grafana_admin_password, the provider's ephemeral-variable pattern,
#     terraform-provider/sensitive-values). It goes only into the write-only `sensitive.set`, so it
#     is in neither the plan nor the state; only the secret id and the pinned version id are, as
#     part of the `version` hash. A plan that is only reviewed does not need the value
#     (write-only fields are not diffed), so only the identity that plans-and-applies needs
#     `mysterybox.payload-viewer` on the secret.
#     Why not the `nebius_mysterybox_v1_secret_payload_entry` ephemeral resource the docs also
#     show: `terraform test` mock providers reject any configuration that contains an ephemeral
#     resource ("No ephemeral resource types in mock providers", Terraform 1.11-1.16), which would
#     break every mocked plan test of the stacks and live roots that call this module.
#   - fallback (no secret id): a `random_password`. Its result IS in state (sensitive) and is
#     exposed as the sensitive output grafana_admin_password.
# Either way the chart keeps the value in a Kubernetes Secret inside the cluster.

resource "random_password" "grafana_admin" {
  count = var.prometheus_enabled && !local.grafana_from_secret ? 1 : 0

  length           = 20
  special          = true
  override_special = "@#%"
}

resource "nebius_applications_v1alpha1_k8s_release" "prometheus" {
  count = var.prometheus_enabled ? 1 : 0

  cluster_id = var.cluster_id
  parent_id  = var.parent_id

  application_name = "grafana-and-prometheus"
  namespace        = var.namespace
  product_slug     = "nebius/grafana-and-prometheus"

  # `sensitive.set` is write-only: the provider does not diff it, so `version` carries a hash
  # of the values and changes when they do (docs: terraform-provider/sensitive-values). The
  # SecretStash password is ephemeral and cannot be hashed into `version`; the secret reference
  # (id and pinned version id) is hashed instead, so pinning a new version re-sends the set.
  sensitive = {
    version = md5(jsonencode(concat([local.prometheus_set, local.prometheus_values], local.grafana_secret_ref)))
    set     = var.grafana_admin_password == null ? local.prometheus_set : merge(local.prometheus_set, { "grafana.adminPassword" = var.grafana_admin_password })
    values  = local.prometheus_values
  }

  lifecycle {
    precondition {
      condition     = local.grafana_from_secret || var.grafana_admin_password == null
      error_message = "grafana_admin_password is only read with grafana_admin_secret_id (the SecretStash secret it came from); without it the module generates the password."
    }
    # A reviewed-only plan may run without the value (the plan identity cannot read payloads); an apply may not,
    # or the release would be sent without the admin password the secret holds.
    precondition {
      condition     = !local.grafana_from_secret || var.grafana_admin_password != null || !terraform.applying
      error_message = "grafana_admin_secret_id is set: export TF_VAR_grafana_admin_password from that secret before the plan you apply (docs/credentials.md#secretstash)."
    }
  }
}

locals {
  grafana_from_secret = var.prometheus_enabled && var.grafana_admin_secret_id != null
  # Non-secret reference to the password's source; empty on the random_password path so its
  # `version` hash is unchanged from before the SecretStash option existed.
  grafana_secret_ref = local.grafana_from_secret ? [{
    secret_id  = var.grafana_admin_secret_id
    version_id = var.grafana_admin_secret_version_id
  }] : []
  # Only the fallback password is a plain (state-held) value; the SecretStash one is merged into
  # the write-only set at the resource.
  grafana_password_set = local.grafana_from_secret ? {} : { for p in random_password.grafana_admin : "grafana.adminPassword" => p.result }

  # Structured values the string-only `set` map cannot carry, as one YAML document. Keys are those of
  # the charts the Marketplace app wraps (prometheus-community/prometheus with its alertmanager
  # subchart, and grafana); the app's own chart versions are not published (unknown, see
  # docs/solutions/gaps-and-discrepancies.md), so recipes/observability/acceptance.sh reads the running
  # configuration back and names any part that did not arrive (runbooks/observability.md).
  #   rules          serverFiles."alerting_rules.yml", shipped whenever Prometheus runs: rules evaluate
  #                  and show in /api/v1/rules without Alertmanager; only notification needs it.
  #                  prometheus.yml's rule_files is restated (the chart default) so an app-level
  #                  override cannot leave the file unread.
  #   alertmanager   inline `config`, or a pre-created Secret mounted with extraSecretMounts and named
  #                  by extraArgs."config.file" (the subchart has no `configFromSecret`).
  #   grafana        the Nebius data sources of recipes/observability/grafana/datasources.yaml in a
  #                  provisioning file of their own (nebius.yaml), with ${NEBIUS_PROJECT_ID} and
  #                  ${PROMETHEUS_TOKEN} expanded by Grafana from its environment: the project from
  #                  parent_id, the token from an optional pre-created Secret, so it never passes
  #                  through Terraform. isDefault is cleared: Grafana refuses two default sources.
  rule_groups = try(var.alerting_rules.groups, [])
  # Each part is present only when it applies (a filtered one-key `for`, so the branches need not
  # share a type).
  prometheus_values_prometheus = merge(
    { for k, v in {
      serverFiles = {
        "alerting_rules.yml" = { groups = local.rule_groups }
        "prometheus.yml"     = { rule_files = local.prometheus_rule_files }
      }
    } : k => v if length(local.rule_groups) > 0 },
    { for k, v in { alertmanager = { config = var.alertmanager_config } } : k => v if var.alertmanager_enabled && var.alertmanager_config_secret == null },
    { for k, v in { alertmanager = {
      extraSecretMounts = [{ name = "alertmanager-config-secret", mountPath = local.alertmanager_secret_dir, subPath = "", secretName = var.alertmanager_config_secret, readOnly = true }]
      extraArgs         = { "config.file" = "${local.alertmanager_secret_dir}/alertmanager.yml" }
    } } : k => v if var.alertmanager_enabled && var.alertmanager_config_secret != null },
  )
  prometheus_values_grafana = { for k, v in {
    env            = { NEBIUS_PROJECT_ID = var.parent_id }
    envFromSecrets = [{ name = coalesce(var.grafana_datasource_token_secret, "-"), optional = true }]
    datasources = { "nebius.yaml" = {
      apiVersion  = 1
      datasources = try([for d in var.grafana_datasources : merge(d, { isDefault = false })], [])
    } }
  } : k => v if local.datasources_on }
  prometheus_values = yamlencode(merge(
    { for k, v in { prometheus = local.prometheus_values_prometheus } : k => v if length(local.prometheus_values_prometheus) > 0 },
    { for k, v in { grafana = local.prometheus_values_grafana } : k => v if length(local.prometheus_values_grafana) > 0 },
  ))
  # The prometheus chart's default rule_files (values.yaml serverFiles."prometheus.yml").
  prometheus_rule_files   = ["/etc/config/recording_rules.yml", "/etc/config/alerting_rules.yml", "/etc/config/rules", "/etc/config/alerts"]
  alertmanager_secret_dir = "/etc/alertmanager-secret"

  datasources_requested = var.prometheus_enabled && var.grafana_datasources != null && try(length(var.grafana_datasources), 0) > 0
  datasources_on        = local.datasources_requested && var.grafana_datasource_token_secret != null
  datasources_missing_input = local.datasources_requested && var.grafana_datasource_token_secret == null ? join(" ", [
    "grafana_datasource_token_secret is unset, so the in-cluster Grafana gets none of the Nebius data sources.",
    "They need an OBSERVABILITY static key of a service account in a group with viewer (docs/credentials.md#observability-static-key):",
    "create the Secret in the ${var.namespace} namespace with key PROMETHEUS_TOKEN and set grafana_datasource_token_secret to its name (runbooks/observability.md).",
  ]) : null
  prometheus_set = var.prometheus_enabled ? merge(local.grafana_password_set, {
    "prometheus.alertmanager.enabled"             = tostring(var.alertmanager_enabled)
    "prometheus.prometheus-pushgateway.enabled"   = "false"
    "prometheus.prometheus-node-exporter.enabled" = tostring(var.node_exporter_enabled)
    "prometheus.server.scrape_interval"           = var.scrape_interval
    "prometheus.server.retention"                 = var.retention
    "prometheus.server.persistentVolume.size"     = var.prometheus_pv_size
    # Explicit: the default StorageClass flips to the shared filesystem once the CSI driver is
    # installed, and a TSDB on virtiofs is the wrong place. A compute disk is created for the
    # PVC; it is NOT labelled and outlives the cluster (scripts/leftovers.sh lists pvc-* disks).
    "prometheus.server.persistentVolume.storageClass" = var.prometheus_storage_class
    }, var.alertmanager_enabled ? {
    # The subchart uses persistence.storageClass, not the Prometheus server's persistentVolume key.
    # Never inherit the filesystem CSI class for Alertmanager's database PVC (R1-20).
    "prometheus.alertmanager.persistence.storageClass" = var.prometheus_storage_class
  } : {}) : {}
  agent_set = merge({
    "config.metrics.collectK8sClusterMetrics" = tostring(var.collect_k8s_cluster_metrics)
    "config.logs.enabled"                     = tostring(var.agent_logs_enabled)
    "config.traces.enabled"                   = tostring(var.agent_traces_enabled)
    }, var.agent_node_label_allowlist == null ? {} : {
    # The agent attaches every Node label to scraped metrics by default; GPU Operator and Node
    # Feature Discovery labels push series past the per-series label limit, and such series are
    # dropped silently (agent changelog v1.0.6, docs/solutions/gaps-and-discrepancies.md).
    "config.metrics.labelAllowlist.nodeLabels" = var.agent_node_label_allowlist
  })
}

resource "nebius_applications_v1alpha1_k8s_release" "agent" {
  count = var.nebius_agent_enabled ? 1 : 0

  cluster_id = var.cluster_id
  parent_id  = var.parent_id

  application_name = "nebius-observability-agent"
  namespace        = var.namespace
  product_slug     = "nebius/nebius-observability-agent"

  sensitive = {
    version = md5(jsonencode(local.agent_set))
    set     = local.agent_set
  }
}
