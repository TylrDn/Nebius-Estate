import { mockCredentials, mockServices, startTestBackend } from '@backstage/backend-test-utils';
import request from 'supertest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { nebiusEstatePlugin } from './plugin';
import { testDatabase, permissionsByUser, readTestData, REPO_ROOT, stubNebiusApi, testConfig, TEST_PROJECTS, useTestClock } from './__testUtils__/testing';

const ALL = [
  'nebius.estate.read',
  'nebius.telemetry.read',
  'nebius.provisioning.preview',
  'nebius.provisioning.request.create',
  'nebius.integration.admin',
];

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
        'user:default/estimator': ['nebius.provisioning.preview', 'nebius.commercial.rate.read'],
        'user:default/writer': ['nebius.commercial.rate.write'],
        'user:default/pricer': ['nebius.estate.read', 'nebius.telemetry.read', 'nebius.provisioning.preview', 'nebius.commercial.rate.read', 'nebius.commercial.scenario.read'],
        'user:default/nobody': [],
      }),
    ],
  });
  const as = (user: string) => (r: request.Test) => r.set('Authorization', mockCredentials.user.header(user));
  return { server, as };
}

const sandboxInput = {
  recipe: 'sandbox-inference',
  stage: 'sandbox',
  region: 'eu-north1',
  gpuNodeCount: 2,
  capacityType: 'preemptible',
  ttlExpires: '2026-10-10T20:00:00Z',
  runtimeHours: 8,
  owner: 'platform',
  requestRef: 'ticket-9',
};
// The stub tenant's eu-north1 non-GPU vCPU limit is 0 (as live): the committed CPU nodes stop the plan, so a request
// that is prepared says a quota request is pending (W1-P3).
const pendingInput = { ...sandboxInput, quotaRequestPending: true };

describe('nebius-estate backend', () => {
  stubNebiusApi();
  useTestClock();

  it('rejects unauthenticated calls', async () => {
    const { server } = await backend();
    const res = await request(server).get('/api/nebius-estate/overview').set('Authorization', mockCredentials.none.header());
    expect(res.status).toBe(401);
  });

  it('/meta names the test endpoints the backend reads (F1.29)', async () => {
    const { server, as } = await backend();
    const test = await as('user:default/viewer')(request(server).get('/api/nebius-estate/meta'));
    expect(test.body.testData).toEqual({ endpoints: ['nebius.mk8s.testEndpoint'] });
  });

  it('/meta has no testData when every endpoint is the documented Nebius one (F1.29)', async () => {
    const live = await startTestBackend({
      features: [
        testDatabase(),
        nebiusEstatePlugin,
        mockServices.rootConfig.factory({ data: testConfig({ waitForFirstSync: false, nebius: { tenantId: 'tenant-e00mocktest', projects: TEST_PROJECTS, auth: { tokenEnv: 'NEBIUS_TEST_TOKEN' }, pricing: { currency: 'xts' }, minRequestIntervalMs: 0 } }) }),
        permissionsByUser({ 'user:default/viewer': ['nebius.estate.read'] }),
      ],
    });
    const res = await request(live.server).get('/api/nebius-estate/meta').set('Authorization', mockCredentials.user.header('user:default/viewer'));
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('testData');
  });

  it('enforces permissions per route', async () => {
    const { server, as } = await backend();
    expect((await as('user:default/nobody')(request(server).get('/api/nebius-estate/resources'))).status).toBe(403);
    expect((await as('user:default/viewer')(request(server).get('/api/nebius-estate/resources'))).status).toBe(200);
    expect((await as('user:default/viewer')(request(server).post('/api/nebius-estate/provisioning/preview').send(sandboxInput))).status).toBe(403);
    expect((await as('user:default/viewer')(request(server).post('/api/nebius-estate/integrations/nebius-inventory/sync'))).status).toBe(403);
  });

  it('hides telemetry without nebius.telemetry.read instead of showing zero', async () => {
    const { server, as } = await backend();
    const viewer = await as('user:default/viewer')(request(server).get('/api/nebius-estate/overview'));
    expect(viewer.body.gpuUtilization.value).toBeNull();
    expect(viewer.body.gpuUtilization.unavailableReason).toMatch(/telemetry.read/);
    const admin = await as('user:default/admin')(request(server).get('/api/nebius-estate/overview'));
    // Nebius Monitoring (no cluster needed): the mean of the GPU series in scope, with its source.
    expect(admin.body.gpuUtilization).toMatchObject({ value: { meanPercent: 37.8, gpusReporting: 2 }, source: 'Nebius Monitoring (service-provider GPU metrics)' });
  });

  it('scopes every read to the caller projects', async () => {
    const { server, as } = await backend();
    const all = await as('user:default/admin')(request(server).get('/api/nebius-estate/resources'));
    const alice = await as('user:default/alice')(request(server).get('/api/nebius-estate/resources'));
    expect(new Set(all.body.items.map((r: any) => r.projectId)).size).toBe(4);
    expect(new Set(alice.body.items.map((r: any) => r.projectId))).toEqual(new Set(['project-e00mocksandbox']));
    const hidden = all.body.items.find((r: any) => r.projectId === 'project-e00mocklab');
    const detail = await as('user:default/alice')(request(server).get(`/api/nebius-estate/resources/${encodeURIComponent(hidden.uid)}`));
    expect(detail.status).toBe(404);
    const filters = await as('user:default/alice')(request(server).get('/api/nebius-estate/filters'));
    expect(filters.body.projects.map((p: any) => p.id)).toEqual(['project-e00mocksandbox']);
  });

  it('applies the global project / region / stage filter to overview, capacity and workloads', async () => {
    const { server, as } = await backend();
    const get = (path: string) => as('user:default/admin')(request(server).get(`/api/nebius-estate${path}`));
    const lab = await get('/capacity?project=project-e00mocklab');
    expect(new Set(lab.body.nodeGroups.map((g: any) => g.projectId))).toEqual(new Set(['project-e00mocklab']));
    // The REST API gives no instance → node-group membership, so GPU VMs count as standalone (never inferred by name).
    expect(lab.body.standaloneGpuVms.map((v: any) => v.name)).toEqual(['bench-b300-1gpu']);
    const staging = await get('/overview?stage=staging');
    expect(staging.body.projects.value).toEqual(['project-e00mockstaging']);
    expect(staging.body.gpuUtilization.value).toBeNull(); // no telemetry for the staging cluster: Unavailable, not 0
    const uk = await get('/overview?region=uk-south1');
    expect(uk.body.gpuInventory.value.byPlatform).toEqual({ 'gpu-b300-sxm': 1 });
  });

  it('serves daily history scoped to the caller and the filter, with gaps kept', async () => {
    const { server, as } = await backend();
    const all = await as('user:default/admin')(request(server).get('/api/nebius-estate/history?days=30'));
    expect(all.status).toBe(200);
    // Only the day the portal has run is recorded: earlier days are gaps, not zeros. The sync counted 2 running GPUs;
    // GPU telemetry also saw the legacy project's GPU VM that is no longer in the instance list, so the day is raised
    // to 3 and marked incomplete (#33, backfillHistory after the first sync).
    expect(all.body.points).toEqual([expect.objectContaining({ day: '2026-10-10', gpus: 3, incomplete: expect.stringMatching(/hourly GPU samples/) })]);
    const alice = await as('user:default/alice')(request(server).get('/api/nebius-estate/history?days=30'));
    expect(alice.body.points).toEqual([expect.objectContaining({ day: '2026-10-10', gpus: 1 })]);
    // Alice's sandbox day keeps its 1 GPU and is not marked: the first sync ran before the telemetry recorder, so
    // today's missing utilisation is start-up order, not a gap in the record (#33).
    expect(alice.body.points[0].incomplete).toBeUndefined();
    const bad = await as('user:default/admin')(request(server).get('/api/nebius-estate/history?days=9999'));
    expect(bad.status).toBe(400);
  });

  it('validates query input', async () => {
    const { server, as } = await backend();
    const res = await as('user:default/admin')(request(server).get('/api/nebius-estate/resources?project=../../etc'));
    expect(res.status).toBe(400);
  });

  it('serves only allowlisted documents (no traversal)', async () => {
    const { server, as } = await backend();
    const get = (p: string) => as('user:default/admin')(request(server).get(`/api/nebius-estate/document?path=${encodeURIComponent(p)}`));
    expect((await get('runbooks/deploy.md')).status).toBe(200);
    for (const bad of ['../../../etc/passwd', 'docs/../../secret.md', '.git/config', 'terraform/live/sandbox/inference/backend.hcl', '/etc/hosts', 'docs/evidence/raw/2026-10-08-mk8s-b300/run.sh']) {
      expect((await get(bad)).status).toBe(403);
    }
  });

  it('checks a training request against the capacity advisor and suggests where there is room', async () => {
    const { server, as } = await backend();
    const input = { ...sandboxInput, recipe: 'training-capacity', stage: 'sandbox', capacityType: 'on-demand', gpuNodeCount: 2, filestoreSizeGib: 256 };
    const preview = await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/preview').send(input));
    expect(preview.status).toBe(200);
    expect(preview.body.availability).toMatchObject({ state: 'short', platform: 'gpu-h100-sxm', preset: '8gpu-128vcpu-1600gb', level: 'low', available: 1, requested: 2 });
    expect(preview.body.availability.alternatives[0]).toMatchObject({ region: 'us-central1', capacityType: 'on-demand', available: 3 });
    expect(preview.body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'warning', field: 'gpuNodeCount', message: expect.stringContaining('1 available vs 2 requested') })]));
  });

  it('previews a policy-checked change and prepares exactly one open request per file', async () => {
    const { server, as } = await backend();
    const preview = await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/preview').send(sandboxInput));
    expect(preview.status).toBe(200);
    expect(preview.body.change.files[0].path).toBe('terraform/live/sandbox/inference/sandbox.auto.tfvars');
    // Pre-check against the tenant allowances of eu-north1: the CPU system nodes are blocked (vCPU limit 0).
    expect(preview.body.quotaCheck).toMatchObject({ region: 'eu-north1', source: 'tenant' });
    expect(preview.body.quotaCheck.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ quota: 'compute.instance.non-gpu.vcpu', state: 'blocked', limit: 0 }),
        // Preemptible GPU VMs draw on the preemptible VM count, not the GPU quota (regular VMs only).
        expect.objectContaining({ quota: 'compute.instance.preemptible.count', state: 'ok', limit: 8, usage: 1, need: 2 }),
      ]),
    );
    expect(preview.body.quotaCheck.lines.map((l: any) => l.quota)).not.toContain('compute.instance.gpu.h100');
    // G5.3: every form recipe creates a Managed Kubernetes cluster; its quota is a line (limit 2 in the stub tenant).
    expect(preview.body.change.quota.mk8sClusters).toBe(1);
    expect(preview.body.quotaCheck.lines).toEqual(expect.arrayContaining([expect.objectContaining({ quota: 'mk8s.cluster.count', need: 1, limit: 2, state: 'ok' })]));
    // W1-P3: a quota at limit 0 stops the plan, as make preflight fails it: an error that refuses Prepare, with the
    // diff still shown (W1-P5)…
    expect(preview.body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', field: 'quota', message: expect.stringMatching(/compute\.instance\.non-gpu\.vcpu.*limit 0/) })]));
    expect((await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/requests').send({ input: sandboxInput, baseHashes: preview.body.baseHashes }))).status).toBe(400);
    // …unless the request says a quota request is pending: then a warning, recorded with it.
    const pending = await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/preview').send(pendingInput));
    const quotaIssues = pending.body.issues.filter((i: any) => i.field === 'quota');
    expect(quotaIssues.length).toBeGreaterThan(0);
    expect(quotaIssues.every((i: any) => i.severity === 'warning')).toBe(true);
    // #13: the quota card is stamped with the tenant allowances' own read time.
    expect(pending.body.quotaCheck.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const hash = preview.body.baseHashes['terraform/live/sandbox/inference/sandbox.auto.tfvars'];

    const stale = await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/requests').send({ input: pendingInput, baseHashes: { 'terraform/live/sandbox/inference/sandbox.auto.tfvars': '0'.repeat(64) } }));
    expect(stale.status).toBe(409);

    const created = await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/requests').send({ input: pendingInput, baseHashes: preview.body.baseHashes }));
    expect(created.status).toBe(201);
    expect(created.body.state).toBe('prepared');
    expect(created.body.patch).toContain('+gpu_node_count');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const second = await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/requests').send({ input: { ...pendingInput, requestRef: 'ticket-10' }, baseHashes: preview.body.baseHashes }));
    expect(second.status).toBe(409);

    const patch = await as('user:default/admin')(request(server).get(`/api/nebius-estate/provisioning/requests/${created.body.id}/patch`));
    expect(patch.headers['content-type']).toMatch(/text\/x-diff/);
    expect(patch.text).toBe(created.body.patch);

    // The repository file itself is untouched: the portal never writes it.
    const onDisk = readFileSync(resolve(REPO_ROOT, 'terraform/live/sandbox/inference/sandbox.auto.tfvars'), 'utf8');
    expect(onDisk).toContain('gpu_node_count  = 1');

    const deployed = await as('user:default/admin')(request(server).post(`/api/nebius-estate/provisioning/requests/${created.body.id}/evidence`).send({ state: 'deployed' }));
    expect(deployed.status).toBe(400);
  });

  it('#27: a request with the l40s-gpu-only run profile is sized, priced and quota-checked as make plan PROFILE= plans it', async () => {
    const { server, as } = await backend();
    const recipes = await as('user:default/admin')(request(server).get('/api/nebius-estate/provisioning/recipes'));
    const root = recipes.body.sizing.find((x: any) => x.stage === 'sandbox' && x.stack === 'inference');
    expect(root.runProfiles.map((p: any) => p.name)).toContain('l40s-gpu-only');
    const input = { ...sandboxInput, gpuNodeCount: 1, runProfile: 'l40s-gpu-only', platform: 'gpu-l40s-a', filestoreSizeGib: 64 };
    const preview = await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/preview').send(input));
    expect(preview.status).toBe(200);
    expect(preview.body.change.quota.nonGpuVcpus).toBe(0);
    expect(preview.body.quotaCheck.lines.filter((l: any) => l.state !== 'ok')).toEqual([]);
    expect(preview.body.issues.filter((i: any) => i.severity === 'error')).toEqual([]);
    expect(preview.body.change.runSheet.join('\n')).toContain('PROFILE=l40s-gpu-only');
    // The committed sizing (2 CPU nodes) is blocked in the same tenant: the profile is what makes it fit.
    const committed = await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/preview').send({ ...sandboxInput, gpuNodeCount: 1 }));
    expect(committed.body.issues.some((i: any) => i.severity === 'error' && i.field === 'quota')).toBe(true);
  });

  it('W1-P2: a prod training request that shrinks the shared filesystem is refused unless the shrink is intended', async () => {
    const { server, as } = await backend();
    const input = { ...sandboxInput, recipe: 'training-capacity', stage: 'prod', capacityType: 'on-demand', gpuNodeCount: 0, filestoreSizeGib: 256, ttlExpires: undefined, quotaRequestPending: true };
    const preview = await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/preview').send(input));
    expect(preview.body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', field: 'filestoreSizeGib', message: expect.stringMatching(/4,096 GiB to 256 GiB/) })]));
    expect(preview.body.change.files[0].diff).toContain('+filestore_size_gib = 256');
    expect((await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/requests').send({ input, baseHashes: preview.body.baseHashes }))).status).toBe(400);
  });

  it('G5.4: a request whose patch changes nothing takes no lock on the sizing file; a lock names how it ends', async () => {
    const { server, as } = await backend();
    const admin = as('user:default/admin');
    // gpu_node_count 1 and preemptible already match the committed sizing file: an empty patch.
    const same = { ...pendingInput, gpuNodeCount: 1, filestoreSizeGib: 64, requestRef: 'audit-same' };
    const preview = await admin(request(server).post('/api/nebius-estate/provisioning/preview').send(same));
    expect(preview.body.change.files.every((f: any) => !f.diff)).toBe(true);
    const noop = await admin(request(server).post('/api/nebius-estate/provisioning/requests').send({ input: same, baseHashes: preview.body.baseHashes }));
    expect(noop.status).toBe(201);
    expect(noop.body.patch).toBe('');

    const p2 = await admin(request(server).post('/api/nebius-estate/provisioning/preview').send(pendingInput));
    const changed = await admin(request(server).post('/api/nebius-estate/provisioning/requests').send({ input: pendingInput, baseHashes: p2.body.baseHashes }));
    expect(changed.status).toBe(201);
    const clash = await admin(request(server).post('/api/nebius-estate/provisioning/requests').send({ input: { ...pendingInput, requestRef: 'ticket-11' }, baseHashes: p2.body.baseHashes }));
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toMatch(/withdraw it, or mark it deployed once its PR is merged/);
    expect(clash.body.error.message).not.toMatch(/wait until it is merged/);
  });

  it('G5.1: an approved request is withdrawn or marked deployed with its evidence file, and either frees the file', async () => {
    const { server, as } = await backend();
    const admin = as('user:default/admin');
    const preview = await admin(request(server).post('/api/nebius-estate/provisioning/preview').send(pendingInput));
    const prepare = (ref: string) => admin(request(server).post('/api/nebius-estate/provisioning/requests').send({ input: { ...pendingInput, requestRef: ref }, baseHashes: preview.body.baseHashes }));
    const a = await prepare('audit-g5');
    expect((await admin(request(server).post(`/api/nebius-estate/provisioning/requests/${a.body.id}/evidence`).send({ state: 'approved' }))).body.state).toBe('approved');
    expect((await prepare('audit-g5b')).status).toBe(409); // approved still holds the file
    expect((await admin(request(server).post(`/api/nebius-estate/provisioning/requests/${a.body.id}/withdraw`).send({}))).body.state).toBe('withdrawn');
    const b = await prepare('audit-g5c');
    expect(b.status).toBe(201);
    await admin(request(server).post(`/api/nebius-estate/provisioning/requests/${b.body.id}/evidence`).send({ state: 'approved' }));
    const deployed = await admin(request(server).post(`/api/nebius-estate/provisioning/requests/${b.body.id}/evidence`).send({ state: 'deployed', evidence: 'docs/evidence/2026-10-12-sandbox-inference-run.md' }));
    expect(deployed.body).toMatchObject({ state: 'deployed', evidence: 'docs/evidence/2026-10-12-sandbox-inference-run.md' });
    expect((await prepare('audit-g5d')).status).toBe(201);
  });

  it('refuses policy-violating requests server-side, whatever the frontend did', async () => {
    const { server, as } = await backend();
    const res = await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/requests').send({ input: { ...sandboxInput, gpuNodeCount: 5 }, baseHashes: {} }));
    expect(res.status).toBe(400);
    const inj = await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/preview').send({ ...sandboxInput, stage: 'sandbox/../prod' }));
    expect(inj.status).toBe(400);
  });

  it('estimates a previewed request with the default rate book on the portal clock', async () => {
    const { server, as } = await backend();
    const noRates = await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/estimate').send(sandboxInput));
    expect(noRates.status).toBe(403); // an estimate reads rates
    // No rate book (nothing is pre-loaded): the rate book is optional, so the estimate is priced at the built-in Nebius
    // list price (live calculator) and names what that leaves unpriced, never blocked (W1-P6; Wave 1 verification).
    const list = await as('user:default/estimator')(request(server).post('/api/nebius-estate/provisioning/estimate').send(sandboxInput));
    expect(list.status).toBe(200);
    expect(list.body.rateBook).toMatchObject({ id: 'nebius-list-price', name: 'Nebius list price (live calculator)', kind: 'public-list' });
    expect(list.body.footprints[1].lines.find((l: any) => l.component === 'gpu')).toMatchObject({ status: 'priced' });
    expect(list.body.coverage).toHaveProperty('issues');
    const book = JSON.parse(readTestData('ratebook.json'));
    expect((await as('user:default/writer')(request(server).put(`/api/nebius-estate/ratebooks/${book.id}`).send(book))).status).toBe(200);
    const e = await as('user:default/estimator')(request(server).post('/api/nebius-estate/provisioning/estimate').send(sandboxInput));
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ label: 'Draft estimate — not a provider offer or capacity guarantee.', asOf: '2026-10-10', currency: 'XTS', rateBook: { id: 'test-xts' } });
    expect(e.body.generatedAt).toBe('2026-10-10T12:00:00.000Z');
    expect(e.body.footprints.map((f: any) => f.gpus)).toEqual([0, 2, 2]);
    // W1-P5: a request a policy error blocks (5 nodes over the sandbox cap of 2) is still estimated, so the SA sees
    // what it would cost; Prepare stays refused (above).
    const blocked = await as('user:default/estimator')(request(server).post('/api/nebius-estate/provisioning/estimate').send({ ...sandboxInput, gpuNodeCount: 5 }));
    expect(blocked.status).toBe(200);
    expect(blocked.body.footprints.map((f: any) => f.gpus)).toEqual([0, 5, 5]);
    const preview = await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/preview').send({ ...sandboxInput, gpuNodeCount: 5 }));
    expect(preview.body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', field: 'gpuNodeCount' })]));
    expect(preview.body.change.files[0].diff).toContain('+gpu_node_count  = 5');
  });

  it('W1-P5: previews and estimates a request with no reference yet; Prepare refuses it', async () => {
    const { server, as } = await backend();
    const noRef = { ...sandboxInput, requestRef: '' };
    const preview = await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/preview').send(noRef));
    expect(preview.status).toBe(200);
    expect(preview.body.change.files[0].diff).toContain('+gpu_node_count  = 2');
    expect(preview.body.change.runSheet).toEqual([]);
    expect(preview.body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', field: 'requestRef' })]));
    expect((await as('user:default/estimator')(request(server).post('/api/nebius-estate/provisioning/estimate').send(noRef))).status).toBe(200);
    const create = await as('user:default/admin')(request(server).post('/api/nebius-estate/provisioning/requests').send({ input: { ...noRef, quotaRequestPending: true }, baseHashes: {} }));
    expect(create.status).toBe(400);
  });

  it('says why a provisioning estimate is unavailable with neither a rate book nor the live list price', async () => {
    const off = await startTestBackend({
      features: [
        testDatabase(),
        nebiusEstatePlugin,
        mockServices.rootConfig.factory({ data: testConfig({ waitForFirstSync: false, nebius: { tenantId: 'tenant-e00mocktest', projects: TEST_PROJECTS, auth: { tokenEnv: 'NEBIUS_TEST_TOKEN' }, pricing: { currency: 'xts', enabled: false }, minRequestIntervalMs: 0 } }) }),
        permissionsByUser({ 'user:default/estimator': ['nebius.provisioning.preview', 'nebius.commercial.rate.read'] }),
      ],
    });
    const res = await request(off.server).post('/api/nebius-estate/provisioning/estimate').send(sandboxInput).set('Authorization', mockCredentials.user.header('user:default/estimator'));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/^No rate book is imported and the live list price is unavailable: /);
  });

  it('serves the recipe list R1–R16: forms for R1, R3, R4; read-only live roots; documentation and runbooks', async () => {
    const { server, as } = await backend();
    const r = await as('user:default/viewer')(request(server).get('/api/nebius-estate/evidence'));
    expect(r.body.recipes.map((x: any) => x.id)).toEqual(Array.from({ length: 16 }, (_, i) => `R${i + 1}`));
    expect(r.body.recipes.filter((x: any) => x.provisioning === 'form').map((x: any) => x.id)).toEqual(['R1', 'R3', 'R4']);
    expect(r.body.recipes.filter((x: any) => x.provisioning === 'live-root').map((x: any) => x.id)).toEqual(['R7', 'R8', 'R9', 'R10', 'R12']);
    expect(r.body.recipes.every((x: any) => typeof x.docsAvailable === 'boolean' && Array.isArray(x.runbooks))).toBe(true);
    expect(r.body.recipes.find((x: any) => x.id === 'R13').runbooks).toEqual(['runbooks/identity.md', 'runbooks/credential-rotation.md']);
    // The provisioning catalog lists the same recipes, so the page can show those without a form.
    const p = await as('user:default/admin')(request(server).get('/api/nebius-estate/provisioning/recipes'));
    expect(p.body.catalog.map((x: any) => x.id)).toEqual(r.body.recipes.map((x: any) => x.id));
  });

  it('serves the solutions with their composed recipes, status and priceable footprints', async () => {
    const { server, as } = await backend();
    expect((await as('user:default/nobody')(request(server).get('/api/nebius-estate/solutions'))).status).toBe(403);
    const r = await as('user:default/viewer')(request(server).get('/api/nebius-estate/solutions'));
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: any) => x.id)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']);
    const s2 = r.body.items.find((x: any) => x.id === 'S2');
    expect(s2).toMatchObject({ readme: 'solutions/S2-fine-tune-70b-two-weeks/README.md', readmeAvailable: true });
    expect(s2.recipes.map((x: any) => x.id)).toEqual(['R3', 'R8', 'R9', 'R14']);
    expect(s2.footprints.map((f: any) => f.path)).toEqual(['solutions/S2-fine-tune-70b-two-weeks/footprint.json', 'solutions/S2-fine-tune-70b-two-weeks/footprint-b300.json']);
    expect(s2.footprints[0]).toMatchObject({ region: 'eu-north1', runHours: 336, capacityTypes: ['on-demand', 'preemptible'] });
    expect(r.body.items.every((x: any) => x.status && x.footprints.every((f: any) => !f.error))).toBe(true);
    const doc = await as('user:default/viewer')(request(server).get('/api/nebius-estate/document?path=solutions/S8-batch-inference/footprint.json'));
    expect(doc.status).toBe(200);
  });

  it('reads network and data sizing files; a missing allowlisted file is a 404, not an error', async () => {
    const { server, as } = await backend();
    const net = await as('user:default/viewer')(request(server).get('/api/nebius-estate/document?path=terraform/live/sandbox/network/sandbox.auto.tfvars'));
    expect(net.status).toBe(200);
    const missing = await as('user:default/viewer')(request(server).get('/api/nebius-estate/document?path=docs/evidence/1999-01-01-none.md'));
    expect(missing.status).toBe(404);
  });

  it('masks out-of-scope project ids in connector statuses', async () => {
    const { server, as } = await backend();
    const all = await as('user:default/admin')(request(server).get('/api/nebius-estate/integrations'));
    const scoped = await as('user:default/alice')(request(server).get('/api/nebius-estate/integrations'));
    const inv = (b: any) => b.statuses.find((x: any) => x.id === 'nebius-inventory');
    expect(inv(all.body).projects.map((p: any) => p.id)).toContain('project-e00mockstaging');
    expect(inv(scoped.body).projects.map((p: any) => p.id)).toEqual(['project-e00mocksandbox']);
    expect(inv(scoped.body).scope).toBe('1 project in your scope');
    expect(JSON.stringify(inv(scoped.body))).not.toContain('project-e00mockstaging');
    expect(scoped.body.coverage.map((c: any) => c.project?.id)).toEqual(['project-e00mocksandbox']);
  });

  it('reports connector states: a refused list is permission-denied, an unconfigured connector is never called', async () => {
    const { server, as } = await backend();
    const r = await as('user:default/viewer')(request(server).get('/api/nebius-estate/integrations'));
    const state = Object.fromEntries(r.body.statuses.map((x: any) => [x.id, x.state]));
    // MK8s clusters are discovered and connected by themselves; a PROVISIONING one waits. No placeholder once one exists.
    expect(state).toEqual({
      'nebius-inventory': 'permission-denied', 'nebius-monitoring': 'ok', 'nebius-pricing': 'ok', prometheus: 'not-needed', 'billing-object-storage': 'not-configured',
      'mk8s:mk8scluster-e00mockinf': 'ok', 'mk8s:mk8scluster-e00mocktrn': 'ok', 'mk8s:mk8scluster-e00mocksop': 'waiting', 'mk8s:mk8scluster-e00mockgone': 'waiting',
      // AI services (ai/): not configured in the test config, so never called.
      'token-factory': 'not-configured', huggingface: 'not-configured',
      // Fleet history, Logs and audit events (telemetry/, logs/, audit/): extensions of the same sync loop.
      'nebius-metrics-history': 'ok', 'nebius-logging': 'ok', 'nebius-audit': 'ok',
    });
    // Not set up / not needed: no health shown (older runs would only read as failures).
    expect(r.body.statuses.find((x: any) => x.id === 'prometheus').health).toBeUndefined();
    expect(r.body.statuses.find((x: any) => x.id === 'mk8s:mk8scluster-e00mocksop').notes).toEqual([expect.stringMatching(/PROVISIONING; it is connected automatically once RUNNING/)]);
    const caps = Object.fromEntries(r.body.capabilities.map((c: any) => [c.id, c]));
    expect(caps['k8s.cluster:mk8scluster-e00mockinf']).toMatchObject({ state: 'ok', items: 1, connector: 'mk8s:mk8scluster-e00mockinf', scope: 'cluster' });
    // The cluster agent's series: one project has them, the other is waiting for the agent (404).
    expect(caps['monitoring.cluster-gpu']).toMatchObject({ state: 'not-found', hint: expect.stringMatching(/^Waiting for the observability agent: .*nip-staging/) });
    const w = await as('user:default/viewer')(request(server).get('/api/nebius-estate/workloads'));
    expect(JSON.stringify(w.body)).toContain('vllm-qwen');
    // A restricted caller sees only the clusters of its projects.
    const alice = await as('user:default/alice')(request(server).get('/api/nebius-estate/integrations'));
    expect(alice.body.statuses.map((x: any) => x.id).filter((id: string) => id.startsWith('mk8s:'))).toEqual(['mk8s:mk8scluster-e00mockinf']);
    expect(alice.body.capabilities.map((c: any) => c.id).filter((id: string) => id.startsWith('k8s.cluster:'))).toEqual(['k8s.cluster:mk8scluster-e00mockinf']);
    const inv = r.body.statuses.find((x: any) => x.id === 'nebius-inventory');
    expect(inv.error).toMatch(/Networks in project-e00mocklegacy: .*403/);
    expect(r.body.coverage.find((c: any) => c.partial)).toMatchObject({ project: { id: 'project-e00mocklegacy', name: 'legacy-research' } });
    // Names and regions come from GET /iam/v2/projects/{id}, not from configuration.
    const f = await as('user:default/viewer')(request(server).get('/api/nebius-estate/filters'));
    expect(f.body.projects).toEqual(expect.arrayContaining([{ id: 'project-e00mocklab', name: 'nip-lab' }]));
    expect(f.body.regions).toEqual(['eu-north1', 'eu-west1', 'uk-south1']);
    expect(inv.scope).toBe('4 projects');
    expect(inv.projects.map((p: any) => p.name)).toEqual(['nip-sandbox', 'nip-staging', 'nip-lab', 'legacy-research']);
  });

  it('serves quotas, capacity, platforms and GPU telemetry with their sources, scoped per caller', async () => {
    const { server, as } = await backend();
    const c = await as('user:default/admin')(request(server).get('/api/nebius-estate/capacity'));
    expect(c.body.quotas.value.length).toBeGreaterThan(3);
    expect(c.body.capacityAllowances.value).toEqual([expect.objectContaining({ projectId: 'project-e00mockstaging', limit: 16 })]);
    // Tenant-level reads answer (tenant viewer granted): no reservations in the tenant, capacity advice per region × platform × preset.
    expect(c.body.capacityBlockGroups.value).toEqual([]);
    expect(c.body.resourceAdvice.value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ region: 'us-central1', platform: 'gpu-b200-sxm', preset: '1gpu-20vcpu-224gb', gpus: 1, onDemand: expect.objectContaining({ level: 'medium', available: 11, limit: 32, dataState: 'fresh' }), reserved: { level: 'limit-reached', available: 0, limit: 0, dataState: 'fresh', effectiveAt: '2026-10-11T05:19:42Z' } }),
      ]),
    );
    const aliceCap = await as('user:default/alice')(request(server).get('/api/nebius-estate/capacity'));
    expect(aliceCap.body.resourceAdvice).toMatchObject({ value: null, unavailableReason: expect.stringMatching(/every project/) });
    expect(c.body.platforms.value.map((p: any) => p.name)).toContain('gpu-h100-sxm');
    // GPU series join node groups through mk8s_node_group_id.
    expect(c.body.nodeGroups.find((g: any) => g.name === 'nip-sandbox-inference-gpu').gpuUtil).toEqual({ meanPercent: 63.5, gpusReporting: 1 });
    expect(c.body.gpuTelemetry.value).toEqual(expect.arrayContaining([expect.objectContaining({ instanceName: 'nip-sandbox-inference-gpu-0', tempC: 54, source: 'Nebius Monitoring (service-provider GPU metrics)' })]));
    const alice = await as('user:default/alice')(request(server).get('/api/nebius-estate/capacity'));
    expect(new Set(alice.body.quotas.value.map((q: any) => q.projectId))).toEqual(new Set(['project-e00mocksandbox']));
    expect(alice.body.gpuTelemetry.value.map((g: any) => g.projectId)).toEqual(['project-e00mocksandbox']);
    const o = await as('user:default/admin')(request(server).get('/api/nebius-estate/overview'));
    // One window, one value: Overview and Capacity both show the latest sample of each reporting GPU (F1.1).
    expect(o.body.gpuUtilization.value.meanPercent).toBe(37.8);
    expect(c.body.utilization.value.meanPercent).toBe(o.body.gpuUtilization.value.meanPercent);
    expect(c.body.utilization.note).toBe(o.body.gpuUtilization.note);
    // Tenant allowances are enforced: near-limit is judged on them; limit 0 is blocked, not "near".
    // The tenant's non-GPU vCPU usage (absent, read 0) is below the 48 a project reports: the tenant row shows 48 against 0 (F1.11).
    expect(o.body.quotasNearLimit).toMatchObject({ value: [], coverage: { checked: 10, zeroLimit: 1, summary: '0 at ≥ 80 % · 10 tenant quotas with a limit (1 at limit 0)' } });
    // In use above the limit is an attention row of its own on the Overview (danger), not words in the near-limit row.
    expect(o.body.quotasAboveLimit.value.map((q: any) => `${q.name}@${q.region}:${q.usage}/${q.limit}`)).toEqual(['compute.instance.non-gpu.vcpu@eu-north1:48/0']);
    expect(c.body.quotas.value.find((q: any) => q.scope === 'tenant' && q.name === 'compute.instance.non-gpu.vcpu')).toMatchObject({ limit: 0, usage: 48, reportedUsage: 0 });
    // The same count as Capacity's "All tenant quotas" (F1.4).
    expect(o.body.quotasNearLimit.coverage.checked).toBe(c.body.quotas.value.filter((q: any) => q.scope === 'tenant').length);
    // Real project caps (with an id) against the tenant limit: a cap of 0, a cap below, a cap above (no effect).
    const caps = (m: any) => m.value.map((f: any) => `${f.kind}:${f.projectId}:${f.name}:${f.projectLimit}/${f.tenantLimit}`);
    expect(caps(o.body.allowanceCheck)).toEqual(['zero-cap:project-e00mockstaging:compute.gpucluster.count:0/5', 'caps-below:project-e00mocksandbox:vpc.allocation.count:13/1000', 'no-effect:project-e00mocksandbox:compute.instance.count:22/12']);
    expect(caps(c.body.allowanceCheck)).toEqual(caps(o.body.allowanceCheck));
    expect(aliceCap.body.allowanceCheck).toMatchObject({ value: null, unavailableReason: expect.stringMatching(/every project/) });
    // Project placeholders draw on the tenant quota: no limit of their own, the tenant's figures attached.
    expect(c.body.quotas.value.find((q: any) => q.scope === 'project' && q.name === 'compute.instance.gpu.h100' && q.projectId === 'project-e00mocksandbox')).toMatchObject({ allocation: 'inherits-tenant', limit: null, tenant: { limit: 32, usage: 2 } });
    expect(aliceCap.body.quotas.value.some((q: any) => q.tenant)).toBe(false);
    // The inference live root's CPU nodes need compute.instance.non-gpu.vcpu, whose tenant limit is 0.
    expect(o.body.plannedQuotaIssues.value).toEqual(
      expect.arrayContaining([expect.objectContaining({ plan: 'terraform/live/sandbox/inference', region: 'eu-north1', quota: 'compute.instance.non-gpu.vcpu', limit: 0, state: 'blocked' })]),
    );
    expect(aliceCap.body.quotas.value.every((q: any) => q.scope === 'project')).toBe(true); // tenant allowances: unrestricted callers only
    const aliceO = await as('user:default/alice')(request(server).get('/api/nebius-estate/overview'));
    expect(aliceO.body.plannedQuotaIssues).toMatchObject({ value: null, unavailableReason: expect.stringMatching(/every project/) });
    expect(o.body.maintenances.value).toEqual([expect.objectContaining({ affected: ['mk8scluster-e00mocktrn'] })]);
  });

  it('a stage filter no project carries says so once, and /filters offers only stages present', async () => {
    const { server, as } = await backend();
    const f = await as('user:default/admin')(request(server).get('/api/nebius-estate/filters'));
    expect(f.body.stages).toEqual(['sandbox', 'staging']);
    const o = await as('user:default/admin')(request(server).get('/api/nebius-estate/overview?stage=prod'));
    expect(o.body.emptyScope).toBe('No project in scope has stage=prod.');
    expect(o.body.projects).toMatchObject({ value: null, unavailableReason: 'No project in scope has stage=prod.' });
    expect(JSON.stringify(o.body)).not.toContain('read-only identity');
    const ok = await as('user:default/admin')(request(server).get('/api/nebius-estate/overview?stage=sandbox'));
    expect(ok.body.emptyScope).toBeUndefined();
    // The project by the name the filter shows, not its raw id (G1.17).
    const named = await as('user:default/admin')(request(server).get('/api/nebius-estate/overview?project=project-e00mocklab&stage=staging'));
    expect(named.body.emptyScope).toBe('No project in scope has stage=staging and project=nip-lab.');
  });

  it('lists every API capability with its state, and new resource kinds in the estate', async () => {
    const { server, as } = await backend();
    const i = await as('user:default/viewer')(request(server).get('/api/nebius-estate/integrations'));
    const st = Object.fromEntries(i.body.capabilities.map((c: any) => [c.id, c.state]));
    expect(st).toMatchObject({ 'quotas.allowances': 'ok', 'monitoring.gpu': 'ok', 'billing.calculator': 'ok', 'billing.calculator.contract': 'ok', 'capacity.resource-advice': 'ok', 'capacity.block-groups': 'ok', 'iam.projects.list': 'ok' });
    // The contract-price call reports what it answered with, like the list-price call (never "ok, never succeeded").
    expect(i.body.capabilities.find((c: any) => c.id === 'billing.calculator.contract')).toMatchObject({ state: 'ok', lastSuccess: expect.any(String), items: expect.any(Number), latencyMs: expect.any(Number) });
    expect(i.body.unconfiguredProjects).toEqual([{ id: 'project-e00mockdiscovered', name: 'research-unlisted', region: 'eu-west2' }]);
    const r = await as('user:default/viewer')(request(server).get('/api/nebius-estate/resources?type=ai-endpoint'));
    expect(r.body.items.map((x: any) => x.name)).toEqual(['nip-sandbox-vllm-endpoint']);
    expect(JSON.stringify(r.body)).not.toContain('never-copied-stub-value');
  });

  it('prices at live list price: running inventory, a provisioning preview and a footprint', async () => {
    const { server, as } = await backend();
    const run = await as('user:default/pricer')(request(server).get('/api/nebius-estate/runrate/live?project=project-e00mocksandbox'));
    // Contract prices answer on this account; the list price of the same lines comes with them.
    expect(run.body.value).toMatchObject({ offer: 'contract', currency: 'XTS', projectId: 'project-e00mocksandbox', contract: { attempted: true, available: true } });
    expect(run.body.value.listHourly).toEqual(run.body.value.hourly);
    expect(Number(run.body.value.hourly.amount)).toBeGreaterThan(0);
    const all = await as('user:default/pricer')(request(server).get('/api/nebius-estate/runrate/live'));
    const keys = all.body.value.lines.map((l: any) => l.key);
    expect(new Set(keys).size).toBe(keys.length); // unique across projects
    const pv = await as('user:default/pricer')(request(server).post('/api/nebius-estate/provisioning/live-price').send(sandboxInput));
    expect(pv.body.value.lines.map((l: any) => l.key)).toEqual(expect.arrayContaining(['vm:gpu']));
    const uk = await as('user:default/pricer')(request(server).post('/api/nebius-estate/provisioning/live-price').send({ ...sandboxInput, region: 'eu-west2' }));
    expect(uk.body).toMatchObject({ value: null, unavailableReason: expect.stringMatching(/No listed project is in eu-west2/) });
    const denied = await as('user:default/viewer')(request(server).get('/api/nebius-estate/runrate/live'));
    expect(denied.status).toBe(403);
  });

  it('provisioning live prices use the caller project for contract pricing', async () => {
    const { server, as } = await backend({ access: { roles: [
      { name: 'lab-pricing', principals: ['user:default/estimator'], projects: ['project-e00mocklab'], permissions: ['nebius.provisioning.preview', 'nebius.commercial.rate.read'] },
    ] } });
    const res = await as('user:default/estimator')(request(server).post('/api/nebius-estate/provisioning/live-price').send({ ...sandboxInput, region: 'uk-south1' }));
    expect(res.status).toBe(200);
    expect(res.body.value).toMatchObject({ projectId: 'project-e00mocklab', offer: 'contract' });
  });

  it.each(['project-e00mocklab', '*'])('provisioning pricing intersects the rate grant with preview scope %s', async primaryProject => {
    const { server, as } = await backend({ access: { roles: [
      { name: 'preview', principals: ['user:default/estimator'], projects: [primaryProject], permissions: ['nebius.provisioning.preview'] },
      { name: 'prices', principals: ['user:default/estimator'], projects: ['project-e00mocklab'], permissions: ['nebius.commercial.rate.read'] },
    ] } });
    const live = await as('user:default/estimator')(request(server).post('/api/nebius-estate/provisioning/live-price').send({ ...sandboxInput, region: 'uk-south1' }));
    expect(live.status).toBe(200);
    expect(live.body.value.projectId).toBe('project-e00mocklab');
    const estimate = await as('user:default/estimator')(request(server).post('/api/nebius-estate/provisioning/estimate').send({ ...sandboxInput, region: 'uk-south1' }));
    expect(estimate.status).toBe(200);
    expect(JSON.stringify(estimate.body)).toContain('nip-lab');
    expect(JSON.stringify(estimate.body)).not.toContain('nip-sandbox');
    const fetch = global.fetch as jest.Mock;
    fetch.mockClear();
    const denied = await as('user:default/estimator')(request(server).post('/api/nebius-estate/provisioning/estimate').send({ ...sandboxInput, region: 'eu-west1' }));
    expect(denied.status).toBe(409);
    expect(JSON.stringify(denied.body)).not.toContain('legacy-research');
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/billing/v1/calculator/'))).toEqual([]);
  });

  it('a provisioning live price states its capacity type on the estimate and on each VM line (F1.41)', async () => {
    const { server, as } = await backend();
    const pre = await as('user:default/pricer')(request(server).post('/api/nebius-estate/provisioning/live-price').send(sandboxInput));
    expect(pre.body.value.capacity).toEqual({ type: 'preemptible', text: 'preemptible GPU nodes, on-demand system nodes' });
    const vmLines = pre.body.value.lines.filter((l: any) => l.key.startsWith('vm:'));
    expect(vmLines.length).toBeGreaterThan(0);
    for (const l of vmLines) expect(l.description).toMatch(/ · (preemptible|on-demand)$/);
    expect(pre.body.value.lines.find((l: any) => l.key === 'vm:gpu')).toMatchObject({ capacityType: 'preemptible', description: expect.stringMatching(/ · preemptible$/) });
    const od = await as('user:default/pricer')(request(server).post('/api/nebius-estate/provisioning/live-price').send({ ...sandboxInput, capacityType: 'on-demand' }));
    expect(od.body.value.capacity).toEqual({ type: 'on-demand', text: 'on-demand' });
    expect(od.body.value.lines.find((l: any) => l.key === 'vm:gpu')).toMatchObject({ capacityType: 'on-demand', description: expect.stringMatching(/ · on-demand$/) });
  });

  it('the live run-rate prices managed PostgreSQL and names MLflow as running but unpriced', async () => {
    const { server, as } = await backend();
    const stg = await as('user:default/pricer')(request(server).get('/api/nebius-estate/runrate/live?project=project-e00mockstaging'));
    // The stub's staging cluster: cpu-d3 2vcpu-8gb, 96 GiB, 2 hosts = (0.02 + 0.016 + 0.0096) × 2 XTS/h.
    expect(stg.body.value.lines.find((l: any) => l.description.startsWith('Managed PostgreSQL'))).toMatchObject({
      description: 'Managed PostgreSQL cpu-d3 · 2vcpu-8gb, 96 GiB, 2 hosts',
      hourly: { amount: '0.0912', currency: 'XTS' },
    });
    const lab = await as('user:default/pricer')(request(server).get('/api/nebius-estate/runrate/live?project=project-e00mocklab'));
    expect(lab.body.value.unpriced).toContain('Managed MLflow nip-lab-tracking: the billing calculator does not price MLflow clusters (HTTP 500 for a MLflow create request, 2026-10-11); see the MLflow pricing page');
  });

  // Live 2026-10-12 (followup 23): a PostgreSQL cluster gone from Nebius stayed priced from an old read.
  it('the live run-rate never prices a resource the latest inventory sync did not read; the estate shows it as last seen', async () => {
    const { server, as } = await backend();
    const before = await as('user:default/pricer')(request(server).get('/api/nebius-estate/runrate/live?project=project-e00mockstaging'));
    expect(before.body.value.lines.some((l: any) => l.description.startsWith('Managed PostgreSQL'))).toBe(true);
    jest.setSystemTime(new Date(Date.now() + 5 * 60_000)); // past the manual-sync cooldown
    const real = (global.fetch as jest.Mock).getMockImplementation()!;
    (global.fetch as jest.Mock).mockImplementation(async (input: any, init?: any) =>
      String(input).includes('/msp/postgresql/v1alpha1/clusters') ? new Response('{"code":7,"message":"PermissionDenied"}', { status: 403, headers: { 'content-type': 'application/json' } }) : real(input, init),
    );
    try {
      expect((await as('user:default/admin')(request(server).post('/api/nebius-estate/integrations/nebius-inventory/sync'))).status).toBe(200);
    } finally {
      (global.fetch as jest.Mock).mockImplementation(real);
    }
    const after = await as('user:default/pricer')(request(server).get('/api/nebius-estate/runrate/live?project=project-e00mockstaging'));
    expect(after.body.value.lines.some((l: any) => l.description.startsWith('Managed PostgreSQL'))).toBe(false);
    expect(after.body.value.unpriced).toEqual(expect.arrayContaining([expect.stringMatching(/^Managed PostgreSQL nip-staging-metadata-db: last seen \d{4}-\d\d-\d\d \d\d:\d\d UTC, not in the latest inventory sync; not priced$/)]));
    const list = await as('user:default/viewer')(request(server).get('/api/nebius-estate/resources?type=postgresql-cluster'));
    expect(list.body.items[0]).toMatchObject({ name: 'nip-staging-metadata-db', lastSeen: expect.any(String) });
  });

  it('prices an empty footprint at 0 in the calculator currency without asking the calculator (F1.18)', async () => {
    const { server, as } = await backend();
    const calls = (global.fetch as jest.Mock).mock.calls.length;
    const empty = { nodeGroups: [{ name: 'gpu', role: 'gpu', platform: 'gpu-h100-sxm', preset: '1gpu-16vcpu-200gb', count: 0, bootDiskGib: 200 }] };
    const r = await as('user:default/pricer')(request(server).post('/api/nebius-estate/pricing/footprint').send({ footprint: empty, region: 'eu-north1' }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ value: null, emptyFootprint: { currency: 'XTS' }, unavailableReason: expect.stringMatching(/nothing to price/) });
    expect((global.fetch as jest.Mock).mock.calls.slice(calls).some(([u]: any[]) => String(u).includes('calculator'))).toBe(false);
  });

  it('says "nothing running" (not a setup gap) when the synced inventory has nothing to price in scope', async () => {
    const { server, as } = await backend();
    const r = await as('user:default/pricer')(request(server).get('/api/nebius-estate/runrate/live?stage=prod'));
    expect(r.body).toMatchObject({ value: null, nothingRunning: { currency: 'XTS' }, unavailableReason: expect.stringMatching(/No running VMs/) });
    // As of the inventory lists that answered "nothing running" (Wave 1 verification: the tile showed no time).
    expect(r.body.observedAt).toMatch(/^2026-10-10T/);
  });

  it('rate-limits calculator-backed routes per user: 429 with Retry-After after a burst', async () => {
    const { server, as } = await backend();
    const statuses: number[] = [];
    let retryAfter: string | undefined;
    for (let i = 0; i < 40; i++) {
      const r = await as('user:default/pricer')(request(server).get('/api/nebius-estate/runrate/live?project=project-e00mocksandbox'));
      statuses.push(r.status);
      if (r.status === 429) retryAfter = r.headers['retry-after'];
    }
    expect(statuses.filter(s => s === 200).length).toBe(30);
    expect(statuses.filter(s => s === 429).length).toBe(10);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    // The bucket is shared by every calculator-backed route of that user (per user: lib/limits.test.ts).
    expect((await as('user:default/pricer')(request(server).post('/api/nebius-estate/provisioning/live-price').send(sandboxInput))).status).toBe(429);
    // No imported book: the advisory estimate also uses the live calculator.
    const estimate = await as('user:default/pricer')(request(server).post('/api/nebius-estate/provisioning/estimate').send(sandboxInput));
    expect(estimate.status).toBe(429);
    expect(Number(estimate.headers['retry-after'])).toBeGreaterThan(0);
    // Fleet remains useful when its optional pricing cannot take another token.
    const fetch = global.fetch as jest.Mock;
    fetch.mockClear();
    const fleet = await as('user:default/pricer')(request(server).get('/api/nebius-estate/fleet'));
    expect(fleet.status).toBe(200);
    expect(fleet.body.rows.length).toBeGreaterThan(0);
    expect(fleet.body.idle.value.gpuHours).toBeGreaterThan(0);
    expect(fleet.body.idle.value.cost).toBeNull();
    expect(fleet.body.idle.value.unpriced).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringMatching(/Too many|limit|try again/i) }),
    ]));
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/billing/v1/calculator/'))).toEqual([]);
  });

  it('refuses a manual sync with 409 while another sync runs, and records connector health', async () => {
    const { server, as } = await backend();
    jest.setSystemTime(new Date(Date.now() + 5 * 60_000)); // past the manual-sync cooldown
    const real = (global.fetch as jest.Mock).getMockImplementation()!;
    (global.fetch as jest.Mock).mockImplementation(async (...args: any[]) => {
      await new Promise(r => setTimeout(r, 30));
      return real(...args);
    });
    try {
      const sync = (id: string) => as('user:default/admin')(request(server).post(`/api/nebius-estate/integrations/${id}/sync`));
      const first = sync('nebius-inventory').then(r => r); // supertest sends on then()
      await new Promise(r => setTimeout(r, 100));
      const second = await sync('nebius-monitoring');
      expect(second.status).toBe(409);
      expect(second.body.error.message).toMatch(/A sync is already running \(started \d+ s ago\)/);
      expect((await first).status).toBe(200);
    } finally {
      (global.fetch as jest.Mock).mockImplementation(real);
    }
    const i = await as('user:default/viewer')(request(server).get('/api/nebius-estate/integrations'));
    const inv = i.body.statuses.find((x: any) => x.id === 'nebius-inventory');
    expect(inv.health).toMatchObject({ runs24h: expect.any(Number), consecutiveFailures: 0, nextRunAt: expect.any(String) });
    expect(inv.health.recentRuns.length).toBeGreaterThan(0);
    expect(i.body.capabilities.find((c: any) => c.id === 'quotas.allowances')).toMatchObject({ connector: 'nebius-inventory', health: { successRate24h: 1 } });
    expect(inv.missingCoverage).toEqual(expect.arrayContaining([expect.stringMatching(/Spot pricing policies \(rejected\)/)]));
    // Only the inventory's own calls: monitoring and pricing calls belong to their connectors.
    const own = new Set(i.body.capabilities.filter((c: any) => c.connector === 'nebius-inventory').map((c: any) => c.title));
    expect(inv.missingCoverage.every((m: string) => own.has(m.replace(/ \([a-z -]+\)$/, '')))).toBe(true);
  });

  it('starts with nothing configured and says what to configure instead of showing zeros', async () => {
    const { server } = await startTestBackend({
      features: [
        testDatabase(),
        nebiusEstatePlugin,
        mockServices.rootConfig.factory({ data: testConfig({ nebius: { projectIdsEnv: 'NEBIUS_TEST_NO_PROJECTS', auth: {} } }) }),
        permissionsByUser({ 'user:default/admin': ALL }),
      ],
    });
    const o = await request(server).get('/api/nebius-estate/overview').set('Authorization', mockCredentials.user.header('user:default/admin'));
    expect(o.status).toBe(200);
    expect(o.body.gpuInventory.value).toBeNull();
    expect(o.body.gpuInventory.unavailableReason).toMatch(/not configured.*nebius-setup\.md/);
    const c = await request(server).get('/api/nebius-estate/capacity').set('Authorization', mockCredentials.user.header('user:default/admin'));
    expect(c.body.gpusPresent.value).toBeNull();
  });
});
