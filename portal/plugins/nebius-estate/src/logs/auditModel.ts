import type { AuditEvent, AuditEventsResponse } from '@internal/nebius-domain';
import { MAX_AUDIT_EVENTS } from '@internal/nebius-domain';
import { fmtTime } from '../ui/format';

export const AUDIT_RANGES = [
  { id: '1h', label: '1 h', minutes: 60 },
  { id: '24h', label: '24 h', minutes: 24 * 60 },
  { id: '7d', label: '7 d', minutes: 7 * 24 * 60 },
] as const;
export type AuditRange = (typeof AUDIT_RANGES)[number]['id'];

/** "nip-ci (service account)": the name the event carries, else the id; never guessed. */
export function auditWho(e: AuditEvent): string {
  const kind = e.who.kind === 'service-account' ? 'service account' : e.who.kind === 'user' ? 'user' : 'unknown caller';
  const name = e.who.name ?? e.who.id;
  return name ? `${name} (${kind})` : kind;
}

/** "instance nip-sandbox-gpu-vm", else its id, else the type alone (a LIST names no single resource). */
export function auditResource(e: AuditEvent): string {
  const label = e.resource.name ?? e.resource.id;
  return [e.resource.type, label].filter(Boolean).join(' ') || '—';
}

/** Operation statuses that mean it did not complete (the documented ones are STARTED, DONE and ERROR). */
const FAILED_STATUS = /^(ERROR|FAILED|CANCELL?ED)$/i;

/**
 * Refused (authorization), failed (an error status or an error in the response), started (still running when the
 * event was written) or the event status (e.g. DONE). The operation's own status is enough to say "failed": the
 * documented error_message may be empty (#37: an ERROR event was shown as a green "error").
 */
export function auditResult(e: AuditEvent): { tone: 'danger' | 'warn' | 'info' | 'ok'; label: string; detail?: string } {
  if (e.authorized === false) return { tone: 'danger', label: 'refused', detail: e.error };
  if (e.error || FAILED_STATUS.test(e.status)) return { tone: 'warn', label: 'failed', ...(e.error ? { detail: e.error } : {}) };
  if (/^STARTED$/i.test(e.status)) return { tone: 'info', label: 'started' };
  return { tone: 'ok', label: e.status ? e.status.toLowerCase() : 'recorded' };
}

/**
 * The callout over a cut-short audit list. With `scannedFrom` the page budget ran out before the range's start: say
 * how far back the list goes, never "the newest 0 events" (G3.4: live 7 d, writes only, showed that next to
 * "No changes in this range" while day-old deletes fell inside the range).
 */
export function auditTruncation(
  a: Pick<AuditEventsResponse, 'events' | 'truncated' | 'writesOnly' | 'start' | 'scannedFrom' | 'scanned'> & { limit?: number },
): { title: string; body: string; more?: boolean } | undefined {
  if (!a.truncated) return undefined;
  if (a.scannedFrom) {
    const n = a.events.length;
    const what = a.writesOnly ? 'change' : 'event';
    const older = `older events in this range (from ${fmtTime(a.start)}) were not read${a.scanned ? `: ${a.scanned} events were scanned${a.writesOnly ? ', mostly reads' : ''}` : ''}. Narrow the time range.`;
    return n
      ? { title: `Showing ${n} ${what}${n === 1 ? '' : 's'} back to ${fmtTime(a.scannedFrom)}`, body: `O${older.slice(1)}` }
      : { title: `Read back to ${fmtTime(a.scannedFrom)} only`, body: `No ${what}s between ${fmtTime(a.scannedFrom)} and now; ${older}` };
  }
  // #30: cut at the list's limit. Say where the list stops (its oldest event) and offer more up to the API's maximum.
  const n = a.events.length;
  const what = a.writesOnly ? 'change' : 'event';
  const oldest = a.events.reduce<string | undefined>((o, e) => (!o || e.time < o ? e.time : o), undefined);
  const more = (a.limit ?? n) < MAX_AUDIT_EVENTS;
  return {
    title: `Showing the newest ${n} ${what}${n === 1 ? '' : 's'}${oldest ? `, back to ${fmtTime(oldest)}` : ''}`,
    body: `Older ${what}s in this range (from ${fmtTime(a.start)}) are not shown. ${more ? 'Show more, or narrow' : 'Narrow'} the time range${a.writesOnly ? '' : ' or leave out reads'}.`,
    more,
  };
}
