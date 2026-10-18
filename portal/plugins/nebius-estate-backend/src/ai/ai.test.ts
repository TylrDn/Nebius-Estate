import knexFactory from 'knex';
import { resolve } from 'path';
import { mockServices } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import { HttpClient, MethodNotAllowedError } from '../lib/http';
import { readEstateConfig } from '../lib/config';
import { migrate } from '../database';
import { HealthStore } from '../health/HealthStore';
import { InventoryService } from '../inventory/InventoryService';
import { RepoReader } from '../repo/RepoReader';
import { REPO_ROOT, TEST_DATA } from '../__testUtils__/testing';
import { AiServices } from './AiServices';
import { AiConfig, readAiConfig } from './config';
import { readWorkloadModelRefs } from './workloadModels';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { aiHandle, TF_KEY, HF_TOKEN } = require(resolve(TEST_DATA, 'aiStub.js'));

const TF = 'https://api.tokenfactory.nebius.com';
const HF = 'https://huggingface.co';

/** fetch backed by the e2e AI stub; `override` replaces answers per path. */
function aiFetch(override?: (url: URL, method: string) => Response | undefined) {
  const calls: { method: string; url: string; redirect?: string }[] = [];
  const fetch = jest.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    calls.push({ method, url: url.origin + url.pathname, redirect: init.redirect });
    const o = override?.(url, method);
    if (o) return o;
    const r = aiHandle(method, url, Object.fromEntries(new Headers(init.headers).entries()));
    if (!r) return new Response('{}', { status: 404 });
    return new Response(method === 'HEAD' ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
  return { fetch, calls };
}

const cfg = (o: Partial<AiConfig> = {}): AiConfig => ({
  tokenFactory: { apiKeyEnv: 'TF_KEY', endpoint: TF },
  huggingface: { tokenEnv: 'HF_TOKEN', endpoint: HF, maxModels: 20 },
  syncIntervalMinutes: 15,
  timeoutMs: 1000,
  ...o,
});
const refs = async () => [
  { repo: 'Qwen/Qwen2.5-1.5B-Instruct', usedBy: ['workloads/inference/overlays/qwen2.5-1.5b/kustomization.yaml'] },
  { repo: 'mock-org/gated-model', usedBy: ['recipes/serverless/endpoint.sh'] },
];

describe('HttpClient.head (access checks)', () => {
  it('is refused unless the client allows it, does not follow redirects and returns the status', async () => {
    const f = jest.fn(async () => new Response(null, { status: 307 }));
    await expect(new HttpClient({ allowedOrigins: [HF], timeoutMs: 100, fetch: f }).head(`${HF}/a/b/resolve/main/config.json`)).rejects.toBeInstanceOf(MethodNotAllowedError);
    const c = new HttpClient({ allowedOrigins: [HF], timeoutMs: 100, fetch: f, allowHead: true });
    await expect(c.head(`${HF}/a/b/resolve/main/config.json`)).resolves.toBe(307);
    expect((f.mock.calls[0] as any[])[1]).toMatchObject({ method: 'HEAD', redirect: 'manual' });
    const denied = new HttpClient({ allowedOrigins: [HF], timeoutMs: 100, fetch: jest.fn(async () => new Response(null, { status: 403 })), allowHead: true });
    await expect(denied.head(`${HF}/x`)).resolves.toBe(403);
    // GETs keep refusing redirects.
    await expect(c.request(`${HF}/api/x`)).rejects.toThrow();
  });
});

describe('AI services connectors', () => {
  const env = { TF_KEY, HF_TOKEN };

  it('are not configured, and never called, without the configuration block or the variables', async () => {
    const { fetch } = aiFetch();
    const none = new AiServices(cfg({ tokenFactory: undefined, huggingface: undefined }), { modelRefs: refs, fetch, env: {} });
    expect(none.definitions().map(d => [d.id, d.state])).toEqual([['token-factory', 'not-configured'], ['huggingface', 'not-configured']]);
    const r = await none.sync('t0');
    expect(fetch).not.toHaveBeenCalled();
    expect(r.statuses.map(s => s.state)).toEqual(['not-configured', 'not-configured']);
    expect(none.views().tokenFactory.hint).toMatch(/nebiusEstate\.ai\.tokenFactory\.apiKeyEnv/);
    const unset = new AiServices(cfg(), { modelRefs: refs, fetch, env: {} });
    await unset.sync('t0');
    expect(fetch).not.toHaveBeenCalled();
    expect(unset.views().tokenFactory.hint).toMatch(/Set TF_KEY/);
    // The workload models are still listed, explained.
    expect(unset.views().huggingface.models.map(m => m.note)).toEqual(['Not checked: no Hugging Face token configured.', 'Not checked: no Hugging Face token configured.']);
  });

  it('Token Factory: lists the models with the key; usage and balance are console-only', async () => {
    const { fetch, calls } = aiFetch();
    const ai = new AiServices(cfg({ huggingface: undefined }), { modelRefs: refs, fetch, env });
    const r = await ai.sync('2026-10-11T10:00:00.000Z');
    const tf = ai.views().tokenFactory;
    expect(tf).toMatchObject({ state: 'ok', keyConfigured: true, keyValid: true, lastSuccess: '2026-10-11T10:00:00.000Z', consoleUrl: 'https://tokenfactory.nebius.com' });
    expect(tf.models.map(m => m.id)).toEqual(['mock-org/mock-chat-70b', 'mock-org/mock-embed-8b', 'mock-org/mock-vision-12b']);
    expect(tf.usageNote).toMatch(/console only/);
    expect(r.capabilities.filter(c => c.connector === 'token-factory')).toEqual([expect.objectContaining({ id: 'tokenfactory.models', connector: 'token-factory', state: 'ok', items: 3, method: 'GET' })]);
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([`GET ${TF}/v1/models`]);
    expect(JSON.stringify(ai.views())).not.toContain(TF_KEY);
  });

  it('Token Factory: a refused key says what to do; an outage keeps the last models, marked stale', async () => {
    let mode: 'ok' | 'down' | 'refused' = 'ok';
    const { fetch } = aiFetch(() => (mode === 'down' ? new Response('', { status: 503 }) : mode === 'refused' ? new Response('{"detail":"Invalid API key"}', { status: 401 }) : undefined));
    const ai = new AiServices(cfg({ huggingface: undefined }), { modelRefs: refs, fetch, env, maxRetries: 0 });
    await ai.sync('t1');
    mode = 'down';
    const down = await ai.sync('t2');
    expect(ai.views().tokenFactory).toMatchObject({ state: 'unreachable', stale: true, keyValid: true, lastSuccess: 't1' });
    expect(ai.views().tokenFactory.models).toHaveLength(3);
    expect(down.statuses.find(x => x.id === 'token-factory')).toMatchObject({ id: 'token-factory', state: 'error' });
    mode = 'refused';
    await ai.sync('t3');
    expect(ai.views().tokenFactory).toMatchObject({ state: 'invalid-credential', keyValid: false });
    expect(ai.views().tokenFactory.hint).toMatch(/refused \(401\).*API keys/);
  });

  it('Hugging Face: token health and, per workload model, gated status and access (HEAD of one small file)', async () => {
    const { fetch, calls } = aiFetch();
    const ai = new AiServices(cfg({ tokenFactory: undefined }), { modelRefs: refs, fetch, env });
    const r = await ai.sync('t1');
    const hf = ai.views().huggingface;
    expect(hf).toMatchObject({ state: 'ok', tokenValid: true, account: { name: 'e2e-mock-user', type: 'user', tokenRole: 'fineGrained', canReadGatedRepos: true } });
    expect(hf.models).toEqual([
      expect.objectContaining({ repo: 'Qwen/Qwen2.5-1.5B-Instruct', gated: false, accessible: true, note: 'Open model; readable with this token.' }),
      expect.objectContaining({ repo: 'mock-org/gated-model', gated: 'manual', accessible: false, note: expect.stringMatching(/request it on https:\/\/huggingface\.co\/mock-org\/gated-model/) }),
    ]);
    expect(hf.hint).toMatch(/1 model\(s\) are gated/);
    expect(r.statuses.find(x => x.id === 'huggingface')!.missingCoverage).toEqual(['No access to gated: mock-org/gated-model']);
    // Never a download: only GETs of the APIs and HEADs of config.json.
    expect(calls.every(c => c.method === 'GET' ? /\/api\//.test(c.url) : c.method === 'HEAD' && c.url.endsWith('/resolve/main/config.json'))).toBe(true);
    expect(JSON.stringify(ai.views())).not.toContain(HF_TOKEN);
  });

  it('Hugging Face: a refused token is reported with the fix', async () => {
    const ai = new AiServices(cfg({ tokenFactory: undefined }), { modelRefs: refs, fetch: aiFetch().fetch, env: { HF_TOKEN: 'wrong' } });
    await ai.sync('t1');
    expect(ai.views().huggingface).toMatchObject({ state: 'invalid-credential', tokenValid: false });
    expect(ai.views().huggingface.hint).toMatch(/Access Tokens/);
  });

  it('runs on the inventory sync loop: statuses on Integrations, runs recorded in the HealthStore, Sync now per id', async () => {
    const db = knexFactory({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    await migrate(db);
    const estate = readEstateConfig(new ConfigReader({ backend: { listen: { host: '127.0.0.1' } }, nebiusEstate: { repoRoot: REPO_ROOT, access: { roles: [{ name: 'x', principals: ['user:default/x'], permissions: ['*'] }] } } }));
    const inventory = new InventoryService(estate, mockServices.logger.mock());
    const health = new HealthStore(db);
    inventory.useHealthStore(health);
    const { fetch } = aiFetch();
    inventory.useExtension(new AiServices(cfg(), { modelRefs: refs, fetch, env }));
    await inventory.start();
    await inventory.ready();
    const snap = inventory.snapshot();
    expect(snap.statuses.filter(s => s.id === 'token-factory' || s.id === 'huggingface').map(s => s.state)).toEqual(['ok', 'ok']);
    expect(snap.capabilities.map(c => c.id)).toEqual(expect.arrayContaining(['tokenfactory.models', 'huggingface.whoami', 'huggingface.models']));
    const runs = await health.runs('connector');
    expect(runs.get('token-factory')?.[0]).toMatchObject({ ok: true });
    expect(runs.get('huggingface')?.[0]).toMatchObject({ ok: true });
    fetch.mockClear();
    await inventory.syncAll('token-factory');
    expect(fetch.mock.calls.map(c => new URL(c[0] as string).pathname)).toEqual(['/v1/models']);
    await db.destroy();
  });
});

describe('one AI-services extension, two connectors with their own health (G1.7)', () => {
  const env = { TF_KEY, HF_TOKEN };
  const service = async (ai: AiServices) => {
    const db = knexFactory({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    await migrate(db);
    const estate = readEstateConfig(new ConfigReader({ backend: { listen: { host: '127.0.0.1' } }, nebiusEstate: { repoRoot: REPO_ROOT, access: { roles: [{ name: 'x', principals: ['user:default/x'], permissions: ['*'] }] } } }));
    const inventory = new InventoryService(estate, mockServices.logger.mock());
    const health = new HealthStore(db);
    inventory.useHealthStore(health);
    inventory.useExtension(ai);
    await inventory.start();
    await inventory.ready();
    return { inventory, health, db };
  };

  it('times each connector by its own calls, not by the whole extension', async () => {
    const slow = aiFetch();
    const fetch = jest.fn(async (input: string, init?: RequestInit) => {
      if (new URL(input).pathname === '/v1/models') await new Promise(r => setTimeout(r, 400));
      return slow.fetch(input, init);
    });
    const { health, db } = await service(new AiServices(cfg(), { modelRefs: refs, fetch: fetch as any, env }));
    const runs = await health.runs('connector');
    const tf = runs.get('token-factory')![0].durationMs;
    const hf = runs.get('huggingface')![0].durationMs;
    expect(tf).toBeGreaterThanOrEqual(350);
    expect(hf).toBeLessThan(300);
    await db.destroy();
  });

  it('a connector that throws marks only itself as errored', async () => {
    const ai = new AiServices(cfg(), { modelRefs: refs, fetch: aiFetch().fetch, env });
    jest.spyOn(ai as any, 'syncHuggingFace').mockRejectedValue(new Error('boom'));
    const { inventory, db } = await service(ai);
    const st = Object.fromEntries(inventory.snapshot().statuses.filter(s => s.id === 'token-factory' || s.id === 'huggingface').map(s => [s.id, s.state]));
    expect(st).toEqual({ 'token-factory': 'ok', huggingface: 'error' });
    await db.destroy();
  });
});

describe('AI configuration and workload models', () => {
  it('reads variable names, and accepts a loopback endpoint only on a loopback-only backend', () => {
    const c = readAiConfig(new ConfigReader({ backend: { listen: { host: '127.0.0.1' } }, nebiusEstate: { ai: { tokenFactory: { apiKeyEnv: 'NEBIUS_API_KEY', endpoint: 'http://127.0.0.1:7199' }, huggingface: { tokenEnv: 'HF_TOKEN' } } } }));
    expect(c.tokenFactory).toEqual({ apiKeyEnv: 'NEBIUS_API_KEY', endpoint: 'http://127.0.0.1:7199' });
    expect(c.huggingface).toMatchObject({ tokenEnv: 'HF_TOKEN', endpoint: HF, maxModels: 20 });
    expect(() => readAiConfig(new ConfigReader({ backend: { listen: { host: '0.0.0.0' } }, nebiusEstate: { ai: { tokenFactory: { apiKeyEnv: 'NEBIUS_API_KEY', endpoint: 'http://127.0.0.1:7199' } } } }))).toThrow(/loopback/);
    expect(() => readAiConfig(new ConfigReader({ nebiusEstate: { ai: { huggingface: { tokenEnv: 'hf token' } } } }))).toThrow(/environment variable name/);
    expect(readAiConfig(new ConfigReader({})).tokenFactory).toBeUndefined();
  });

  it('finds the models the repository workloads pull', async () => {
    const found = await readWorkloadModelRefs(new RepoReader(REPO_ROOT));
    expect(found.map(f => f.repo)).toEqual(expect.arrayContaining(['Qwen/Qwen2.5-1.5B-Instruct', 'Qwen/Qwen2.5-7B-Instruct']));
    expect(found.find(f => f.repo === 'Qwen/Qwen2.5-1.5B-Instruct')!.usedBy).toEqual(expect.arrayContaining(['recipes/serverless/endpoint.sh', 'workloads/inference/overlays/qwen2.5-1.5b/kustomization.yaml']));
    // G3.17: the prod overlay pulls the 7B model through `resources: - ../qwen2.5-7b`.
    expect(found.find(f => f.repo === 'Qwen/Qwen2.5-7B-Instruct')!.usedBy).toContain('workloads/inference/overlays/qwen2.5-7b-prod/kustomization.yaml');
  });
});
