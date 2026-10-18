output "grafana_admin_password" {
  description = "Generated Grafana admin password (fallback path, held in state). null when the password comes from SecretStash (grafana_admin_secret_id): read it there (`nebius mysterybox payload get`)."
  sensitive   = true
  value       = one(random_password.grafana_admin[*].result)
}

output "namespace" {
  value = var.namespace
}

output "status" {
  value = {
    prometheus = var.prometheus_enabled ? try(nebius_applications_v1alpha1_k8s_release.prometheus[0].status, null) : null
    agent      = var.nebius_agent_enabled ? try(nebius_applications_v1alpha1_k8s_release.agent[0].status, null) : null
  }
}

output "grafana_admin_secret" {
  description = "Where the Grafana admin password lives, without its value: { source = \"secretstash\" | \"state\", secret_id, version_id }. null when Prometheus/Grafana is off."
  value = !var.prometheus_enabled ? null : {
    source     = local.grafana_from_secret ? "secretstash" : "state"
    secret_id  = var.grafana_admin_secret_id
    version_id = var.grafana_admin_secret_version_id
  }
}

output "provisioning" {
  description = "What the grafana-and-prometheus release is sent, without values: the Grafana data sources (and the Nebius-side input they still need), the alert rule groups and where Alertmanager's receivers come from. recipes/observability/acceptance.sh checks the running cluster against the same lists. null when Prometheus/Grafana is off."
  value = !var.prometheus_enabled ? null : {
    datasources = {
      provisioned   = local.datasources_on
      uids          = local.datasources_on ? [for d in var.grafana_datasources : d.uid] : []
      token_secret  = var.grafana_datasource_token_secret
      missing_input = local.datasources_missing_input
    }
    alerting = {
      rule_groups     = [for g in local.rule_groups : g.name]
      rules           = length(flatten([for g in local.rule_groups : [for r in g.rules : r if can(r.alert)]]))
      alertmanager    = var.alertmanager_enabled
      receiver_config = !var.alertmanager_enabled ? null : (var.alertmanager_config_secret == null ? "inline" : "secret/${var.alertmanager_config_secret}")
    }
  }
}
