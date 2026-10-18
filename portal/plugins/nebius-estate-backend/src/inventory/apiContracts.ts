/**
 * Documented list contracts per REST path, extracted from https://api.nebius.cloud/openapi.json
 * (fetched 2026-10-11): the array key of the list response and the enum values of each item's
 * status fields. A value outside these lists is reported as schema drift; it never breaks a sync.
 * Regenerate when the API version changes; do not edit by hand.
 */
export const API_CONTRACTS: Record<string, { listKey: string; paged: boolean; enums: Record<string, readonly string[]> }> = {
  '/compute/v1/instances': { listKey: 'items', paged: true, enums: { 'status.state': ["UNSPECIFIED", "CREATING", "UPDATING", "STARTING", "RUNNING", "STOPPING", "STOPPED", "DELETING", "ERROR"] } },
  '/compute/v1/disks': { listKey: 'items', paged: true, enums: { 'status.sourceImageCpuArchitecture': ["SOURCE_IMAGE_CPU_UNSPECIFIED", "AMD64", "ARM64"], 'status.state': ["UNSPECIFIED", "CREATING", "READY", "UPDATING", "DELETING", "ERROR", "BROKEN"] } },
  '/compute/v1/filesystems': { listKey: 'items', paged: true, enums: { 'status.state': ["UNSPECIFIED", "CREATING", "READY", "UPDATING", "DELETING", "ERROR"] } },
  '/compute/v1/gpu-clusters': { listKey: 'items', paged: true, enums: {  } },
  '/vpc/v1/networks': { listKey: 'items', paged: true, enums: { 'status.state': ["STATE_UNSPECIFIED", "CREATING", "READY", "DELETING"] } },
  '/vpc/v1/subnets': { listKey: 'items', paged: true, enums: { 'status.state': ["STATE_UNSPECIFIED", "CREATING", "READY", "DELETING"] } },
  '/storage/v1/buckets': { listKey: 'items', paged: true, enums: { 'status.bucketType': ["BUCKET_TYPE_UNSPECIFIED", "REGULAR", "FILESYSTEM"], 'status.state': ["STATE_UNSPECIFIED", "CREATING", "ACTIVE", "UPDATING", "SCHEDULED_FOR_DELETION"], 'status.suspensionState': ["SUSPENSION_STATE_UNSPECIFIED", "NOT_SUSPENDED", "SUSPENDED"] } },
  '/mk8s/v1/clusters': { listKey: 'items', paged: true, enums: { 'status.state': ["STATE_UNSPECIFIED", "PROVISIONING", "RUNNING", "DELETING"] } },
  '/mk8s/v1/node-groups': { listKey: 'items', paged: true, enums: { 'status.state': ["STATE_UNSPECIFIED", "PROVISIONING", "RUNNING", "DELETING"] } },
  '/quotas/v1/quota-allowances': { listKey: 'items', paged: true, enums: { 'status.state': ["STATE_UNSPECIFIED", "STATE_PROVISIONING", "STATE_ACTIVE", "STATE_FROZEN", "STATE_DELETED"], 'status.usageState': ["USAGE_STATE_UNSPECIFIED", "USAGE_STATE_USED", "USAGE_STATE_NOT_USED", "USAGE_STATE_UNKNOWN", "USAGE_STATE_NOT_APPLICABLE"] } },
  '/capacity/v1/capacity-allowances': { listKey: 'items', paged: true, enums: { 'status.state': ["STATE_UNSPECIFIED", "STATE_PROVISIONING", "STATE_ACTIVE", "STATE_CONTAINER_DELETED"], 'status.usageState': ["USAGE_STATE_UNSPECIFIED", "USAGE_STATE_USED", "USAGE_STATE_NOT_USED", "USAGE_STATE_UNKNOWN"] } },
  '/vpc/v1/allocations': { listKey: 'items', paged: true, enums: { 'status.state': ["STATE_UNSPECIFIED", "CREATING", "ALLOCATED", "ASSIGNED", "DELETING"] } },
  '/vpc/v1/security-groups': { listKey: 'items', paged: true, enums: { 'status.state': ["STATE_UNSPECIFIED", "READY"] } },
  '/vpc/v1/route-tables': { listKey: 'items', paged: true, enums: { 'status.state': ["STATE_UNSPECIFIED", "READY"] } },
  '/vpc/v1/pools': { listKey: 'items', paged: true, enums: { 'status.state': ["STATE_UNSPECIFIED", "CREATING", "READY", "DELETING"] } },
  '/ai/v1/endpoints': { listKey: 'items', paged: true, enums: { 'status.state': ["STATE_UNSPECIFIED", "PROVISIONING", "STARTING", "RUNNING", "STOPPING", "DELETING", "STOPPED", "ERROR", "IMAGE_PULLING"] } },
  '/ai/v1/jobs': { listKey: 'items', paged: true, enums: { 'status.state': ["STATE_UNSPECIFIED", "PROVISIONING", "STARTING", "RUNNING", "CANCELLING", "DELETING", "COMPLETED", "FAILED", "CANCELLED", "ERROR", "IMAGE_PULLING"] } },
  '/ai/v1/devlabs': { listKey: 'items', paged: true, enums: { 'status.state': ["STATE_UNSPECIFIED", "PROVISIONING", "STARTING", "RUNNING", "STOPPING", "DELETING", "STOPPED", "FAILED", "ERROR", "IMAGE_PULLING"] } },
  '/msp/postgresql/v1alpha1/clusters': { listKey: 'clusters', paged: true, enums: { 'status.phase': ["PHASE_UNSPECIFIED", "PHASE_PROVISIONING", "PHASE_RUNNING", "PHASE_UPDATING", "PHASE_DELETING", "PHASE_DELETED", "PHASE_PURGING", "PHASE_STOPPING", "PHASE_RESUMING"], 'status.state': ["STATE_UNSPECIFIED", "STATE_IN_PROGRESS", "STATE_FINISHED", "STATE_ERROR", "STATE_DEGRADED", "STATE_SCHEDULED"] } },
  '/msp/mlflow/v1alpha1/clusters': { listKey: 'items', paged: true, enums: { 'status.phase': ["PHASE_UNSPECIFIED", "PHASE_PROVISIONING", "PHASE_RUNNING", "PHASE_UPDATING", "PHASE_DELETING", "PHASE_DELETED", "PHASE_PURGING", "PHASE_STOPPING", "PHASE_RESUMING"], 'status.state': ["STATE_UNSPECIFIED", "STATE_IN_PROGRESS", "STATE_FINISHED", "STATE_ERROR", "STATE_DEGRADED", "STATE_SCHEDULED"] } },
  '/registry/v1/registries': { listKey: 'items', paged: true, enums: { 'status.state': ["CREATING", "ACTIVE", "DELETING", "SUSPENDED"] } },
  '/storage/v1/transfers': { listKey: 'items', paged: true, enums: { 'status.state': ["STATE_UNSPECIFIED", "ACTIVE", "STOPPING", "STOPPED", "FAILING", "FAILED", "DELETING"], 'status.suspensionState': ["SUSPENSION_STATE_UNSPECIFIED", "NOT_SUSPENDED", "SUSPENDED"] } },
  '/compute/v1/disk-snapshots': { listKey: 'items', paged: true, enums: { 'status.sourceCpuArchitecture': ["UNDEFINED", "AMD64", "ARM64"], 'status.state': ["UNSPECIFIED", "CREATING", "READY", "DELETING", "ERROR"] } },
  '/compute/v1/platforms': { listKey: 'items', paged: true, enums: {  } },
  '/compute/v1/nvl-instance-groups': { listKey: 'items', paged: true, enums: {  } },
  '/tunnel/v1/tunnels': { listKey: 'items', paged: true, enums: { 'status.connectionState': ["CONNECTION_STATE_UNSPECIFIED", "CONNECTION_STATE_DISCONNECTED", "CONNECTION_STATE_CONNECTED"], 'status.state': ["UNSPECIFIED", "CREATED", "DELETED"] } },
  '/mysterybox/v1/secrets': { listKey: 'items', paged: true, enums: { 'status.state': ["STATE_UNSPECIFIED", "ACTIVE", "SCHEDULED_FOR_DELETION"] } },
  '/kms/v1/symmetric-keys': { listKey: 'items', paged: true, enums: { 'status.state': ["KEY_STATE_UNSPECIFIED", "ACTIVE", "SCHEDULED_FOR_DELETION"] } },
  '/maintenance/v1alpha1/maintenances': { listKey: 'items', paged: false, enums: { 'status.state': ["STATE_UNSPECIFIED", "STATE_SCHEDULED", "STATE_IN_PROGRESS", "STATE_FINISHED", "STATE_ERROR", "STATE_CANCELLED"] } },
  '/dns/v1/zones': { listKey: 'items', paged: true, enums: {  } },
  '/capacity/v1/capacity-block-groups': { listKey: 'items', paged: true, enums: { 'status.state': ["STATE_UNSPECIFIED", "STATE_ALLOCATING", "STATE_ACTIVE", "STATE_SHUTTING", "STATE_INACTIVE"], 'status.usageState': ["USAGE_STATE_UNSPECIFIED", "USAGE_STATE_USED", "USAGE_STATE_NOT_USED", "USAGE_STATE_UNKNOWN"] } },
  '/capacity/v1/resource-advice': { listKey: 'items', paged: true, enums: {  } },
  '/billing/v1/pricing-policies': { listKey: 'items', paged: true, enums: { 'status.schedulingState': ["SCHEDULING_STATE_UNSPECIFIED", "SCHEDULING_STATE_ALLOWED", "SCHEDULING_STATE_BLOCKED"], 'status.state': ["STATE_UNSPECIFIED", "STATE_CREATING", "STATE_ACTIVE", "STATE_DELETING", "STATE_UPDATING"] } },
  '/iam/v2/projects': { listKey: 'items', paged: true, enums: { 'status.projectState': ["STATE_UNSPECIFIED", "CREATING", "ACTIVE", "PURGING", "CREATED", "ACTIVATING", "PARKING", "PARKED"] } },
};
