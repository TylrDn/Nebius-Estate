import { AUDIT_READ_ACTIONS, AuditEvent } from '@internal/nebius-domain';
import { HttpError } from '../lib/http';
import { AuditClient } from './AuditClient';

/**
 * The documented `filter` of ListAuditEventRequest (nebius/api audit/v2, operators = != : and regex): every action but
 * GET and LIST. Not yet seen live. `!=` is safe either way: a filter the API ignores returns everything, and the reads
 * are still dropped here.
 */
export const WRITES_FILTER = `action != 'GET' AND action != 'LIST'`;

/** With reads included: pages of 100, at most 10 (the shown list is at most MAX_AUDIT_EVENTS). */
const READS_PAGE_SIZE = 100;
const READS_MAX_PAGES = 10;
/** Writes only: the API's largest page (500), at most 20, so a fallback without the filter scans 10 000 events. */
const WRITES_PAGE_SIZE = 500;
const WRITES_MAX_PAGES = 20;

export interface AuditRead {
  /** Newest first, at most `limit`. */
  events: AuditEvent[];
  /** More events in the window than shown, or pages left unread. */
  truncated: boolean;
  /** Pages were left unread: the oldest event time read, so the page can say how far back it looked. */
  scannedFrom?: string;
  /** Events read from the API (reads included). */
  scanned: number;
  /** Writes only: the API accepted the writes filter (else the reads were dropped here). */
  serverFiltered?: boolean;
}

/**
 * Pages through one region's audit events in [start, end). In writes-only mode it asks the API for writes only
 * (WRITES_FILTER) and pages until `limit` writes are found or the page budget is spent; a 400 on the filter falls
 * back to paging without it. G3.4: live eu-north1 has ~114 events an hour, mostly the portal's own LISTs, so 10 pages
 * of 100 read back about 9 hours and a 7 d writes-only view showed "the newest 0 events".
 */
export async function readAuditEvents(
  client: AuditClient,
  q: { tenant: string; region: string; start: string; end: string; limit: number; writesOnly: boolean },
): Promise<AuditRead> {
  const pageSize = q.writesOnly ? WRITES_PAGE_SIZE : READS_PAGE_SIZE;
  const maxPages = q.writesOnly ? WRITES_MAX_PAGES : READS_MAX_PAGES;
  let filter = q.writesOnly ? WRITES_FILTER : undefined;
  const events: AuditEvent[] = [];
  let token: string | undefined;
  let more = false;
  let scanned = 0;
  let oldest: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    let r: Awaited<ReturnType<AuditClient['list']>>;
    try {
      r = await client.list(q.tenant, q.region, q.start, q.end, pageSize, token, filter);
    } catch (e) {
      if (!(filter && page === 0 && e instanceof HttpError && e.status === 400)) throw e;
      filter = undefined; // the API refused the filter: read every event and drop the reads here
      r = await client.list(q.tenant, q.region, q.start, q.end, pageSize, token);
    }
    for (const e of r.events) {
      scanned++;
      if (!oldest || e.time < oldest) oldest = e.time;
      if (q.writesOnly && AUDIT_READ_ACTIONS.includes(e.action)) continue;
      if (events.length < q.limit) events.push(e);
      else more = true;
    }
    token = r.nextPageToken;
    if (!token || more) break;
  }
  events.sort((a, b) => b.time.localeCompare(a.time)); // the API answers newest first (2026-10-11); kept explicit
  const unread = Boolean(token) && !more;
  return {
    events,
    truncated: more || Boolean(token),
    scannedFrom: unread ? oldest : undefined,
    scanned,
    ...(q.writesOnly ? { serverFiltered: filter !== undefined } : {}),
  };
}
