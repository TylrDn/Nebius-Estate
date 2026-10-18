output "federated_credentials" {
  description = "Per \"<stage>/<apply|plan>\": the credential id, the service account it impersonates and the exact sub claim it accepts."
  value = {
    for k, i in local.identities : k => {
      id                 = nebius_iam_v1_federated_credentials.ci[k].id
      service_account_id = i.service_account_id
      subject            = i.subject
    }
  }
}

output "github_environments" {
  description = "What each GitHub Environment needs for the federated path: NIP_SA_ID only. NIP_SA_KEY_ID and NIP_SA_PRIVATE_KEY are no longer used there."
  value = {
    for k, i in local.identities : i.environment => {
      NIP_SA_ID = i.service_account_id
      subject   = i.subject
    }
  }
}

output "issuer_url" {
  description = "Issuer the credentials trust (the iss claim CI tokens must carry)."
  value       = var.issuer_url
}

output "team_groups" {
  description = "Team group id per key, with its permits (role on resource)."
  value = {
    for name, g in var.groups : name => {
      id      = nebius_iam_v1_group.team[name].id
      permits = [for k, p in local.group_permits : "${p.role} on ${p.resource_id}" if p.group == name]
    }
  }
}
