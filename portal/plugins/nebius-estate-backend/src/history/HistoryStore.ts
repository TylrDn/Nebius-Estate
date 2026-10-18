import { Knex } from 'knex';
import { DailySummaryRow, mergeDayRows } from '@internal/nebius-domain';

/**
 * Daily estate history (portal database). One row per (day, project, region,
 * stage); a later sync on the same day merges into that day's rows (mergeDays). Rows older
 * than `retentionDays` are pruned on write.
 */
const TABLE = 'nebius_estate_history';

export class HistoryStore {
  constructor(private readonly db: Knex, private readonly retentionDays = 400) {}

  async isEmpty(): Promise<boolean> {
    return !(await this.db(TABLE).first('day'));
  }

  /** Merges a sync's rows into their day's stored rows (mergeDayRows: maxima, mean utilisation, last state; G2.5). */
  async mergeDays(rows: DailySummaryRow[]): Promise<void> {
    const days = [...new Set(rows.map(r => r.day))];
    if (!days.length) return;
    const stored = (await this.db(TABLE).whereIn('day', days).select('payload')).map(r => JSON.parse(r.payload) as DailySummaryRow);
    await this.replaceDays(mergeDayRows(stored, rows));
  }

  /** Replaces every row of each day present in `rows`. */
  async replaceDays(rows: DailySummaryRow[]): Promise<void> {
    const days = [...new Set(rows.map(r => r.day))].sort();
    if (!days.length) return;
    const cutoff = new Date(Date.parse(`${days[days.length - 1]}T00:00:00Z`) - this.retentionDays * 86_400_000).toISOString().slice(0, 10);
    await this.db.transaction(async trx => {
      await trx(TABLE).whereIn('day', days).delete();
      for (let i = 0; i < rows.length; i += 200) {
        await trx(TABLE).insert(
          rows.slice(i, i + 200).map(r => ({ day: r.day, project_id: r.projectId, region: r.region, stage: r.stage, payload: JSON.stringify(r) })),
        );
      }
      await trx(TABLE).where('day', '<', cutoff).delete();
    });
  }

  async since(day: string): Promise<DailySummaryRow[]> {
    const rows = await this.db(TABLE).where('day', '>=', day).select('payload');
    return rows.map(r => JSON.parse(r.payload));
  }
}
