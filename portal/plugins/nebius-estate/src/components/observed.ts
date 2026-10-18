import type { ResourceView } from '@internal/nebius-domain';
import { fmtAgo, fmtTime } from '../ui/format';

/**
 * The resource's own read time for the drawer: "Observed" when the latest inventory sync read it, else "Last seen"
 * with why (its list was read on full syncs only, or its read failed): it may have changed or gone since, and the
 * run-rate never prices it (followups 13 and 23, live 2026-10-12).
 */
export function observedRow(d: Pick<ResourceView, 'observedAt' | 'lastSeen'>, now: Date): [string, string] {
  return d.lastSeen
    ? ['Last seen', `${fmtTime(d.lastSeen)} (${fmtAgo(d.lastSeen, now)}): not read by the latest inventory sync (a list read on full syncs only, or its read failed), so it may have changed or gone since; never priced in the run-rate`]
    : ['Observed', `${fmtTime(d.observedAt)} (${fmtAgo(d.observedAt, now)})`];
}

/** The Explorer's "Observed" cell: "last seen …" for a resource the latest inventory sync did not read. */
export function observedCell(r: Pick<ResourceView, 'observedAt' | 'lastSeen'>, now: Date): { text: string; lastSeen: boolean } {
  return r.lastSeen ? { text: `last seen ${fmtAgo(r.lastSeen, now)}`, lastSeen: true } : { text: fmtAgo(r.observedAt, now), lastSeen: false };
}
