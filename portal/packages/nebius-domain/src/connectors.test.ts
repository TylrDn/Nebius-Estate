import type { CapabilityStatus, ConnectorStatus } from './api';
import { connectorFilterState, connectorHealthLine, connectorState, lastImportNote, errorReason, errorSummary, gapCounts, gapText, inventoryErrorLine, plainError, refusedByProject, tenantAllowancesGap } from './connectors';

const status = (over: Partial<ConnectorStatus>): ConnectorStatus => ({
  id: 'x',
  title: 'X',
  state: 'ok',
  scope: '4 projects',
  permissions: 'viewer',
  services: [],
  staleAfterMinutes: 45,
  missingCoverage: [],
  setup: 'docs/portal/nebius-setup.md',
  ...over,
});

const RAW =
  'project-e00mocklegacy vpc.networks: GET http://127.0.0.1:7199/vpc/v1/networks → 403: {"code":7,"message":"PermissionDenied"}; project-e00mocklegacy vpc.subnets: GET http://127.0.0.1:7199/vpc/v1/subnets → 403: {"code":7,"message":"PermissionDenied"}';

describe('a connector whose sync ran but some calls were refused (F1.14)', () => {
  const inventory = status({
    id: 'nebius-inventory',
    state: 'permission-denied',
    lastSuccess: '2026-10-12T05:51:00Z',
    error: RAW,
    missingCoverage: ['Networks (permission denied)', 'Subnets (permission denied)', 'Object Storage buckets (permission denied)', 'DNS zones (not found)', 'Tunnels (schema drift)'],
  });

  it('is partial, with the number of refused calls, not "permission denied" beside a 100 % success rate', () => {
    expect(connectorState(inventory)).toEqual({ state: 'partial', label: 'partial (3 calls refused, 1 failing or rejected, 1 waiting for data)', refused: 3, otherGaps: 2, gaps: { refused: 3, failing: 1, waiting: 1 } });
  });

  it('a connector refused outright, or one without refusals, keeps its own state', () => {
    expect(connectorState({ ...inventory, lastSuccess: undefined })).toMatchObject({ state: 'permission-denied', label: 'permission denied', refused: 3, otherGaps: 2 });
    expect(connectorState(status({ state: 'waiting' }))).toMatchObject({ state: 'waiting', label: 'waiting', refused: 0, otherGaps: 0 });
    // No coverage list: the refusals are counted from the error, one per "; "-separated call.
    expect(connectorState({ ...inventory, missingCoverage: [] })).toMatchObject({ state: 'partial', label: 'partial (2 calls refused)' });
  });

  it('the card, the table and the Overview line say the same words (W1F.S3)', () => {
    const label = connectorState(inventory).label;
    const line = connectorHealthLine([inventory, status({ state: 'ok' })]);
    expect(line.segments[1].text).toBe(`1 ${label}`);
    expect(line.segments[1].state).toBe(connectorFilterState(inventory));
    expect(gapText(gapCounts(inventory.missingCoverage))).toBe('3 calls refused, 1 failing or rejected, 1 waiting for data');
    expect(gapText({ refused: 0, failing: 0, waiting: 2 })).toBe('2 calls waiting for data');
    expect(gapText({ refused: 1, failing: 0, waiting: 0 })).toBe('1 call refused');
  });

  it('one line for the Overview: each state counted once, under its own name, as the filter lists it (#7, W1-P29)', () => {
    const list = [inventory, status({ state: 'ok' }), status({ state: 'ok' }), status({ state: 'waiting' }), status({ state: 'waiting' }), status({ state: 'not-needed' }), status({ state: 'optional' })];
    const line = connectorHealthLine(list);
    // A not-needed connector is not counted as ok (it read "3 of 6 connectors ok (1 not needed)" while the table showed 2 ok).
    expect(line).toEqual({
      text: '7 connectors: 2 ok · 1 partial (3 calls refused, 1 failing or rejected, 1 waiting for data) · 2 waiting · 1 optional · 1 not needed',
      head: '7 connectors:',
      tone: 'warn',
      attention: 1,
      segments: [
        { text: '2 ok', state: 'ok', count: 2 },
        { text: '1 partial (3 calls refused, 1 failing or rejected, 1 waiting for data)', state: 'partial', count: 1, tone: 'warn' },
        { text: '2 waiting', state: 'waiting', count: 2 },
        { text: '1 optional', state: 'optional', count: 1, notApplicable: true },
        { text: '1 not needed', state: 'not-needed', count: 1, notApplicable: true },
      ],
    });
    // Every segment counts exactly the connectors its filter lists.
    for (const seg of line.segments) expect(list.filter(s => connectorFilterState(s) === seg.state)).toHaveLength(seg.count);
    expect(line.segments.reduce((a, x) => a + x.count, 0)).toBe(list.length);
    expect(connectorHealthLine([status({ state: 'ok' }), status({ state: 'error', error: 'boom' })])).toMatchObject({ text: '2 connectors: 1 ok · 1 error', tone: 'danger', attention: 1 });
    expect(connectorHealthLine([status({ state: 'ok' })])).toMatchObject({ text: '1 connector: 1 ok', tone: 'ok', attention: 0 });
    expect(connectorHealthLine([status({ state: 'ok' }), status({ state: 'not-needed' })])).toMatchObject({ text: '2 connectors: 1 ok · 1 not needed', tone: 'ok' });
  });
});

describe('API errors in plain words, never raw JSON (F1.14)', () => {
  it('keeps the method, path, status and the message; drops the host and the JSON', () => {
    expect(plainError('GET http://127.0.0.1:7199/vpc/v1/networks → 403: {"code":7,"message":"PermissionDenied"}')).toBe('GET /vpc/v1/networks → 403 PermissionDenied');
    expect(plainError('GET https://api.example.test/dns/v1/zones → 404: {"code":5,"message":"service not available for this project"}')).toBe(
      'GET /dns/v1/zones → 404 service not available for this project',
    );
    expect(plainError(RAW)).toBe('project-e00mocklegacy vpc.networks: GET /vpc/v1/networks → 403 PermissionDenied; project-e00mocklegacy vpc.subnets: GET /vpc/v1/subnets → 403 PermissionDenied');
  });

  it('a call that failed after retries reads with the project name and the call title, without the host or ids (W1F.N3)', () => {
    const raw = 'https://api.example.test/registry/v1/registries → 503 after 4 attempts';
    const line = inventoryErrorLine({ project: 'project-e00mocklegacy', service: 'registry.registries', message: raw }, 'Container registries');
    expect(line).toBe('Container registries in project-e00mocklegacy: https://api.example.test/registry/v1/registries → 503 after 4 attempts');
    const projects = [{ id: 'project-e00mocklegacy', name: 'legacy-research' }, { id: 'project-e00mocklab' }];
    expect(plainError(line, projects)).toBe('Container registries in legacy-research: /registry/v1/registries → 503 after 4 attempts');
    expect(plainError(line, projects)).not.toMatch(/https?:|project-e00|registry\.registries/);
    // A project without a known name, or masked for a scoped caller, keeps what the backend sent.
    expect(plainError('Networks in project-e00mocklab: x; Disks in project-…: y', projects)).toBe('Networks in project-e00mocklab: x; Disks in project-…: y');
    // No title known: the catalog id stands in, so nothing is lost.
    expect(inventoryErrorLine({ project: 'project-e00mocklegacy', service: 'registry.registries', message: 'x' })).toBe('registry.registries in project-e00mocklegacy: x');
  });

  it('a cut-off or message-less body still loses its JSON; plain text is left alone', () => {
    expect(plainError('GET http://h/p → 404: {"code":5,"message":"project/bu')).toBe('GET /p → 404 project/bu…');
    expect(plainError('GET http://h/p → 400: {"code":3}')).toBe('GET /p → 400');
    expect(plainError('timeout after 10 s')).toBe('timeout after 10 s');
    // gRPC-gateway bodies with a nested details array, in either key order, leave no JSON behind.
    expect(plainError('GET http://h/vpc/v1/networks → 403: {"code":7,"message":"PermissionDenied","details":[{"@type":"x","reason":"r"}]}; next')).toBe('GET /vpc/v1/networks → 403 PermissionDenied; next');
    expect(plainError('GET http://h/p → 403: {"code":7,"details":[{"@type":"x","meta":{"a":"b"}}],"message":"Denied"}')).toBe('GET /p → 403 Denied');
  });
});

describe('refused calls by project', () => {
  const cap = (title: string, state: CapabilityStatus['state'], perProject?: CapabilityStatus['perProject']): CapabilityStatus => ({
    id: title,
    title,
    service: 'vpc',
    connector: 'nebius-inventory',
    scope: 'project',
    path: '/p',
    method: 'GET',
    state,
    perProject,
  });

  it('names each project with the calls it refused, from the per-project outcomes', () => {
    const legacy = { id: 'project-e00mocklegacy', name: 'legacy-research', state: 'permission-denied' as const, error: 'x' };
    const sandbox = { id: 'project-e00mocksandbox', name: 'nip-sandbox', state: 'ok' as const };
    expect(
      refusedByProject([
        cap('Networks', 'permission-denied', [legacy, sandbox]),
        cap('Subnets', 'permission-denied', [legacy]),
        cap('DNS zones', 'not-found', [{ ...legacy, state: 'not-found' }]),
        cap('Tenant list', 'permission-denied'),
      ]),
    ).toEqual([
      { project: 'legacy-research', calls: ['Networks', 'Subnets'] },
      { project: 'every project', calls: ['Tenant list'] },
    ]);
  });
});

describe('a connector whose calls did not all answer (F1.30, F1.31)', () => {
  const failed = 'https://api.nebius.cloud/compute/v1/instances: fetch failed (ECONNRESET: read ECONNRESET) after 9 attempts in 28 s';

  it('reads "degraded (16 of 36 calls failed)", on the card and in the Overview line', () => {
    const inv = status({ id: 'nebius-inventory', state: 'degraded', lastSuccess: '2026-10-12T05:51:00Z', calls: { total: 36, failed: 16 }, error: failed });
    expect(connectorState(inv)).toMatchObject({ state: 'degraded', label: 'degraded (16 of 36 calls failed)', refused: 0, otherGaps: 0, failedCalls: { failed: 16, total: 36 } });
    expect(connectorHealthLine([inv, status({ state: 'ok' })])).toMatchObject({ text: '2 connectors: 1 ok · 1 degraded (16 of 36 calls failed)', tone: 'warn' });
    // Degraded from its 24 h success rate only (no failed call now): the plain state.
    expect(connectorState(status({ state: 'degraded' })).label).toBe('degraded');
  });

  it('a failed call reads by its HTTP status, else by its cause in full (never cut to "fetch fa")', () => {
    expect(errorReason(failed)).toBe('fetch failed (ECONNRESET: read ECONNRESET) after 9 attempts in 28 s');
    expect(errorReason('GET https://api.nebius.cloud/vpc/v1/networks → 403: {"code":7}')).toBe('403');
    expect(errorReason('https://api.nebius.cloud/x → 503 after 4 attempts')).toBe('503');
    expect(errorReason('certificate has expired')).toBe('certificate has expired');
  });

  it('a network error loses its host like an API error does, and keeps its cause', () => {
    expect(plainError(`project-e00mocklab compute.instances: ${failed}`)).toBe('project-e00mocklab compute.instances: /compute/v1/instances: fetch failed (ECONNRESET: read ECONNRESET) after 9 attempts in 28 s');
  });

  it('a summary of several errors is the first in full and a count, never a cut through the cause', () => {
    const many = Array.from({ length: 4 }, (_, i) => `project-e00mock${'abcdefghijklmnop'.slice(i)} compute.disks: ${failed}`).join('; ');
    expect(errorSummary(many)).toBe(`project-e00mockabcdefghijklmnop compute.disks: /compute/v1/instances: fetch failed (ECONNRESET: read ECONNRESET) after 9 attempts in 28 s (+3 more)`);
    expect(errorSummary('timeout after 10 s')).toBe('timeout after 10 s');
    // The message keeps five; "+N more" counts every error it stands for.
    expect(errorSummary(many, 20)).toMatch(/ \(\+19 more\)$/);
    expect(errorSummary(many, 2)).toMatch(/ \(\+3 more\)$/);
  });
});

describe('why no tenant quota allowances were read (F1.33)', () => {
  it('names the real cause: no tenant id is not a missing role', () => {
    expect(tenantAllowancesGap({ state: 'not-configured', hint: 'No tenant id: set nebiusEstate.nebius.tenantId, or read one project first.' })).toBe(
      'the tenant id is not known: set NEBIUS_TENANT_ID, or it is read from a project once a project read succeeds',
    );
    expect(tenantAllowancesGap(undefined)).toMatch(/^the tenant id is not known/);
    expect(tenantAllowancesGap({ state: 'permission-denied' })).toBe('the portal identity needs a tenant-level read role');
    expect(tenantAllowancesGap({ state: 'unreachable' })).toBe('the tenant allowance list did not answer at the last sync');
    expect(tenantAllowancesGap({ state: 'ok' })).toBe('the tenant allowance list is empty');
    expect(tenantAllowancesGap({ state: 'schema-drift' })).toBe('the tenant allowance list answered in a shape the portal does not read (schema drift)');
    expect(tenantAllowancesGap({ state: 'not-found' })).toBe('the tenant allowance list answered "not found"');
  });
});

describe('the billing export pull says its last import as information, by file name and month, without ids (#5, #6)', () => {
  it('names the file and its month and the rows, never the path with the billing account or customer ids', () => {
    const key = 'focus/billing-account-e00mockba/customer-e00mockcu/2026-10/focus-export-2026-10-06.csv.gz';
    expect(lastImportNote([{ key, rows: 300 }])).toBe('Last import: focus-export-2026-10-06.csv.gz (2026-10), 300 rows');
    expect(lastImportNote([{ key, rows: 300 }])).not.toMatch(/e00mock|Not covered/);
    expect(lastImportNote([{ key: 'export.csv', rows: 1 }])).toBe('Last import: export.csv, 1 row');
    expect(lastImportNote([{ key, rows: 300 }, { key: 'p/2026-09/b.csv', rows: 10 }, { key: 'p/2026-09/c.csv', rows: 5 }])).toBe(
      'Last import: focus-export-2026-10-06.csv.gz (2026-10), 300 rows; 2 more files (15 rows)',
    );
    expect(lastImportNote([])).toBeUndefined();
    // An import deleted since: named as removed, never as an import of 0 rows.
    expect(lastImportNote([{ key, removed: true }])).toBe('Last import: focus-export-2026-10-06.csv.gz (2026-10), since removed');
  });
});
