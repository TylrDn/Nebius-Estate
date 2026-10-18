import { backfillFromTelemetry, ROLLUP_RETENTION_DAYS, telemetryDayRows } from '@internal/nebius-domain';
import type { SampleStore } from '../telemetry/SampleStore';
import type { HistoryStore } from './HistoryStore';

/**
 * Backfills recorded history days from the GPU sample store's hourly roll-ups (#33): a day whose rows count fewer GPUs
 * than reported DCGM samples in the busiest hour (rows written before the per-day peak of G2.5) is raised and marked
 * incomplete; today takes no utilisation from telemetry (the first sync runs before the telemetry recorder). Covers
 * the roll-up window (90 days); idempotent, so it runs after the first sync of each start. Returns the days it changed.
 */
export async function backfillHistory(history: HistoryStore, samples: Pick<SampleStore, 'series' | 'hourly'>, now: Date, days = ROLLUP_RETENTION_DAYS): Promise<string[]> {
  const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const stored = await history.since(since);
  if (!stored.length) return [];
  const series = await samples.series();
  if (!series.length) return [];
  const first = stored.reduce((a, r) => (r.day < a ? r.day : a), stored[0].day);
  const hourly = await samples.hourly(Date.parse(`${first}T00:00:00Z`) / 1000, Math.ceil(now.getTime() / 1000) + 3600, series.map(s => s.key));
  const out = backfillFromTelemetry(stored, telemetryDayRows(series, hourly), now.toISOString().slice(0, 10));
  if (out.days.length) await history.replaceDays(out.rows);
  return out.days;
}
