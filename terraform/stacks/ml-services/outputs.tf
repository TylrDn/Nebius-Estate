output "stage" {
  description = "Stage this root was planned for."
  value       = var.stage
}

output "registry_id" {
  description = "Container Registry ID (registry-...); null when enable_registry = false."
  value       = one(nebius_registry_v1_registry.this[*].id)
}

output "registry_url" {
  description = "Image prefix for docker push/pull and pod specs: cr.<region>.nebius.cloud/<registry ID without the registry- prefix> (container-registry/registries/manage). null when enable_registry = false."
  value       = var.enable_registry ? "cr.${var.region}.nebius.cloud/${trimprefix(nebius_registry_v1_registry.this[0].id, "registry-")}" : null
}

output "node_service_account_id" {
  description = "Service account for Managed Kubernetes node groups; pass to R1/R3 as node_service_account_id so pods pull from Container Registry without pull secrets. null when create_node_service_account = false (use the project's k8s-node-group-sa)."
  value       = one(nebius_iam_v1_service_account.node[*].id)
}

output "node_pull_scope" {
  description = "Where the node service account's viewer permit applies: this stack's registry or the whole project. null without the service account."
  value       = var.create_node_service_account ? one(nebius_iam_v1_access_permit.image_pull[*].resource_id) : null
}

output "network_id" {
  description = "VPC network the managed services attach to (from subnet_id or the default subnet); null when neither service is enabled."
  value       = local.needs_network ? module.network[0].network_id : null
}

output "mlflow" {
  description = "Managed MLflow cluster: id, tracking endpoints (host names; prefix https:// for MLFLOW_TRACKING_URI), admin user and artifact bucket. The password is never an output: read it from SecretStash (secret_id). null when enable_mlflow = false."
  value = var.enable_mlflow ? {
    id                 = nebius_msp_mlflow_v1alpha1_cluster.this[0].id
    public_tracking    = try(nebius_msp_mlflow_v1alpha1_cluster.this[0].status.tracking_endpoints.public, null)
    private_tracking   = try(nebius_msp_mlflow_v1alpha1_cluster.this[0].status.tracking_endpoints.private, null)
    admin_username     = var.mlflow.admin_username
    artifact_bucket    = try(nebius_msp_mlflow_v1alpha1_cluster.this[0].status.effective_storage_bucket_name, null)
    public_access      = local.mlflow_public
    service_account_id = local.mlflow_service_account_id
  } : null
}

output "postgresql" {
  description = "Managed PostgreSQL cluster: id, endpoints (port 5432, sslmode=verify-full), database and bootstrap user. The password is never an output: read it from SecretStash (secret_id). null when enable_postgresql = false."
  value = var.enable_postgresql ? {
    id                 = nebius_msp_postgresql_v1alpha1_cluster.this[0].id
    private_read_write = try(nebius_msp_postgresql_v1alpha1_cluster.this[0].status.connection_endpoints.private_read_write, null)
    private_read_only  = try(nebius_msp_postgresql_v1alpha1_cluster.this[0].status.connection_endpoints.private_read_only, null)
    public_read_write  = try(nebius_msp_postgresql_v1alpha1_cluster.this[0].status.connection_endpoints.public_read_write, null)
    public_read_only   = try(nebius_msp_postgresql_v1alpha1_cluster.this[0].status.connection_endpoints.public_read_only, null)
    db_name            = var.postgresql.db_name
    user_name          = var.postgresql.user_name
    platform           = local.postgresql_platform
    public_access      = local.postgresql_public
  } : null
}

output "secret" {
  description = "Where the passwords live (ids only, never values): the SecretStash secret and pinned version, or null when they were typed in."
  value       = local.from_secret ? { secret_id = var.secret_id, version_id = var.secret_version_id } : null
}

output "deletion_guarded" {
  description = "Clusters Terraform refuses to destroy or replace (stage policy forbid_deletion)."
  value       = sort(keys(terraform_data.deletion_guard))
}
