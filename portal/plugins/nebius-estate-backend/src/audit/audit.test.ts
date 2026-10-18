import { HttpError } from '../lib/http';
import { AuditClient, AuditExtension, auditInputsGap, mapAuditEvent } from './AuditClient';

describe('audit events', () => {
  it('keeps who, action, resource, time and result; drops the token, IP, user agent, fingerprint and payloads (live shape, snake_case too)', () => {
    const e = mapAuditEvent({
      id: 'e1', time: '2026-10-11T21:00:00Z', type: 'ai.nebius.iam.accesskey.create', service: { name: 'IAM' }, action: 'CREATE', status: 'DONE',
      authentication: { subject: { service_account_id: 'serviceaccount-e00x', name: 'ci' }, token_credential: { masked_token: 'SECRET-TOKEN' } },
      authorization: { authorized: true },
      resource: { metadata: { id: 'accesskey-e00x', name: 'k', type: 'accesskey' } },
      request: { client_ip: '203.0.113.9', user_agent: 'curl', ja3_fingerprint: 'abc', parameters: { secret: 'SECRET-PARAM' } },
      response: { payload: { status: { code: 0 }, secret: 'SECRET-PAYLOAD' } },
    });
    expect(e).toEqual({
      id: 'e1', time: '2026-10-11T21:00:00Z', service: 'IAM', action: 'CREATE', type: 'ai.nebius.iam.accesskey.create', status: 'DONE',
      who: { kind: 'service-account', id: 'serviceaccount-e00x', name: 'ci' }, resource: { type: 'accesskey', id: 'accesskey-e00x', name: 'k' }, authorized: true, error: undefined,
    });
    expect(JSON.stringify(e)).not.toMatch(/SECRET|203\.0\.113|curl|abc/);
  });

  it('a failed operation in the documented shape (response.status_code, an empty error_message) carries the code as its error (#37)', () => {
    const base = { id: 'e2', time: '2026-10-12T19:50:09Z', service: { name: 'VIRTUAL_NETWORKS' }, action: 'DELETE', status: 'ERROR' };
    expect(mapAuditEvent({ ...base, response: { status_code: 'RESOURCE_EXHAUSTED', error_message: '' } })).toMatchObject({ status: 'ERROR', error: 'RESOURCE_EXHAUSTED' });
    expect(mapAuditEvent({ ...base, response: { statusCode: 'FAILED_PRECONDITION', errorMessage: 'subnet is in use' } })).toMatchObject({ error: 'subnet is in use (FAILED_PRECONDITION)' });
    expect(mapAuditEvent({ ...base, status: 'DONE', response: { status_code: 'OK', error_message: '' } }).error).toBeUndefined();
  });

  const ext = (client: AuditClient | undefined, regions = ['eu-north1']) =>
    new AuditExtension({ client: () => client, tenant: () => 'tenant-e00x', regions: () => regions, maxConcurrency: 2, syncIntervalMinutes: 15, now: () => new Date('2026-10-11T21:00:00Z') });
  const fake = (list: AuditClient['list']) => ({ list } as unknown as AuditClient);

  it('reports not-configured without a client, and says what is missing', async () => {
    expect((await ext(undefined).sync('a')).capabilities[0]).toMatchObject({ id: 'audit.events.list', state: 'not-configured' });
    expect((await ext(undefined).sync('a')).statuses[0]).toMatchObject({ state: 'not-configured' });
  });

  it('configured, but the tenant or the regions are unknown (the project reads failed): an error, not "not configured" (F1.32)', async () => {
    const noRegions = await ext(fake(async () => ({ events: [] })), []).sync('a');
    expect(noRegions.statuses[0]).toMatchObject({ id: 'nebius-audit', state: 'error', error: auditInputsGap({ tenant: true, regions: false, synced: true }) });
    // The capability agrees with the connector: not "not configured".
    expect(noRegions.capabilities[0]).toMatchObject({ state: 'unreachable', lastError: noRegions.statuses[0].error });
    // Only the missing input is advised on: a lost region is not fixed by setting the tenant.
    expect(noRegions.statuses[0].error).not.toMatch(/NEBIUS_TENANT_ID/);
    expect(noRegions.statuses[0].error).toMatch(/regions/);
    const noTenant = await new AuditExtension({ client: () => fake(async () => ({ events: [] })), tenant: () => undefined, regions: () => ['eu-north1'], maxConcurrency: 2, syncIntervalMinutes: 15 }).sync('a');
    expect(noTenant.statuses[0]).toMatchObject({ state: 'error', error: expect.stringMatching(/NEBIUS_TENANT_ID/) });
    expect(noTenant.statuses[0].error).not.toMatch(/region/);
  });

  it('before the first inventory sync has finished, the inputs are "not read yet", not a failed read (F1.32 review)', () => {
    expect(auditInputsGap({ tenant: false, regions: false, synced: false })).toBe('The tenant and the regions of the listed projects are not read yet: the first inventory sync has not finished.');
    expect(auditInputsGap({ tenant: false, regions: true, synced: true })).toMatch(/^The tenant could not be read: .* Set NEBIUS_TENANT_ID/);
  });

  it('reports permission-denied with the grant to ask for, per region; a readable region still counts', async () => {
    const denied = await ext(fake(async () => { throw new HttpError(403, 'GET /audit/v2/audit-events → 403: PermissionDenied'); })).sync('a');
    expect(denied.capabilities[0]).toMatchObject({ state: 'permission-denied', hint: expect.stringMatching(/auditlogs\.audit-event-viewer/) });
    expect(denied.statuses[0]).toMatchObject({ id: 'nebius-audit', state: 'permission-denied' });
    const mixed = await ext(fake(async (_t, region) => { if (region === 'uk-south1') throw new HttpError(403, 'denied'); return { events: [] }; }), ['eu-north1', 'uk-south1']).sync('a');
    expect(mixed.capabilities[0]).toMatchObject({ items: 1, lastError: expect.stringMatching(/^uk-south1: /) });
    expect(mixed.statuses[0]).toMatchObject({ notes: ['Audit events readable in eu-north1.'] });
  });

  it('asks for exactly one region, the tenant and a one-hour window, one event', async () => {
    const calls: unknown[][] = [];
    await ext(fake(async (...args) => { calls.push(args); return { events: [] }; })).sync('a');
    expect(calls).toEqual([['tenant-e00x', 'eu-north1', '2026-10-11T20:00:00.000Z', '2026-10-11T21:00:00.000Z', 1]]);
  });
});
