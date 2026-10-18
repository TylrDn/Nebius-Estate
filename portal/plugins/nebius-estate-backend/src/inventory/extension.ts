import { CapabilityStatus, ConnectorStatus } from '@internal/nebius-domain';

/**
 * A connector that runs on the inventory's sync loop without living in InventoryService (e.g. the AI
 * services checks in ai/). Its statuses show on Integrations next to the others, its runs are recorded
 * in the HealthStore like every connector's, "Sync now" works per id, and it syncs in parallel with
 * the other hosts. Register it with `InventoryService.useExtension` before `start()`.
 */
export interface SyncExtension {
  /** The connectors it runs, as they stand before their first sync (`starting` or `not-configured`). */
  definitions(): ConnectorStatus[];
  /**
   * One sync of the connectors whose id matches `only` (all when undefined). Returns a patch per
   * connector it ran (state, lastSuccess, error …) and the capabilities it called. A connector's
   * `durationMs` is its own run time; without it, the run is timed from the extension's start to its end.
   * A connector that fails on its own should come back as an `error` patch, not as a thrown error: a throw
   * marks every connector of the extension that returned no patch.
   */
  sync(attempt: string, only?: string): Promise<{ statuses: ExtensionPatch[]; capabilities: CapabilityStatus[] }>;
}

export type ExtensionPatch = Partial<ConnectorStatus> & { id: string; durationMs?: number };
