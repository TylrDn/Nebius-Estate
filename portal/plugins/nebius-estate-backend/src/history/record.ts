import { summarizeDay } from '@internal/nebius-domain';
import { InventoryService } from '../inventory/InventoryService';
import { HistoryStore } from './HistoryStore';

/** Records today's summary from the current snapshot, merged into earlier syncs of the same day (G2.5). */
export async function recordHistory(history: HistoryStore, inventory: InventoryService): Promise<void> {
  const snap = inventory.snapshot();
  if (!snap.resources.length) return; // nothing observed: leave a gap rather than a row of zeros
  await history.mergeDays(summarizeDay(snap.resources, inventory.now(), snap.telemetry));
}
