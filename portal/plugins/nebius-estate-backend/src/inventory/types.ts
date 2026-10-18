import { z } from 'zod';
import { CapabilityStatus, ConnectorStatus, CoverageEntry, GpuTelemetryView, ObservedResource } from '@internal/nebius-domain';
import type { CapacitySnapshot } from './nebius';

/**
 * Snapshot shapes produced by the connectors. The
 * Kubernetes and telemetry parts are kept separate from cloud inventory:
 * Kubernetes allocatable/requested resources and measured utilisation are
 * different numbers and are never merged into one field.
 */

export const kubePodSchema = z.object({
  name: z.string(),
  phase: z.string(),
  node: z.string().nullable().optional(),
  message: z.string().optional(),
  pvc: z.string().optional(),
  /** Container restarts summed over the pod's containers (status.containerStatuses[].restartCount). */
  restarts: z.number().optional(),
  /** Why containers wait (state.waiting.reason), e.g. CrashLoopBackOff or ImagePullBackOff. */
  waiting: z.array(z.string()).optional(),
});

export const kubeWorkloadSchema = z.object({
  namespace: z.string(),
  name: z.string(),
  kind: z.string(),
  replicas: z.number().optional(),
  readyReplicas: z.number().optional(),
  requests: z.record(z.string(), z.string()),
  limits: z.record(z.string(), z.string()),
  nodeSelector: z.record(z.string(), z.string()),
  tolerations: z.array(z.string()),
  recipe: z.string().optional(),
  pods: z.array(kubePodSchema),
  /** A Job's outcome (Failed / Complete conditions) and its failed pod count (status.failed); Jobs only. */
  job: z.object({ outcome: z.enum(['running', 'complete', 'failed']), reason: z.string().optional(), failedPods: z.number().optional() }).optional(),
});

export const kubeClusterSchema = z.object({
  name: z.string(),
  mk8sClusterId: z.string().optional(),
  observedAt: z.string().optional(),
  dashboardUrl: z.string().nullable().optional(),
  stale: z.boolean().optional(),
  error: z.string().optional(),
  nodes: z.array(
    z.object({
      name: z.string(),
      instanceId: z.string().optional(),
      /** MK8s node group, when a node label carries its id. */
      nodeGroupId: z.string().optional(),
      allocatable: z.record(z.string(), z.string()),
      /** The Ready condition is "True"; absent when the node reports no Ready condition. */
      ready: z.boolean().optional(),
      /** spec.unschedulable (kubectl cordon / drain). */
      cordoned: z.boolean().optional(),
      /** metadata.deletionTimestamp is set. */
      deleting: z.boolean().optional(),
    }),
  ),
  namespaces: z.array(z.string()),
  workloads: z.array(kubeWorkloadSchema),
  pvcs: z.array(
    z.object({
      namespace: z.string(),
      name: z.string(),
      storageClass: z.string().optional(),
      capacity: z.string().optional(),
      volume: z.string().nullable().optional(),
      note: z.string().optional(),
    }),
  ),
  events: z.array(
    z.object({
      namespace: z.string(),
      involved: z.string(),
      reason: z.string(),
      type: z.string(),
      message: z.string(),
      lastSeen: z.string(),
    }),
  ),
});
export type KubeCluster = z.infer<typeof kubeClusterSchema>;
export type KubeWorkload = z.infer<typeof kubeWorkloadSchema>;

export const telemetrySchema = z.object({
  source: z.string(),
  query: z.string(),
  observedAt: z.string(),
  samples: z.array(z.object({ node: z.string(), instanceId: z.string().optional(), projectId: z.string().optional(), gpuUtilPercent: z.number() })),
});
export type TelemetrySnapshot = z.infer<typeof telemetrySchema>;

export interface EstateSnapshot {
  resources: ObservedResource[];
  coverage: CoverageEntry[];
  observedAt?: string;
  /**
   * When the latest normal (core or full) inventory sync read the cloud (its connector clock, as resources'
   * observedAt). A cloud resource read before it was not in that sync's answer: shown as last seen, never priced.
   * A fast re-sync reads a few lists only and does not move it.
   */
  inventoryReadAt?: string;
  kube: KubeCluster[];
  /** In-cluster Prometheus (optional connector). */
  telemetry?: TelemetrySnapshot;
  /** Nebius Monitoring: per-GPU series for VMs in the listed projects. */
  monitoring?: { gpus: GpuTelemetryView[]; observedAt: string };
  statuses: ConnectorStatus[];
  /** Every read-only API call this identity makes, with its last outcome. */
  capabilities: CapabilityStatus[];
  capacity: CapacitySnapshot;
  /** Tenant projects outside the configured scope (discovery hint, unrestricted callers only). */
  unconfiguredProjects?: { id: string; name?: string; region?: string }[];
  /** Consecutive inventory syncs on which each uid matched an orphan rule (candidates need two). */
  orphanStreaks?: Record<string, number>;
}

/** Parses a Kubernetes quantity of GPUs ("1", "2") — GPUs are integral. */
export function gpuQuantity(q: string | undefined): number {
  if (!q) return 0;
  const n = Number(q);
  return Number.isFinite(n) ? n : 0;
}
