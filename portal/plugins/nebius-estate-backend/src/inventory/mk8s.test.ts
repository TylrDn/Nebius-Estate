import { mockServices } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import { resolve } from 'path';
import { readEstateConfig } from '../lib/config';
import { NEBIUS_API, NEBIUS_MONITORING } from './endpoints';
import { TEST_DATA, testConfig } from '../__testUtils__/testing';
import { InventoryService } from './InventoryService';
import { caFingerprint, discoveredCluster, mk8sOrigin } from './mk8s';
import { mergeGpus } from './monitoring';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const stub: { handle: (m: string, u: string, h: Record<string, string>, b?: unknown) => { status: number; body?: unknown }; estate: any } = require(resolve(TEST_DATA, 'stubApi.js'));

const toResponse = (r: { status: number; body?: unknown }) => new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });

describe('MK8s endpoint allowlist (derived from discovery only)', () => {
  it('accepts https on 443 under *.mk8s.<region>.nebius.cloud and refuses everything else', () => {
    expect(mk8sOrigin('https://pu.mk8scluster-e00mockinf.mk8s.eu-north1.nebius.cloud:443', 'eu-north1')).toEqual({ origin: 'https://pu.mk8scluster-e00mockinf.mk8s.eu-north1.nebius.cloud' });
    expect(mk8sOrigin('https://pr.mk8scluster-e00mockinf.mk8s.eu-north1.nebius.cloud')).toHaveProperty('origin');
    const refused = (u: string | undefined, region?: string) => (mk8sOrigin(u, region) as { refused?: string }).refused;
    expect(refused('http://pu.mk8scluster-x.mk8s.eu-north1.nebius.cloud')).toMatch(/not https/);
    expect(refused('https://pu.mk8scluster-x.mk8s.eu-north1.nebius.cloud:6443')).toMatch(/port 6443/);
    expect(refused('https://evil.example.com')).toMatch(/not under \*\.mk8s/);
    expect(refused('https://mk8s.eu-north1.nebius.cloud.evil.example.com')).toMatch(/not under/);
    expect(refused('https://pu.mk8scluster-x.mk8s.us-central1.nebius.cloud', 'eu-north1')).toMatch(/region eu-north1/);
    expect(refused('https://user:pw@pu.mk8scluster-x.mk8s.eu-north1.nebius.cloud')).toMatch(/credentials/);
    expect(refused('https://pu.mk8scluster-x.mk8s.eu-north1.nebius.cloud/api')).toMatch(/path/);
    expect(refused(undefined)).toMatch(/no endpoint/);
  });

  it('reads endpoints and CA from the documented cluster shape', () => {
    const item = stub.estate.lists['/mk8s/v1/clusters']['project-e00mocksandbox'][0];
    expect(discoveredCluster(item, 'project-e00mocksandbox', 'eu-north1')).toMatchObject({
      id: 'mk8scluster-e00mockinf', state: 'RUNNING', publicEndpoint: 'https://pu.mk8scluster-e00mockinf.mk8s.eu-north1.nebius.cloud:443', caPem: expect.stringContaining('BEGIN CERTIFICATE'),
    });
  });
});

describe('self-healing Kubernetes connection to discovered MK8s clusters', () => {
  const original = JSON.stringify({ clusters: stub.estate.lists['/mk8s/v1/clusters'], kube: stub.estate.kube });
  afterEach(() => {
    const o = JSON.parse(original);
    stub.estate.lists['/mk8s/v1/clusters'] = o.clusters;
    stub.estate.kube = o.kube;
  });

  it('connects with the API-reported endpoint, CA and the Nebius token; reconnects on rotation; drops a deleted cluster after N syncs', async () => {
    const nebiusCalls: string[] = [];
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== NEBIUS_API && url.origin !== NEBIUS_MONITORING) throw new Error(`unexpected outbound call to ${url.origin}`);
      nebiusCalls.push(url.pathname);
      return toResponse(stub.handle(init?.method ?? 'GET', url.pathname + url.search, Object.fromEntries(new Headers(init?.headers).entries()), init?.body ? JSON.parse(String(init.body)) : undefined));
    });
    // The TLS client of a discovered cluster: records the CA it was pinned to and the host it called.
    const kubeCalls: { host: string; ca: string; auth: string | null }[] = [];
    try {
      const base = (testConfig() as any).nebiusEstate.nebius;
      const cfg = readEstateConfig(new ConfigReader(testConfig({ nebius: { ...base, mk8s: { forgetAfterSyncs: 2 } } }) as any));
      const svc = new InventoryService(cfg, mockServices.logger.mock());
      svc.useKubeFetch(ca => async (input, init) => {
        const url = new URL(String(input));
        const id = /^(?:pu|pu2)\.(mk8scluster-[a-z0-9]+)\.mk8s\./.exec(url.hostname)?.[1];
        kubeCalls.push({ host: url.hostname, ca, auth: new Headers(init.headers).get('authorization') });
        return toResponse(stub.handle(init.method ?? 'GET', `/k8s/${id}${url.pathname}${url.search}`, { authorization: new Headers(init.headers).get('authorization') ?? '' }));
      });
      await svc.start();
      await svc.ready();
      const st = (id: string) => svc.snapshot().statuses.find(s => s.id === id);
      expect(st('mk8s:mk8scluster-e00mockinf')).toMatchObject({ state: 'ok', scope: 'cluster nip-sandbox-inference · eu-north1' });
      expect(st('mk8s:mk8scluster-e00mocksop')).toMatchObject({ state: 'waiting' });
      expect(st('kubernetes')).toBeUndefined();
      expect(kubeCalls.every(c => c.auth === 'Bearer test-token' && c.ca.includes('BEGIN CERTIFICATE'))).toBe(true);
      expect(kubeCalls.some(c => c.host.endsWith('mk8scluster-e00mocksop.mk8s.eu-north1.nebius.cloud'))).toBe(false); // PROVISIONING: not called
      const inf = svc.snapshot().kube.find(k => k.mk8sClusterId === 'mk8scluster-e00mockinf')!;
      expect(inf.workloads.map(w => w.name)).toEqual(['vllm-qwen']);
      // Node labels tie the VM to its MK8s node group.
      expect(svc.snapshot().resources.find(r => r.providerId === 'computeinstance-e00mockinfgpu0')!.refs).toEqual(expect.arrayContaining([{ relation: 'member-of', target: 'mk8snodegroup-e00mockinfgpu' }]));

      // Rotation: new endpoint host and a new CA → the next sync pins the new CA and says so.
      const cluster = stub.estate.lists['/mk8s/v1/clusters']['project-e00mocksandbox'][0];
      cluster.status.controlPlane.endpoints.publicEndpoint = 'https://pu2.mk8scluster-e00mockinf.mk8s.eu-north1.nebius.cloud:443';
      cluster.status.controlPlane.auth.clusterCaCertificate = '-----BEGIN CERTIFICATE-----\nZTAwbW9jay1yb3RhdGVk\n-----END CERTIFICATE-----\n';
      kubeCalls.length = 0;
      await svc.syncAll();
      expect(st('mk8s:mk8scluster-e00mockinf')).toMatchObject({ state: 'ok', notes: [expect.stringMatching(/endpoint changed to https:\/\/pu2\./), expect.stringMatching(/CA certificate changed/)] });
      expect(kubeCalls.filter(c => c.host.includes('e00mockinf')).every(c => c.host.startsWith('pu2.') && caFingerprint(c.ca) === caFingerprint(cluster.status.controlPlane.auth.clusterCaCertificate))).toBe(true);

      // Torn down and recreated under a new id: the new cluster connects; the old one is stale, then dropped.
      const recreated = JSON.parse(JSON.stringify(cluster));
      recreated.metadata.id = 'mk8scluster-e00mockinf2';
      recreated.status.controlPlane.endpoints.publicEndpoint = 'https://pu.mk8scluster-e00mockinf2.mk8s.eu-north1.nebius.cloud:443';
      stub.estate.lists['/mk8s/v1/clusters']['project-e00mocksandbox'] = [recreated];
      stub.estate.kube['mk8scluster-e00mockinf2'] = stub.estate.kube['mk8scluster-e00mockinf'];
      await svc.syncAll();
      expect(st('mk8s:mk8scluster-e00mockinf2')).toMatchObject({ state: 'ok' });
      // Retired at once: not an error (no red state, no ConnectorFailing), named and dated for a reader.
      const retired = st('mk8s:mk8scluster-e00mockinf')!;
      expect(retired).toMatchObject({ state: 'disabled', error: undefined, notes: [expect.stringMatching(/^Retired: cluster nip-sandbox-inference no longer exists in project \S+ \(last seen \d{4}-\d\d-\d\d \d\d:\d\d UTC\); its last data is kept, marked stale, for 1 more sync\.$/)] });
      expect(retired.notes![0]).not.toMatch(/project-e00|T\d\d:/);
      expect(svc.snapshot().kube.find(k => k.mk8sClusterId === 'mk8scluster-e00mockinf')).toMatchObject({ stale: true });
      await svc.syncAll();
      expect(st('mk8s:mk8scluster-e00mockinf')).toBeUndefined();
      expect(svc.snapshot().kube.find(k => k.mk8sClusterId === 'mk8scluster-e00mockinf')).toBeUndefined();
      expect(svc.snapshot().capabilities.find(c => c.id === 'k8s.cluster:mk8scluster-e00mockinf')).toBeUndefined();

      // An endpoint outside the derived allowlist is refused without a call.
      recreated.status.controlPlane.endpoints.publicEndpoint = 'https://evil.example.com';
      kubeCalls.length = 0;
      await svc.syncAll();
      expect(st('mk8s:mk8scluster-e00mockinf2')).toMatchObject({ state: 'error', error: expect.stringMatching(/public endpoint refused: evil\.example\.com is not under/) });
      expect(kubeCalls.some(c => c.host === 'evil.example.com')).toBe(false);

      // Every cluster gone: the neutral placeholder returns once the last one is forgotten.
      stub.estate.lists['/mk8s/v1/clusters'] = {};
      await svc.syncAll();
      await svc.syncAll();
      expect(st('kubernetes')).toMatchObject({ state: 'optional' });
      expect(nebiusCalls.every(p => !p.includes('/k8s/'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('uses the private endpoint when configured, and never connects without a CA', async () => {
    const cluster = stub.estate.lists['/mk8s/v1/clusters']['project-e00mocksandbox'][0];
    cluster.status.controlPlane.endpoints.privateEndpoint = 'https://pr.mk8scluster-e00mockinf.mk8s.eu-north1.nebius.cloud';
    const staging = stub.estate.lists['/mk8s/v1/clusters']['project-e00mockstaging'][0];
    staging.status.controlPlane.endpoints.privateEndpoint = 'https://pr.mk8scluster-e00mocktrn.mk8s.eu-north1.nebius.cloud';
    delete staging.status.controlPlane.auth;
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      return toResponse(stub.handle(init?.method ?? 'GET', url.pathname + url.search, Object.fromEntries(new Headers(init?.headers).entries())));
    });
    const hosts: string[] = [];
    try {
      const base = (testConfig() as any).nebiusEstate.nebius;
      const svc = new InventoryService(readEstateConfig(new ConfigReader(testConfig({ nebius: { ...base, mk8s: { endpoint: 'private' } } }) as any)), mockServices.logger.mock());
      svc.useKubeFetch(() => async input => {
        hosts.push(new URL(String(input)).hostname);
        return toResponse({ status: 200, body: { items: [] } });
      });
      await svc.start();
      await svc.ready();
      const st = (id: string) => svc.snapshot().statuses.find(s => s.id === id);
      expect(st('mk8s:mk8scluster-e00mockinf')).toMatchObject({ state: 'ok' });
      expect(new Set(hosts)).toEqual(new Set(['pr.mk8scluster-e00mockinf.mk8s.eu-north1.nebius.cloud']));
      expect(st('mk8s:mk8scluster-e00mocktrn')).toMatchObject({ state: 'error', error: expect.stringMatching(/no cluster CA certificate; not connecting/) });
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});

describe('GPU telemetry from VMs and from the cluster agent', () => {
  it('lists a GPU reported by both sources once, filling gaps from the second', () => {
    const vm = [{ instanceId: 'computeinstance-e00mockinfgpu0', node: 'n', gpu: '0', projectId: 'p', utilPercent: 63.5, source: 'vm' }];
    const agent = [
      { instanceId: 'computeinstance-e00mockinfgpu0', node: 'n', gpu: '0', projectId: 'p', utilPercent: 64, tempC: 55, source: 'agent' },
      { node: 'gpu-node-7', gpu: '1', projectId: 'p', utilPercent: 10, source: 'agent' },
    ];
    expect(mergeGpus(vm, agent)).toEqual([
      { instanceId: 'computeinstance-e00mockinfgpu0', node: 'n', gpu: '0', projectId: 'p', utilPercent: 63.5, tempC: 55, source: 'vm' },
      { node: 'gpu-node-7', gpu: '1', projectId: 'p', utilPercent: 10, source: 'agent' },
    ]);
  });
});
