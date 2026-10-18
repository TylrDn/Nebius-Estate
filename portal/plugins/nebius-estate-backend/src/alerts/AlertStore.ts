import { randomUUID } from 'crypto';
import { Knex } from 'knex';
import { AlertInstance, AlertNote, AlertTransition } from '@internal/nebius-domain';

/**
 * Alerts in the portal database: the current state of every alert (rule × label set), every state
 * transition (history) and local notes (acknowledge, mute) with the user ref. Resolved alerts and
 * history are kept `retentionDays` (default 90), then pruned on write.
 */
const ALERTS = 'nebius_estate_alerts';
const EVENTS = 'nebius_estate_alert_events';
const NOTES = 'nebius_estate_alert_notes';
const CHUNK = 150;

export class AlertStore {
  constructor(private readonly db: Knex, private readonly retentionDays = 90) {}

  async all(): Promise<AlertInstance[]> {
    return (await this.db(ALERTS).select('payload')).map(r => JSON.parse(r.payload));
  }

  async get(id: string): Promise<AlertInstance | undefined> {
    const r = await this.db(ALERTS).where({ id }).first('payload');
    return r ? JSON.parse(r.payload) : undefined;
  }

  /** Replaces the given alerts and appends the transitions, in one transaction. */
  async save(instances: AlertInstance[], transitions: AlertTransition[], now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - this.retentionDays * 86_400_000).toISOString();
    await this.db.transaction(async trx => {
      const rows = instances.map(a => ({
        id: a.id, rule_id: a.ruleId, state: a.state, severity: a.severity, project_id: a.projectId ?? null, active_at: a.activeAt,
        resolved_at: a.resolvedAt ?? null, last_eval_at: a.lastEvalAt, payload: JSON.stringify(a),
      }));
      for (let i = 0; i < rows.length; i += CHUNK) await trx(ALERTS).insert(rows.slice(i, i + CHUNK)).onConflict('id').merge();
      const events = transitions.map(t => ({ alert_id: t.alertId, rule_id: t.ruleId, at: t.at, from_state: t.from, to_state: t.to, value: Number.isFinite(t.value) ? t.value : null }));
      for (let i = 0; i < events.length; i += CHUNK) await trx(EVENTS).insert(events.slice(i, i + CHUNK));
      await trx(ALERTS).where('state', 'resolved').andWhere('resolved_at', '<', cutoff).delete();
      await trx(EVENTS).where('at', '<', cutoff).delete();
      await trx(NOTES).whereNotIn('alert_id', trx(ALERTS).select('id')).delete();
    });
  }

  /** Rules no longer in the repository: their open alerts are resolved, not left firing forever. */
  async ruleIds(): Promise<string[]> {
    return (await this.db(ALERTS).distinct('rule_id')).map(r => r.rule_id);
  }

  async history(alertId: string, limit = 100): Promise<{ at: string; from: string; to: string; value: number }[]> {
    const rows = await this.db(EVENTS).where({ alert_id: alertId }).orderBy('seq', 'desc').limit(limit);
    return rows.map(r => ({ at: r.at, from: r.from_state, to: r.to_state, value: Number(r.value) }));
  }

  async notes(alertIds?: string[]): Promise<AlertNote[]> {
    const q = this.db(NOTES).orderBy('created_at', 'desc');
    if (alertIds) q.whereIn('alert_id', alertIds.slice(0, 5000));
    return (await q).map(r => ({ id: r.id, alertId: r.alert_id, kind: r.kind, userRef: r.user_ref, note: r.note ?? undefined, createdAt: r.created_at, until: r.until ?? undefined }));
  }

  async addNote(n: Omit<AlertNote, 'id' | 'createdAt'>, now = new Date()): Promise<AlertNote> {
    const note: AlertNote = { ...n, id: randomUUID(), createdAt: now.toISOString() };
    // One note of each kind per alert: a new acknowledgement or mute replaces the previous one.
    await this.db.transaction(async trx => {
      await trx(NOTES).where({ alert_id: n.alertId, kind: n.kind }).delete();
      await trx(NOTES).insert({ id: note.id, alert_id: note.alertId, kind: note.kind, user_ref: note.userRef, note: note.note ?? null, created_at: note.createdAt, until: note.until ?? null });
    });
    return note;
  }

  async removeNote(alertId: string, kind: AlertNote['kind']): Promise<number> {
    return this.db(NOTES).where({ alert_id: alertId, kind }).delete();
  }
}
