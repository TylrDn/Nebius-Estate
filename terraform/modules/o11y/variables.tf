variable "cluster_id" {
  type = string
}

variable "parent_id" {
  type = string
}

variable "namespace" {
  type    = string
  default = "o11y"
}

variable "prometheus_enabled" {
  type    = bool
  default = true
}

variable "node_exporter_enabled" {
  type    = bool
  default = true
}

variable "scrape_interval" {
  type    = string
  default = "30s"
}

variable "retention" {
  type    = string
  default = "7d"
}

variable "prometheus_pv_size" {
  type    = string
  default = "25Gi"
}

variable "prometheus_storage_class" {
  description = "StorageClass for the Prometheus TSDB volume; a block disk (compute-csi-default-sc), never the shared virtiofs class. The disk is created by the CSI driver and must be deleted at teardown (scripts/leftovers.sh)."
  type        = string
  default     = "compute-csi-default-sc"
}

variable "alertmanager_enabled" {
  description = "Deploy the chart's Alertmanager and load the alerting rules (staging/prod via the stage policy). Receivers are configured per customer in alertmanager_config."
  type        = bool
  default     = false
}

variable "alerting_rules" {
  description = "Prometheus alerting rule groups (the chart's serverFiles.alerting_rules.yml) — decoded from platform/alerts/*.yaml by the stack."
  type        = any
  default     = { groups = [] }
}

variable "alertmanager_config_secret" {
  description = "Name of a pre-created Kubernetes Secret in the o11y namespace whose `alertmanager.yml` key holds the full Alertmanager config (routes + receivers with their webhook URLs/keys). When set it replaces alertmanager_config, so receiver credentials never pass through Terraform state. Create it out of band (runbooks/alerting.md)."
  type        = string
  default     = null
  validation {
    condition     = var.alertmanager_config_secret == null || can(regex("^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$", var.alertmanager_config_secret))
    error_message = "alertmanager_config_secret must be a Kubernetes object name (lowercase, digits, '-', '.')."
  }
}

variable "alertmanager_config" {
  description = "Alertmanager configuration (route + receivers) for receivers WITHOUT credentials. The default routes everything to a null receiver so rules fire visibly without paging anyone. For receivers that need secrets use alertmanager_config_secret instead."
  type        = any
  nullable    = false
  default = {
    route     = { receiver = "null", group_by = ["alertname", "namespace"], group_wait = "30s", group_interval = "5m", repeat_interval = "4h" }
    receivers = [{ name = "null" }]
  }
}

variable "nebius_agent_enabled" {
  description = "Install the Nebius observability agent (metrics, logs and traces to Nebius Observability)."
  type        = bool
  default     = true
}

variable "collect_k8s_cluster_metrics" {
  type    = bool
  default = false
}

variable "agent_logs_enabled" {
  description = "Agent ships container logs to Nebius Logging (chart default true; 14-day retention)."
  type        = bool
  default     = true
}

variable "agent_traces_enabled" {
  description = "Agent accepts OTLP traces and ships them to Nebius Tracing (chart default true)."
  type        = bool
  default     = true
}

variable "agent_node_label_allowlist" {
  description = "Regular expression matched against Node label names; only matching labels are attached to scraped metrics (config.metrics.labelAllowlist.nodeLabels). null = chart default (all labels). Written with [.] instead of backslashes so Helm --set escaping cannot alter it. Verify on the first deploy that GPU metrics arrive in Nebius Monitoring."
  type        = string
  default     = "^(kubernetes[.]io/.*|node[.]kubernetes[.]io/.*|topology[.]kubernetes[.]io/.*|nebius[.]com/.*|nvidia[.]com/gpu[.](product|count))$"
}

variable "grafana_admin_secret_id" {
  description = "SecretStash secret (mbsec-...) that holds the Grafana admin password, created out of band (docs/credentials.md#secretstash). Set it to take the password from grafana_admin_password instead of generating one: the password then reaches neither the plan nor the state, and the output grafana_admin_password is null. null = a generated random_password, kept in state (sensitive)."
  type        = string
  default     = null

  validation {
    condition     = var.grafana_admin_secret_id == null || can(regex("^mbsec-[a-z0-9]+$", var.grafana_admin_secret_id))
    error_message = "grafana_admin_secret_id must be a SecretStash secret ID (mbsec-...)."
  }
}

variable "grafana_admin_secret_version_id" {
  description = "Version (mbsecver-...) of grafana_admin_secret_id that grafana_admin_password was read from. It is part of the release's sensitive.version hash, so pinning a new version id is what rolls a rotated password out; null = the primary version, and a new value is then sent only with the next other change to the release."
  type        = string
  default     = null

  validation {
    condition     = var.grafana_admin_secret_version_id == null || can(regex("^mbsecver-[a-z0-9]+$", var.grafana_admin_secret_version_id))
    error_message = "grafana_admin_secret_version_id must be a SecretStash version ID (mbsecver-...)."
  }
}

variable "grafana_admin_password" {
  description = "Grafana admin password read from grafana_admin_secret_id (key admin-password) as TF_VAR_grafana_admin_password. Ephemeral and write-only: never in a plan or the state. A plan that is only reviewed may omit it; set it before a plan that will be applied (Terraform refuses an ephemeral variable at apply that was unset at plan), and an apply with grafana_admin_secret_id set requires it."
  type        = string
  default     = null
  sensitive   = true
  ephemeral   = true
}

variable "grafana_datasources" {
  description = "Grafana data sources to provision in the in-cluster Grafana (the `datasources` list of recipes/observability/grafana/datasources.yaml, decoded by the stack). $${NEBIUS_PROJECT_ID} and $${PROMETHEUS_TOKEN} stay placeholders that Grafana expands from its environment. Provisioned only with grafana_datasource_token_secret; null = none."
  type        = any
  default     = null
}

variable "grafana_datasource_token_secret" {
  description = "Name of a pre-created Kubernetes Secret in the o11y namespace whose key PROMETHEUS_TOKEN holds an OBSERVABILITY static key of a service account in a group with viewer (docs/credentials.md#observability-static-key). Grafana reads it as an environment variable (envFromSecrets, optional), so the key never passes through Terraform. null = the data sources are not provisioned and the plan warns."
  type        = string
  default     = null
  validation {
    condition     = var.grafana_datasource_token_secret == null || can(regex("^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$", var.grafana_datasource_token_secret))
    error_message = "grafana_datasource_token_secret must be a Kubernetes object name (lowercase, digits, '-', '.')."
  }
}
