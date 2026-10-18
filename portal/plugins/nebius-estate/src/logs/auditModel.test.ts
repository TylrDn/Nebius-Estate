import type { AuditEvent } from '@internal/nebius-domain';
import { auditResource, auditResult, auditTruncation, auditWho } from './auditModel';

const ev = (p: Partial<AuditEvent>): AuditEvent => ({ id: 'e', time: '2026-10-11T21:00:00Z', service: 'COMPUTE', action: 'CREATE', type: 't', who: { kind: 'unknown' }, resource: {}, status: 'DONE', ...p });

describe('audit event display', () => {
  it('names the caller by the name the event carries, else its id, with its kind', () => {
    expect(auditWho(ev({ who: { kind: 'service-account', id: 'serviceaccount-e00x', name: 'nip-ci' } }))).toBe('nip-ci (service account)');
    expect(auditWho(ev({ who: { kind: 'user', id: 'tenantuseraccount-e00x' } }))).toBe('tenantuseraccount-e00x (user)');
    expect(auditWho(ev({}))).toBe('unknown caller');
  });

  it('shows the resource type with its name or id; a list call names only the type', () => {
    expect(auditResource(ev({ resource: { type: 'instance', id: 'computeinstance-e00x', name: 'vm' } }))).toBe('instance vm');
    expect(auditResource(ev({ resource: { type: 'bucket', id: 'storagebucket-e00x' } }))).toBe('bucket storagebucket-e00x');
    expect(auditResource(ev({ resource: { type: 'subnet' } }))).toBe('subnet');
    expect(auditResource(ev({}))).toBe('—');
  });

  it('a refused call is refused, a failed one failed, otherwise the status', () => {
    expect(auditResult(ev({ authorized: false, error: 'PermissionDenied' }))).toEqual({ tone: 'danger', label: 'refused', detail: 'PermissionDenied' });
    expect(auditResult(ev({ authorized: true, error: 'quota exceeded' }))).toEqual({ tone: 'warn', label: 'failed', detail: 'quota exceeded' });
    expect(auditResult(ev({ authorized: true }))).toEqual({ tone: 'ok', label: 'done' });
  });

  it('an operation with status ERROR is failed even when the event carries no error message (#37)', () => {
    // Live 2026-10-12 19:50Z: four VIRTUAL_NETWORKS DELETE events with status ERROR showed a green "error" badge.
    expect(auditResult(ev({ authorized: true, status: 'ERROR' }))).toEqual({ tone: 'warn', label: 'failed' });
    expect(auditResult(ev({ authorized: true, status: 'ERROR', error: 'RESOURCE_EXHAUSTED' }))).toEqual({ tone: 'warn', label: 'failed', detail: 'RESOURCE_EXHAUSTED' });
    // STARTED is neither done nor failed: the operation was still running when the event was written.
    expect(auditResult(ev({ authorized: true, status: 'STARTED' }))).toEqual({ tone: 'info', label: 'started' });
    for (const status of ['ERROR', 'FAILED', 'CANCELLED', 'CANCELED', 'error']) expect(auditResult(ev({ status })).tone).not.toBe('ok');
  });

  it('says how far back it read instead of "the newest 0 events" (G3.4)', () => {
    const a = { events: [], limit: 50, truncated: true, writesOnly: true, start: '2026-10-05T15:52:00Z', end: '2026-10-12T15:52:00Z', scannedFrom: '2026-10-09T08:40:00Z', scanned: 10_000 };
    expect(auditTruncation(a)).toEqual({
      title: 'Read back to 2026-10-09 08:40 UTC only',
      body: 'No changes between 2026-10-09 08:40 UTC and now; older events in this range (from 2026-10-05 15:52 UTC) were not read: 10000 events were scanned, mostly reads. Narrow the time range.',
    });
    const some = { ...a, events: [ev({})] };
    expect(auditTruncation(some)).toEqual({
      title: 'Showing 1 change back to 2026-10-09 08:40 UTC',
      body: 'Older events in this range (from 2026-10-05 15:52 UTC) were not read: 10000 events were scanned, mostly reads. Narrow the time range.',
    });
    // #30: cut at the list's limit: say where the list stops, and offer more while the API allows more.
    const two = [ev({ time: '2026-10-12T15:00:00Z' }), ev({ time: '2026-10-11T09:30:00Z' })];
    expect(auditTruncation({ ...a, events: two, scannedFrom: undefined, scanned: 300 })).toEqual({
      title: 'Showing the newest 2 changes, back to 2026-10-11 09:30 UTC',
      body: 'Older changes in this range (from 2026-10-05 15:52 UTC) are not shown. Show more, or narrow the time range.',
      more: true,
    });
    expect(auditTruncation({ ...a, writesOnly: false, events: [ev({})], scannedFrom: undefined })?.body).toBe(
      'Older events in this range (from 2026-10-05 15:52 UTC) are not shown. Show more, or narrow the time range or leave out reads.',
    );
    const max = Array.from({ length: 200 }, () => ev({ time: '2026-10-11T09:30:00Z' }));
    expect(auditTruncation({ ...a, events: max, limit: 200, scannedFrom: undefined })).toMatchObject({ more: false, body: 'Older changes in this range (from 2026-10-05 15:52 UTC) are not shown. Narrow the time range.' });
    expect(auditTruncation({ ...a, truncated: false })).toBeUndefined();
  });
});
