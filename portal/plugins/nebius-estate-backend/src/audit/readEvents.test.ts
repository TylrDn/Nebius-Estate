import { AuditEvent } from '@internal/nebius-domain';
import { HttpError } from '../lib/http';
import { AuditClient } from './AuditClient';
import { readAuditEvents, WRITES_FILTER } from './readEvents';

/** Live eu-north1 2026-10-12: about 114 events an hour, most of them the portal's own LISTs; the teardown deletes are a day old. */
const END = Date.parse('2026-10-12T15:52:00Z');
const ev = (i: number, action: string): AuditEvent => ({
  id: `auditevent-e00mock${i}`, time: new Date(END - i * 30_000).toISOString(), service: 'COMPUTE', action, type: `ai.nebius.compute.instance.${action.toLowerCase()}`,
  who: { kind: 'service-account', name: action === 'LIST' ? 'nip-portal-viewer' : 'nip-ci' }, resource: {}, status: 'DONE',
});
/** `reads` LISTs, newest first, then two DELETEs older than all of them. */
const estate = (reads: number) => [...Array.from({ length: reads }, (_, i) => ev(i, 'LIST')), ev(reads + 10, 'DELETE'), ev(reads + 20, 'DELETE')];

/** A fake audit list: newest first, paged by offset; `filter` honoured (as documented) or refused (400). */
function fakeClient(all: AuditEvent[], filter: 'honoured' | 'refused' | 'ignored') {
  const calls: { pageSize: number; filter?: string }[] = [];
  const client = {
    list: async (_t: string, _r: string, _s: string, _e: string, pageSize: number, token?: string, f?: string) => {
      calls.push({ pageSize, filter: f });
      if (f && filter === 'refused') throw new HttpError(400, 'GET /audit/v2/audit-events → 400: invalid filter');
      const rows = f && filter === 'honoured' ? all.filter(e => e.action !== 'GET' && e.action !== 'LIST') : all;
      const from = Number(token ?? 0);
      const next = from + pageSize < rows.length ? String(from + pageSize) : undefined;
      return { events: rows.slice(from, from + pageSize), nextPageToken: next };
    },
  } as unknown as AuditClient;
  return { client, calls };
}

const args = { tenant: 'tenant-e00mocktest', region: 'eu-north1', start: '2026-10-05T15:52:00Z', end: new Date(END).toISOString(), limit: 50, writesOnly: true };

describe('reading audit events in writes-only mode (G3.4)', () => {
  it('asks the API for writes only, so a week of the portal\'s own reads does not hide the deletes', async () => {
    const { client, calls } = fakeClient(estate(19_000), 'honoured');
    const r = await readAuditEvents(client, args);
    expect(r.events.map(e => e.action)).toEqual(['DELETE', 'DELETE']);
    expect(r).toMatchObject({ truncated: false, serverFiltered: true, scannedFrom: undefined });
    expect(calls).toEqual([{ pageSize: 500, filter: WRITES_FILTER }]);
  });

  it('falls back to reading pages itself when the API refuses the filter, with a larger budget', async () => {
    const { client, calls } = fakeClient(estate(1_500), 'refused');
    const r = await readAuditEvents(client, args);
    expect(r.events.map(e => e.action)).toEqual(['DELETE', 'DELETE']);
    expect(r).toMatchObject({ truncated: false, serverFiltered: false });
    expect(calls[0].filter).toBe(WRITES_FILTER);
    expect(calls.slice(1).every(c => c.pageSize === 500 && c.filter === undefined)).toBe(true);
  });

  it('says how far back it read when the budget runs out before any write, instead of "the newest 0 events"', async () => {
    const { client } = fakeClient(estate(19_000), 'ignored');
    const r = await readAuditEvents(client, args);
    expect(r.events).toEqual([]);
    expect(r.truncated).toBe(true);
    // 20 pages of 500: the oldest event read is the 10 000th.
    expect(r.scannedFrom).toBe(new Date(END - 9_999 * 30_000).toISOString());
    expect(r.scanned).toBe(10_000);
  });

  it('with reads included, pages as before and stops at the limit', async () => {
    const { client, calls } = fakeClient(estate(1_500), 'honoured');
    const r = await readAuditEvents(client, { ...args, writesOnly: false, limit: 200 });
    expect(r.events).toHaveLength(200);
    expect(r.truncated).toBe(true);
    expect(calls.every(c => c.filter === undefined)).toBe(true);
  });
});
