import { mockCredentials, mockServices, startTestBackend } from '@backstage/backend-test-utils';
import request from 'supertest';
import { AlertDetailResponse, AlertsResponse, AuditEventsResponse, FleetResponse, LogBucketsResponse, LogsResponse } from '@internal/nebius-domain';
import { nebiusEstatePlugin } from './plugin';
import { HistoryStore } from './history/HistoryStore';
import { testDatabase, permissionsByUser, stubNebiusApi, testConfig, useTestClock } from './__testUtils__/testing';

const ALL = ['nebius.estate.read', 'nebius.telemetry.read', 'nebius.alerts.annotate', 'nebius.logs.read', 'nebius.audit.read', 'nebius.commercial.rate.read'];

async function backend(extra: Record<string, unknown> = {}) {
  const { server } = await startTestBackend({
    features: [
      testDatabase(),
      nebiusEstatePlugin,
      mockServices.rootConfig.factory({ data: testConfig(extra) }),
      permissionsByUser({
        'user:default/admin': ALL,
        'user:default/alice': ALL,
        'user:default/viewer': ['nebius.estate.read'],
        'user:default/mixed': ALL,
      }),
    ],
  });
  const get = (user: string, path: string) => request(server).get(`/api/nebius-estate${path}`).set('Authorization', mockCredentials.user.header(user));
  const post = (user: string, path: string, body: object) => request(server).post(`/api/nebius-estate${path}`).set('Authorization', mockCredentials.user.header(user)).send(body);
  const del = (user: string, path: string) => request(server).delete(`/api/nebius-estate${path}`).set('Authorization', mockCredentials.user.header(user));
  return { get, post, del };
}

describe('Fleet, Alerts and Logs routes', () => {
  stubNebiusApi();
  useTestClock();

  it.each([
    { priceRoles: [] },
    { priceRoles: [{ name: 'prices', principals: ['user:default/mixed'], permissions: ['nebius.commercial.rate.read'], projects: ['project-e00mocksandbox'] }] },
  ])('Fleet keeps telemetry but never prices without rate access across its scope (%j)', async ({ priceRoles }) => {
    const { get } = await backend({ access: { roles: [
      { name: 'telemetry', principals: ['user:default/mixed'], permissions: ['nebius.estate.read', 'nebius.telemetry.read'], projects: ['*'] },
      ...priceRoles,
    ] } });
    const fetch = global.fetch as jest.Mock;
    fetch.mockClear();
    const res = await get('user:default/mixed', '/fleet');
    expect(res.status).toBe(200);
    const f = res.body as FleetResponse;
    expect(f.rows.length).toBeGreaterThan(1);
    expect(f.idle.value!.gpuHours).toBeGreaterThan(0);
    expect(f.idle.value!.cost).toBeNull();
    expect(f.idle.value!.unpriced).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringMatching(/commercial.rate.read/) }),
    ]));
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/billing/v1/calculator/'))).toEqual([]);
  });

  it('hides optional telemetry when its permission covers fewer projects than estate access', async () => {
    const { get } = await backend({ access: { roles: [
      { name: 'estate', principals: ['user:default/mixed'], permissions: ['nebius.estate.read'], projects: ['*'] },
      { name: 'telemetry', principals: ['user:default/mixed'], permissions: ['nebius.telemetry.read'], projects: ['project-e00mocksandbox'] },
    ] } });
    const overview = await get('user:default/mixed', '/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.gpuTelemetry.value).toBeNull();
    expect(overview.body.gpuUtilization.value).toBeNull();
    const capacity = await get('user:default/mixed', '/capacity');
    expect(capacity.status).toBe(200);
    expect(capacity.body.gpuTelemetry.value).toBeNull();
  });

  it('Fleet intersects estate and telemetry projects instead of discarding either grant scope', async () => {
    const { get } = await backend({ access: { roles: [
      { name: 'estate', principals: ['user:default/mixed'], permissions: ['nebius.estate.read'], projects: ['project-e00mocksandbox'] },
      { name: 'telemetry', principals: ['user:default/mixed'], permissions: ['nebius.telemetry.read'], projects: ['*'] },
    ] } });
    const fleet = await get('user:default/mixed', '/fleet');
    expect(fleet.status).toBe(200);
    expect(fleet.body.rows.map((r: { projectId: string }) => r.projectId)).toEqual(['project-e00mocksandbox']);
  });

  it('history does not expose stored GPU utilization without telemetry permission', async () => {
    const { get } = await backend();
    const stored = jest.spyOn(HistoryStore.prototype, 'since').mockResolvedValue([{
      day: '2026-10-09', projectId: 'project-e00mocksandbox', region: 'eu-north1', stage: 'sandbox',
      resources: 1, runningInstances: 1, gpus: 1, vcpus: 16, ttlExpired: 0, orphanCandidates: 0,
      gpuUtilSum: 75, gpuUtilSamples: 1,
    }]);
    try {
      const owner = await get('user:default/admin', '/history');
      expect(owner.status).toBe(200);
      expect(owner.body.points[0].gpuUtilMean).toBe(75);
      const reader = await get('user:default/viewer', '/history');
      expect(reader.status).toBe(200);
      expect(reader.body.points[0]).toMatchObject({ gpus: 1, resources: 1, gpuUtilMean: null });
    } finally {
      stored.mockRestore();
    }
  });

  it('Fleet: GPU × time from the sample store, roll-ups, idle cost at the live price and service panels', async () => {
    const { get } = await backend();
    const res = await get('user:default/admin', '/fleet?range=24h');
    expect(res.status).toBe(200);
    const f = res.body as FleetResponse;
    expect(f.buckets).toHaveLength(96);
    expect(f.rows.map(r => r.instanceName ?? r.node).sort()).toEqual(['bench-b300-1gpu', 'nip-legacy-teardown-gpu-0', 'nip-sandbox-inference-gpu-0']);
    // A GPU VM deleted minutes ago still has fresh samples: shown in the range, not as running now.
    expect(f.rows.find(r => r.node === 'nip-legacy-teardown-gpu-0')).toMatchObject({ runningNow: false, notRunning: 'VM no longer in the inventory (deleted)', gpuName: 'GPU 0' });
    expect(f.gpus).toEqual({ inRange: 3, runningNow: 2 });
    const sandbox = f.rows.find(r => r.instanceName === 'nip-sandbox-inference-gpu-0')!;
    expect(sandbox).toMatchObject({ nodeGroupName: 'nip-sandbox-inference-gpu', clusterId: 'mk8scluster-e00mockinf', instanceUid: 'nebius:computeinstance-e00mockinfgpu0' });
    expect(sandbox.values.util.filter(v => v !== null).length).toBe(96);
    // The legacy GPU's series names a node group the inventory no longer has (followup 34): a node-group row, marked deleted.
    expect(f.rollups.nodeGroups.map(n => n.kind).sort()).toEqual(['node-group', 'node-group', 'standalone']);
    expect(f.rows.find(r => r.instanceId === 'computeinstance-e00mockgonegpu')).toMatchObject({ nodeGroupId: 'mk8snodegroup-e00mockgoneold', deleted: { vm: true, nodeGroup: true } });
    expect(f.freshness.state).toBe('live');
    // The lab GPU dips below 5 % in the stub's history: idle hours priced at the calculator's (XTS) list price.
    expect(f.idle.value!.gpuHours).toBeGreaterThan(0);
    expect(f.idle.value!.cost?.currency).toBe('XTS');
    expect(f.idle.note).toMatch(/Estimate/);
    const storage = f.services.find(s => s.id === 'object-storage')!;
    expect(storage).toMatchObject({ state: 'live' });
    expect(storage.items[0].figures[0]).toEqual({ label: 'Requests', value: 2.5, unit: 'req/s' });
    expect(f.services.find(s => s.id === 'postgresql')).toMatchObject({ state: 'no-metrics', reason: expect.stringMatching(/sp_postgres/) });
    const legacy = (await get('user:default/admin', '/fleet?project=project-e00mocklegacy')).body as FleetResponse;
    expect(legacy.services.find(s => s.id === 'object-storage')).toMatchObject({ state: 'none-in-scope', reason: 'No bucket in scope.' });
    expect(legacy.rows.map(r => r.runningNow)).toEqual([false]);
    // Its idle hours are counted, never priced: a deleted VM has no live price.
    expect(legacy.idle.value).toMatchObject({ cost: null, unpriced: [expect.objectContaining({ reason: expect.stringMatching(/not in the current inventory/) })] });
    expect((await get('user:default/admin', '/fleet?range=7d')).body.buckets).toHaveLength(168);
    expect((await get('user:default/admin', '/fleet?range=2d')).status).toBe(400);
  });

  it('Fleet under a region filter keeps the GPU of a VM deleted since (G2.1)', async () => {
    const { get } = await backend();
    // The legacy project runs in eu-west1; its GPU VM left the inventory but its samples are fresh.
    const west = (await get('user:default/admin', '/fleet?region=eu-west1')).body as FleetResponse;
    expect(west.rows.map(r => r.node)).toEqual(['nip-legacy-teardown-gpu-0']);
    expect(west.rows[0]).toMatchObject({ notRunning: 'VM no longer in the inventory (deleted)' });
    const north = (await get('user:default/admin', '/fleet?region=eu-north1')).body as FleetResponse;
    expect(north.rows.map(r => r.node)).not.toContain('nip-legacy-teardown-gpu-0');
  });

  it('operate routes refuse JSON bodies over 64 KB', async () => {
    const { post } = await backend();
    const big = await post('user:default/admin', '/alerts/0123456789abcdef/notes', { kind: 'ack', note: 'x'.repeat(100 * 1024) });
    expect(big.status).toBe(413);
    const small = await post('user:default/admin', '/alerts/0123456789abcdef/notes', { kind: 'ack', note: 'x'.repeat(100) });
    expect(small.status).toBe(404); // parsed, then: no such alert
    expect((await post('user:default/admin', '/budgets/budget', { name: 'x'.repeat(100 * 1024) })).status).toBe(413);
  });

  it('Fleet needs nebius.telemetry.read and is scoped to the caller projects', async () => {
    const { get } = await backend();
    expect((await get('user:default/viewer', '/fleet')).status).toBe(403);
    const alice = (await get('user:default/alice', '/fleet')).body as FleetResponse;
    expect(new Set(alice.rows.map(r => r.projectId))).toEqual(new Set(['project-e00mocksandbox']));
    const filtered = (await get('user:default/admin', '/fleet?project=project-e00mocklab')).body as FleetResponse;
    expect(filtered.rows.map(r => r.projectId)).toEqual(['project-e00mocklab']);
  });

  it('Alerts: evaluated after the first sync, scoped, with in-cluster rules listed and a guided fix', async () => {
    const { get } = await backend();
    const res = await get('user:default/admin', '/alerts');
    expect(res.status).toBe(200);
    const a = res.body as AlertsResponse;
    expect(a.lastEvalAt).toBeDefined();
    expect(a.problems).toEqual([]);
    const maint = a.alerts.find(x => x.ruleName === 'MaintenanceScheduled');
    expect(maint).toMatchObject({ state: 'firing', projectId: 'project-e00mockstaging', severity: 'info' });
    // One duration formatter: "in 49 d" as on Capacity, never "in 1198.3 h" (F1.3).
    expect(maint!.summary).toMatch(/^Maintenance .+ (in \d+ (min|h|d)|now)$/);
    expect(a.rules.filter(r => r.status === 'needs-in-cluster').length).toBeGreaterThan(5);
    expect(a.rules.find(r => r.name === 'GpuIdle')).toMatchObject({ status: 'evaluated', source: 'nebius' });
    expect(a.channels).toEqual(['browser']);
    // Teardown (stub, project-e00mocklegacy): no alert for a planned teardown or a VM that left the inventory.
    expect(a.alerts.filter(x => x.ruleName === 'PreemptibleNodeLost')).toEqual([]); // stopped node of a DELETING group past its TTL
    expect(a.alerts.filter(x => x.labels.instance_id === 'computeinstance-e00mockgonegpu')).toEqual([]); // DCGM still answers for it
    expect(a.alerts.filter(x => x.ruleName === 'ConnectorFailing')).toEqual([]);
    // Names, not ids: the Xid alert reads by VM name and GPU index, with the ids in its subject.
    const xid = a.alerts.find(x => x.ruleName === 'GpuXidError');
    expect(xid).toMatchObject({ summary: expect.stringContaining('nip-sandbox-inference-gpu-0 GPU 0'), subject: expect.objectContaining({ instanceId: 'computeinstance-e00mockinfgpu0', projectName: expect.any(String) }) });
    // Scope: alice sees only the sandbox project's alerts.
    const alice = (await get('user:default/alice', '/alerts')).body as AlertsResponse;
    expect(alice.alerts.every(x => x.projectId === 'project-e00mocksandbox')).toBe(true);
    expect((await get('user:default/alice', `/alerts/${maint!.id}`)).status).toBe(404);
    // Rule counts follow the caller's scope: the staging maintenance alert is not counted for alice.
    const count = (xs: AlertsResponse['alerts'], ruleId: string, state: string) => xs.filter(x => x.ruleId === ruleId && x.state === state).length;
    expect(a.rules.find(r => r.id === maint!.ruleId)!.firing).toBe(count(a.alerts, maint!.ruleId, 'firing'));
    expect(alice.rules.find(r => r.id === maint!.ruleId)!.firing).toBe(0);
    for (const r of alice.rules) {
      expect(r.firing).toBe(count(alice.alerts, r.id, 'firing'));
      expect(r.pending).toBe(count(alice.alerts, r.id, 'pending'));
    }

    const detail = (await get('user:default/admin', `/alerts/${maint!.id}`)).body as AlertDetailResponse;
    expect(detail.guidedFix).toMatchObject({ readOnly: true, docs: 'https://docs.nebius.com/kubernetes/maintenance/manage#how-to-check-that-a-maintenance-event-is-issued' });
    expect(detail.guidedFix.runbook).toMatchObject({ path: 'runbooks/maintenance.md', anchor: 'scheduled-node-maintenance', title: 'Scheduled node maintenance' });
    expect(detail.guidedFix.checks.length).toBeGreaterThan(0);
    expect(detail.history[0]).toMatchObject({ from: 'inactive', to: 'firing' });
    expect(detail.alert.links.map(l => l.to)).toContain('/capacity?project=project-e00mockstaging');
  });

  it('acknowledge and mute are local notes with the user ref; they need nebius.alerts.annotate', async () => {
    const { get, post, del } = await backend();
    const a = ((await get('user:default/admin', '/alerts')).body as AlertsResponse).alerts.find(x => x.ruleName === 'MaintenanceScheduled')!;
    expect((await post('user:default/viewer', `/alerts/${a.id}/notes`, { kind: 'ack' })).status).toBe(403);
    expect((await post('user:default/admin', `/alerts/${a.id}/notes`, { kind: 'mute', minutes: 1 })).status).toBe(400);
    const ack = await post('user:default/admin', `/alerts/${a.id}/notes`, { kind: 'ack', note: 'looking' });
    expect(ack.status).toBe(201);
    expect(ack.body).toMatchObject({ kind: 'ack', userRef: 'user:default/admin', note: 'looking' });
    expect((await post('user:default/admin', `/alerts/${a.id}/notes`, { kind: 'mute', minutes: 60 })).status).toBe(201);
    const after = (await get('user:default/admin', '/alerts')).body as AlertsResponse;
    const view = after.alerts.find(x => x.id === a.id)!;
    expect(view.acknowledged?.userRef).toBe('user:default/admin');
    expect(view.muted?.until).toBe('2026-10-10T13:00:00.000Z');
    expect(after.counts.muted).toBe(1);
    expect((await del('user:default/admin', `/alerts/${a.id}/notes/mute`)).status).toBe(204);
    expect(((await get('user:default/admin', '/alerts')).body as AlertsResponse).counts.muted).toBe(0);
  });

  it('Logs: buckets per project, "no logs yet" for a bucket Nebius has not created, presets and validation', async () => {
    const { get } = await backend();
    const b = (await get('user:default/admin', '/logs/buckets?project=project-e00mocksandbox')).body as LogBucketsResponse;
    expect(b.buckets.find(x => x.id === 'sp_serial')?.state).toBe('present');
    expect(b.buckets.find(x => x.id === 'sp_postgres')).toMatchObject({ state: 'no-logs-yet', note: expect.stringMatching(/No logs yet from Managed PostgreSQL/) });
    expect(b.presets.map(p => p.id)).toEqual(['serial-errors', 'control-plane-errors', 'postgres-errors']);

    const q = (query: string, extra = '') => get('user:default/admin', `/logs/query?project=project-e00mocksandbox&query=${encodeURIComponent(query)}${extra}`);
    const serial = (await q(b.presets[0].query)).body as LogsResponse;
    expect(serial.bucketState).toBe('ok');
    expect(serial.lines.map(l => l.line)).toEqual(expect.arrayContaining(['[  106.10] FAILED Failed to start nvidia-fabricmanager.service', '[   14.20] kubelet: error: node not yet registered']));
    expect(serial.lines.every(l => !l.line.includes(String.fromCharCode(27)))).toBe(true);
    // G3.15: systemd's "[  OK  ] Stopped … that failed at package install time" (colour codes and all) is not an error.
    expect(serial.lines.some(l => /\bOK\b/.test(l.line))).toBe(false);
    const all = (await q('{__bucket__="sp_serial"}')).body as LogsResponse;
    expect(all.lines.some(l => l.line.startsWith('[  OK  ] Stopped update-notifier-download'))).toBe(true);
    const vm = (await q('{__bucket__="sp_serial", sp_resource_id="computeinstance-e00mockinfgpu0"}')).body as LogsResponse;
    expect(vm.lines).toHaveLength(4);
    const pg = (await q('{__bucket__="sp_postgres"} |~ "ERROR"')).body as LogsResponse;
    expect(pg).toMatchObject({ bucketState: 'no-logs-yet', lines: [], note: expect.stringMatching(/No logs yet from Managed PostgreSQL/) });
    const bad = await q('{level="error"}');
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/must name a bucket/);
    expect((await q('{__bucket__="sp_serial"}', '&limit=5000')).status).toBe(400);
    // G3.5: a parser stage Nebius fails on (500 on plain-text sp_serial) is a plain-word 400, not the upstream URL.
    const json = await q('{__bucket__="sp_serial"} | json');
    expect(json.status).toBe(400);
    expect(json.body.error.message).toMatch(/^Nebius Logs could not run this query \(HTTP 500\)\. Parser stages such as \| json/);
    expect(json.body.error.message).not.toMatch(/https?:|loki/);
    expect(((await q('{__bucket__="sp_mk8s_control_plane"} | json')).body as LogsResponse).bucketState).toBe('ok');
  });

  it('Logs: each bucket with lines says when it wrote last, so the page can open on one that has lines', async () => {
    const { get } = await backend();
    const staging = (await get('user:default/admin', '/logs/buckets?project=project-e00mockstaging')).body as LogBucketsResponse;
    expect(staging.buckets.find(x => x.id === 'sp_mk8s_control_plane')?.newest).toMatch(/^2026-10-10T/);
    expect(staging.buckets.find(x => x.id === 'sp_serial')).toMatchObject({ state: 'no-logs-yet' });
    expect(staging.buckets.find(x => x.id === 'sp_serial')?.newest).toBeUndefined();
  });

  it('Logs follow the global region and stage filter (G3.3)', async () => {
    const { get } = await backend();
    const lab = (await get('user:default/admin', '/logs/buckets?region=uk-south1')).body as LogBucketsResponse;
    expect(lab.project.id).toBe('project-e00mocklab');
    expect(lab.projects.map(p => p.id)).toEqual(['project-e00mocklab']);
    const north = (await get('user:default/admin', '/logs/buckets?region=eu-north1')).body as LogBucketsResponse;
    expect(north.projects.map(p => p.id).sort()).toEqual(['project-e00mocksandbox', 'project-e00mockstaging']);
    // The stub's staging wrote last (sandbox has been quiet for 5 min): the default is the one that wrote last (#31).
    expect(north.project.id).toBe('project-e00mockstaging');
    expect(north.projectsWithLogs?.find(p => p.id === 'project-e00mockstaging')?.newest).toBeDefined();
    const sandbox = (await get('user:default/admin', '/logs/buckets?stage=sandbox')).body as LogBucketsResponse;
    // The stub's lab project also runs a sandbox-labelled VM; staging and legacy carry no sandbox resource.
    expect(sandbox.projects.map(p => p.id).sort()).toEqual(['project-e00mocklab', 'project-e00mocksandbox']);
    const none = (await get('user:default/admin', '/logs/buckets?region=eu-west2')).body as LogBucketsResponse;
    expect(none).toMatchObject({ project: { id: '' }, projects: [], unavailableReason: 'No project in scope has region=eu-west2.' });
    // A chosen project outside the region: nothing, said in words.
    const mismatch = (await get('user:default/admin', '/logs/buckets?project=project-e00mocklab&region=eu-north1')).body as LogBucketsResponse;
    expect(mismatch).toMatchObject({ project: { id: '' }, unavailableReason: 'No project in scope has region=eu-north1 and project=nip-lab.' });
  });

  it('Logs need nebius.logs.read and a project in scope', async () => {
    const { get } = await backend();
    expect((await get('user:default/viewer', '/logs/buckets')).status).toBe(403);
    expect((await get('user:default/alice', '/logs/buckets?project=project-e00mocklab')).status).toBe(403);
    expect((await get('user:default/alice', `/logs/query?project=project-e00mocklab&query=${encodeURIComponent('{__bucket__="sp_serial"}')}`)).status).toBe(403);
    const own = (await get('user:default/alice', '/logs/buckets')).body as LogBucketsResponse;
    expect(own.project.id).toBe('project-e00mocksandbox');
    expect(own.projects.map(p => p.id)).toEqual(['project-e00mocksandbox']);
  });

  it('Audit events: tenant-wide, read on demand per region, writes only by default, nothing sensitive copied', async () => {
    const { get } = await backend();
    const a = (await get('user:default/admin', '/audit/events')).body as AuditEventsResponse;
    expect(a).toMatchObject({ region: 'eu-north1', regions: ['eu-north1', 'eu-west1', 'uk-south1'], writesOnly: true, truncated: false, serverFiltered: true });
    // The LIST by the portal's own identity is hidden; the 2000-minute-old delete is outside the default 24 h.
    expect(a.events.map(e => e.id)).toEqual(['auditevent-e00mock1', 'auditevent-e00mock3', 'auditevent-e00mock5']);
    // #37: an operation with status ERROR and an empty error message carries its gRPC code as the error.
    expect(a.events[2]).toMatchObject({ status: 'ERROR', error: 'FAILED_PRECONDITION', resource: { type: 'subnet', name: 'nip-sandbox-subnet' } });
    expect(a.events[0]).toEqual({
      id: 'auditevent-e00mock1', time: expect.any(String), service: 'COMPUTE', action: 'CREATE', type: 'ai.nebius.compute.instance.create', status: 'DONE',
      who: { kind: 'service-account', id: 'serviceaccount-e00mockci', name: 'nip-ci' },
      resource: { type: 'instance', id: 'computeinstance-e00mocknew', name: 'nip-sandbox-gpu-vm' }, authorized: true,
    });
    expect(a.events[1]).toMatchObject({ who: { kind: 'user', name: 'Platform Owner' }, authorized: false, error: 'PermissionDenied' });
    const all = (await get('user:default/admin', '/audit/events?reads=true&sinceMinutes=2880&limit=200')).body as AuditEventsResponse;
    expect(all.events.map(e => e.action)).toEqual(['CREATE', 'LIST', 'CREATE', 'DELETE', 'DELETE']);
    const short = (await get('user:default/admin', '/audit/events?reads=true&sinceMinutes=2880&limit=2')).body as AuditEventsResponse;
    expect(short).toMatchObject({ truncated: true, events: [{ id: 'auditevent-e00mock1' }, { id: 'auditevent-e00mock2' }] });
    expect(JSON.stringify(all)).not.toContain('never-copied-stub-value');
    expect(((await get('user:default/admin', '/audit/events?region=uk-south1')).body as AuditEventsResponse).events).toEqual([]);
    expect((await get('user:default/admin', '/audit/events?region=us-central1')).status).toBe(400);
    expect((await get('user:default/viewer', '/audit/events')).status).toBe(403);
    // Tenant-wide events: a role scoped to some projects does not see them.
    expect((await get('user:default/alice', '/audit/events')).status).toBe(403);
  });

  it('Integrations lists the metrics-history and logs connectors with their capabilities', async () => {
    const { get } = await backend();
    const res = await get('user:default/admin', '/integrations');
    expect(res.body.statuses.find((s: any) => s.id === 'nebius-metrics-history')).toMatchObject({ state: 'ok' });
    expect(res.body.statuses.find((s: any) => s.id === 'nebius-logging')).toMatchObject({ state: 'ok' });
    expect(res.body.capabilities.find((c: any) => c.id === 'monitoring.gpu-history')).toMatchObject({ state: 'ok', verified: '2026-10-11' });
    expect(res.body.capabilities.find((c: any) => c.id === 'logs.labels')).toMatchObject({ state: 'ok', verified: '2026-10-11' });
    expect(res.body.statuses.find((s: any) => s.id === 'nebius-audit')).toMatchObject({ state: 'ok', notes: ['Audit events readable in eu-north1, eu-west1, uk-south1.'] });
    expect(res.body.capabilities.find((c: any) => c.id === 'audit.events.list')).toMatchObject({ state: 'ok', scope: 'tenant', items: 3, verified: '2026-10-11' });
  });
});
