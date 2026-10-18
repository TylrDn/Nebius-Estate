import { createVerify, generateKeyPairSync } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { attribute, attributeWithParents, findOrphanCandidates, RECIPES } from '@internal/nebius-domain';
import { CATALOG } from './nebius-catalog';
import { HttpClient } from '../lib/http';
import { NEBIUS_API, NEBIUS_AUTH, NebiusInventoryConnector, ServiceAccountTokenProvider, mapState } from './nebius';
import { instanceIdFromProviderId, mapKubeObjects, nodeGroupIdFromLabels } from './kubernetes';
import { mapAllocation, mapCluster, mapDisk, mapDnsZone, mapInstance, mapNetwork, mapPool, mapSecurityGroup, markDefaultPools } from './nebius-mappers';
import { GPU_UTIL_QUERY, PrometheusConnector } from './prometheus';
import { isAllowedRepoPath, RepoReader } from '../repo/RepoReader';
import { decisionIndex, evidenceIndex, firstParagraph, headerField, liveRootOf, recipesOfRun, runbookIndex } from '../repo/evidence';
import { REPO_ROOT } from '../__testUtils__/testing';

/**
 * Contract tests: the connectors are exercised against invented responses
 * shaped like the documented Nebius REST API (https://api.nebius.cloud/openapi.json:
 * `{ items, nextPageToken }`, camelCase fields). Not a live verification.
 */

/** The original inventory lists: these contract tests are about their mapping. */
const CORE = CATALOG.filter(d => ['compute.instances', 'compute.disks', 'compute.filesystems', 'compute.gpu-clusters', 'vpc.networks', 'vpc.subnets', 'storage.buckets', 'mk8s.clusters', 'mk8s.node-groups'].includes(d.id));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** GET /iam/v2/projects/{id}, in the shape verified against the live API (labels null). */
const liveProject = (id: string, region: string) => ({
  metadata: { id, parentId: 'tenant-e00mocklive', name: `default-project-${region}`, region, labels: null, createdAt: '2026-09-01T00:00:00Z' },
  spec: { region, defaultRegion: region },
  status: { projectState: 'ACTIVE' },
});

function fakeNebius(opts: { denyBucketsFor?: string; denyProjectGet?: boolean; region?: string } = {}) {
  const calls: string[] = [];
  const fetch = jest.fn(async (url: string) => {
    const u = new URL(url);
    calls.push(`${u.pathname}?${u.searchParams.toString()}`);
    const parent = u.searchParams.get('parentId');
    const token = u.searchParams.get('pageToken');
    const project = /^\/iam\/v2\/projects\/(project-[a-z0-9]+)$/.exec(u.pathname);
    if (project) return opts.denyProjectGet ? json({ code: 7, message: 'PermissionDenied' }, 403) : json(liveProject(project[1], opts.region ?? 'eu-north1'));
    if (u.pathname === '/iam/v2/projects') return json({ code: 7, message: 'PermissionDenied' }, 403); // tenant listing: never needed
    switch (u.pathname) {
      case '/compute/v1/instances':
        if (!token) {
          return json({
            items: [
              {
                metadata: { id: 'computeinstance-e00mockt1', parentId: parent, name: 'gpu-0', labels: { 'nip-env': 'inference', 'nip-stage': 'sandbox' }, createdAt: '2026-10-01T00:00:00Z' },
                spec: { resources: { platform: 'gpu-h100-sxm', preset: '1gpu-16vcpu-200gb' }, bootDisk: { existingDisk: { id: 'computedisk-e00mockboot' } }, filesystems: [{ existingFilesystem: { id: 'computefilesystem-e00mockfs' } }], networkInterfaces: [{ subnetId: 'vpcsubnet-e00mock' }], preemptible: { onPreemption: 'STOP' } },
                status: { state: 'RUNNING' },
              },
            ],
            nextPageToken: 'page-2',
          });
        }
        return json({ items: [{ metadata: { id: 'computeinstance-e00mockt2', parentId: parent, name: 'cpu-0' }, spec: { resources: { platform: 'cpu-d3', preset: '8vcpu-32gb' } }, status: { state: 'STOPPED' } }], nextPageToken: '' });
      case '/compute/v1/disks':
        return json({ items: [{ metadata: { id: 'computedisk-e00mockboot', parentId: parent, name: 'boot' }, spec: { sizeGibibytes: '128', type: 'NETWORK_SSD' }, status: { state: 'READY', readWriteAttachments: [{ instanceId: 'computeinstance-e00mockt1' }] } }] });
      case '/compute/v1/filesystems':
        return json({ items: [{ metadata: { id: 'computefilesystem-e00mockfs', parentId: parent, name: 'fs' }, spec: { sizeGibibytes: 64, type: 'NETWORK_SSD' }, status: { state: 'READY' } }] });
      case '/compute/v1/gpu-clusters':
        return json({ items: [] });
      case '/vpc/v1/networks': // live shape: a Nebius-created default network has labels null and status.default
        return json({ items: [{ metadata: { id: 'vpcnetwork-e00mockdef', parentId: parent, name: 'default-network', labels: null }, spec: {}, status: { state: 'READY', default: true } }] });
      case '/vpc/v1/subnets':
        return json({ items: [{ metadata: { id: 'vpcsubnet-e00mockdef', parentId: parent, name: 'default-subnet-e00mockab', labels: null }, spec: { networkId: 'vpcnetwork-e00mockdef' }, status: { state: 'READY', default: true } }] });
      case '/storage/v1/buckets':
        if (parent === opts.denyBucketsFor) return json({ code: 7, message: 'PermissionDenied' }, 403);
        return json({ items: [] });
      case '/mk8s/v1/clusters':
        return json({ items: [{ metadata: { id: 'mk8scluster-e00mock', parentId: parent, name: 'c1' }, spec: { controlPlane: { version: '1.36', subnetId: 'vpcsubnet-e00mock' } }, status: { state: 'RUNNING', controlPlane: { version: '1.36.3' } } }] });
      case '/mk8s/v1/node-groups':
        return json({ items: [{ metadata: { id: 'mk8snodegroup-e00mock', parentId: parent, name: 'gpu' }, spec: { autoscaling: { minNodeCount: 0, maxNodeCount: 2 }, template: { resources: { platform: 'gpu-h100-sxm', preset: '8gpu-128vcpu-1600gb' }, reservationPolicy: { policy: 'AUTO' } } }, status: { state: 'RUNNING' } }] });
      default:
        return json({ code: 5, message: 'not found' }, 404);
    }
  });
  return { fetch, calls };
}

describe('NebiusInventoryConnector (contract)', () => {
  it('reads each configured project by id (name and region from the API) and never lists the tenant', async () => {
    const { fetch, calls } = fakeNebius({ region: 'eu-west2' });
    const http = new HttpClient({ allowedOrigins: [NEBIUS_API], timeoutMs: 1000, fetch, authorization: async () => 'Bearer test' });
    const r = await new NebiusInventoryConnector(http, { projects: [{ id: 'project-e00mocka' }], maxConcurrency: 2, catalog: CORE }).sync();
    expect(calls).not.toContain(expect.stringMatching(/^\/iam\/v2\/projects\?/));
    const byId = Object.fromEntries(r.resources.map(x => [x.providerId, x]));
    expect(byId['project-e00mocka']).toMatchObject({ name: 'default-project-eu-west2', region: 'eu-west2', tenantId: 'tenant-e00mocklive', status: 'running' });
    // Regional resources carry no region of their own: the project's region labels them.
    expect(byId['vpcnetwork-e00mockdef'].region).toBe('eu-west2');
    expect(byId['computeinstance-e00mockt1'].region).toBe('eu-west2');
    expect(r.projects).toEqual([{ id: 'project-e00mocka', name: 'default-project-eu-west2' }]);
    expect(r.coverage[0]).toMatchObject({ project: { id: 'project-e00mocka', name: 'default-project-eu-west2' }, partial: false });
  });

  it('marks Nebius-created default networks and subnets, which are then never unattributed or orphans', async () => {
    const { fetch } = fakeNebius();
    const http = new HttpClient({ allowedOrigins: [NEBIUS_API], timeoutMs: 1000, fetch, authorization: async () => 'Bearer test' });
    const r = await new NebiusInventoryConnector(http, { projects: [{ id: 'project-e00mocka' }], maxConcurrency: 2, catalog: CORE }).sync();
    const defaults = r.resources.filter(x => x.spec.platformDefault);
    expect(defaults.map(x => x.type).sort()).toEqual(['vpc-network', 'vpc-subnet']);
    expect(defaults.every(x => attribute(x).platformDefault && !attribute(x).attributed)).toBe(true);
    expect(findOrphanCandidates(r.resources).map(o => o.uid)).not.toEqual(expect.arrayContaining(defaults.map(x => x.uid)));
  });

  it('keeps the configured project when reading it by id is refused, and reports it', async () => {
    const { fetch } = fakeNebius({ denyProjectGet: true });
    const http = new HttpClient({ allowedOrigins: [NEBIUS_API], timeoutMs: 1000, fetch, authorization: async () => 'Bearer test' });
    const r = await new NebiusInventoryConnector(http, { projects: [{ id: 'project-e00mocka', name: 'a', regions: ['eu-north1'] }], maxConcurrency: 2, catalog: CORE }).sync();
    expect(r.resources.find(x => x.type === 'project')).toMatchObject({ name: 'a', region: 'eu-north1', status: 'unknown' });
    expect(r.errors).toEqual([expect.objectContaining({ service: 'iam.projects', status: 403 })]);
    expect(r.permissionDenied).toBe(true);
  });

  it('lists documented services, follows pagination and maps fields', async () => {
    const { fetch, calls } = fakeNebius();
    const http = new HttpClient({ allowedOrigins: [NEBIUS_API], timeoutMs: 1000, fetch, authorization: async () => 'Bearer test' });
    const r = await new NebiusInventoryConnector(http, { projects: [{ id: 'project-e00mocka', regions: ['eu-north1'] }], maxConcurrency: 2, now: () => new Date('2026-10-10T00:00:00Z'), catalog: CORE }).sync();
    expect(calls).toEqual(expect.arrayContaining(['/compute/v1/instances?parentId=project-e00mocka&pageSize=100', '/compute/v1/instances?parentId=project-e00mocka&pageSize=100&pageToken=page-2', '/mk8s/v1/node-groups?parentId=mk8scluster-e00mock&pageSize=100']));
    const byId = Object.fromEntries(r.resources.map(x => [x.providerId, x]));
    expect(byId['computeinstance-e00mockt1']).toMatchObject({ type: 'compute-instance', status: 'running', region: 'eu-north1', spec: { gpus: 1, vcpus: 16, capacityType: 'preemptible' } });
    expect(byId['computeinstance-e00mockt2'].status).toBe('stopped');
    expect(byId['computedisk-e00mockboot']).toMatchObject({ spec: { sizeGib: 128, attachments: 1 }, refs: [{ relation: 'attached-to', target: 'computeinstance-e00mockt1' }] });
    expect(byId['computefilesystem-e00mockfs'].refs).toEqual([{ relation: 'mounted-by', target: 'computeinstance-e00mockt1' }]);
    expect(byId['mk8snodegroup-e00mock'].spec).toMatchObject({ autoscaling: { min: 0, max: 2 }, gpus: 8, capacityType: 'reserved', reservationPolicy: 'AUTO' });
    expect(byId['mk8scluster-e00mock'].spec.k8sVersion).toBe('1.36.3');
    expect(r.coverage[0].partial).toBe(false);
  });

  it('reports partial coverage and permission-denied per service, keeping the rest', async () => {
    const { fetch } = fakeNebius({ denyBucketsFor: 'project-e00mockb' });
    const http = new HttpClient({ allowedOrigins: [NEBIUS_API], timeoutMs: 1000, fetch, maxRetries: 0 });
    const r = await new NebiusInventoryConnector(http, { projects: [{ id: 'project-e00mocka' }, { id: 'project-e00mockb' }], maxConcurrency: 4, catalog: CORE }).sync();
    expect(r.permissionDenied).toBe(true);
    expect(r.errors).toEqual([expect.objectContaining({ project: 'project-e00mockb', service: 'storage.buckets', status: 403 })]);
    expect(r.coverage.find(c => c.project?.id === 'project-e00mockb')).toMatchObject({ partial: true, note: 'storage.buckets (403) unavailable' });
    expect(r.resources.some(x => x.projectId === 'project-e00mockb' && x.type === 'compute-instance')).toBe(true);
  });

  it('maps unknown states to unknown, never to running', () => {
    expect(mapState('SOMETHING_NEW')).toBe('unknown');
    expect(mapState(undefined)).toBe('unknown');
  });

  it('maps IP allocation states (ALLOCATING, ALLOCATED, ASSIGNED) instead of "unknown"', () => {
    expect(mapState('ASSIGNED')).toBe('running');
    expect(mapState('STATE_ALLOCATED')).toBe('running');
    expect(mapState('ALLOCATING')).toBe('provisioning');
  });
});

describe('ServiceAccountTokenProvider (documented token exchange)', () => {
  it('signs an RS256 JWT with kid/iss/sub and exchanges it once while valid', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const fetch = jest.fn(async (_url: string, init: RequestInit) => {
      const form = new URLSearchParams(String(init.body));
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
      expect(form.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:jwt');
      const [h, b, sig] = form.get('subject_token')!.split('.');
      expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'publickey-e00mock' });
      expect(JSON.parse(Buffer.from(b, 'base64url').toString())).toMatchObject({ iss: 'serviceaccount-e00mock', sub: 'serviceaccount-e00mock' });
      const v = createVerify('RSA-SHA256');
      v.update(`${h}.${b}`);
      expect(v.verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
      return json({ access_token: 'iam-token', token_type: 'Bearer', expires_in: 43200 });
    });
    const p = new ServiceAccountTokenProvider(
      { serviceAccountId: 'serviceaccount-e00mock', publicKeyId: 'publickey-e00mock', privateKeyPem: pem },
      new HttpClient({ allowedOrigins: [NEBIUS_AUTH], timeoutMs: 1000, fetch, allowPostPaths: ['/oauth2/token/exchange'] }),
    );
    expect(await p.token()).toBe('iam-token');
    expect(await p.token()).toBe('iam-token');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://sts.nebius.com/oauth2/token/exchange');
  });

  it('makes one exchange per expiry however many calls ask at once (F1.46), and retries after a failed one', async () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    let clock = Date.parse('2026-10-12T03:00:00Z');
    let release!: () => void;
    let fail = false;
    let exchanges = 0;
    const fetch = jest.fn(async (): Promise<Response> => {
      exchanges++;
      await new Promise<void>(r => (release = r));
      if (fail) throw new Error('exchange refused');
      return json({ access_token: `iam-token-${exchanges}`, token_type: 'Bearer', expires_in: 3600 });
    });
    const p = new ServiceAccountTokenProvider(
      { serviceAccountId: 'serviceaccount-e00mock', publicKeyId: 'publickey-e00mock', privateKeyPem: pem },
      new HttpClient({ allowedOrigins: [NEBIUS_AUTH], timeoutMs: 1000, fetch, allowPostPaths: ['/oauth2/token/exchange'], maxRetries: 0 }),
      () => clock,
    );
    // Twelve calls (the per-host concurrency) at once, before the first exchange answers.
    const first = Array.from({ length: 12 }, () => p.token());
    await new Promise(r => setImmediate(r));
    release();
    expect(await Promise.all(first)).toEqual(Array(12).fill('iam-token-1'));
    expect(fetch).toHaveBeenCalledTimes(1);
    // Past the refresh point (5 min before expiry): again one exchange for all.
    clock += 56 * 60_000;
    const second = Array.from({ length: 12 }, () => p.token());
    await new Promise(r => setImmediate(r));
    release();
    expect(new Set(await Promise.all(second))).toEqual(new Set(['iam-token-2']));
    expect(fetch).toHaveBeenCalledTimes(2);
    // A failed exchange fails every waiting call once, and is not cached: the next call exchanges again.
    clock += 56 * 60_000;
    fail = true;
    const third = Array.from({ length: 3 }, () => p.token().then(() => 'ok', (e: Error) => e.message));
    await new Promise(r => setImmediate(r));
    release();
    expect(await Promise.all(third)).toEqual(Array(3).fill(expect.stringContaining('exchange refused')));
    expect(fetch).toHaveBeenCalledTimes(3);
    fail = false;
    const fourth = p.token();
    await new Promise(r => setImmediate(r));
    release();
    expect(await fourth).toBe('iam-token-4');
  });
});

describe('Kubernetes mapping', () => {
  const objs = {
    nodes: [{ metadata: { name: 'n1' }, spec: { providerID: 'nebius://computeinstance-e00mockt1' }, status: { allocatable: { 'nvidia.com/gpu': '1' } } }],
    namespaces: [{ metadata: { name: 'inference' } }, { metadata: { name: 'secret-team' } }],
    deployments: [
      { metadata: { name: 'vllm', namespace: 'inference' }, spec: { replicas: 1, template: { spec: { containers: [{ resources: { requests: { 'nvidia.com/gpu': '1', cpu: '4' }, limits: { 'nvidia.com/gpu': '1' } } }], nodeSelector: { gpu: 'true' }, tolerations: [{ key: 'nvidia.com/gpu', effect: 'NoSchedule' }] } } }, status: { readyReplicas: 0 } },
      { metadata: { name: 'hidden', namespace: 'secret-team' }, spec: { replicas: 1, template: { spec: { containers: [] } } }, status: {} },
    ],
    statefulsets: [],
    replicasets: [{ metadata: { name: 'vllm-abc', namespace: 'inference', ownerReferences: [{ kind: 'Deployment', name: 'vllm' }] } }],
    jobs: [],
    pods: [
      {
        metadata: { name: 'vllm-abc-1', namespace: 'inference', ownerReferences: [{ kind: 'ReplicaSet', name: 'vllm-abc' }] },
        spec: { volumes: [{ persistentVolumeClaim: { claimName: 'cache' } }] },
        status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', message: '0/1 nodes are available: 1 Insufficient nvidia.com/gpu.' }] },
      },
    ],
    pvcs: [],
    events: [{ metadata: { namespace: 'inference' }, type: 'Warning', reason: 'FailedScheduling', involvedObject: { kind: 'Pod', name: 'vllm-abc-1' }, message: 'x', lastTimestamp: '2026-10-10T00:00:00Z' }],
  };

  it('resolves pod ownership through ReplicaSets, keeps requests per pod and scheduling messages', () => {
    const c = mapKubeObjects('c', objs, { observedAt: 'now', namespaces: ['inference'] });
    expect(c.namespaces).toEqual(['inference']);
    expect(c.workloads).toHaveLength(1);
    expect(c.workloads[0]).toMatchObject({ name: 'vllm', requests: { 'nvidia.com/gpu': '1', cpu: '4' }, tolerations: ['nvidia.com/gpu:NoSchedule'] });
    expect(c.workloads[0].pods[0]).toMatchObject({ phase: 'Pending', pvc: 'cache', message: expect.stringContaining('Insufficient') });
    expect(c.nodes[0].instanceId).toBe('computeinstance-e00mockt1');
    expect(c.events).toHaveLength(1);
  });

  it('links nodes to instances only on an exact id in providerID', () => {
    expect(instanceIdFromProviderId('nebius://computeinstance-e00abc')).toBe('computeinstance-e00abc');
    expect(instanceIdFromProviderId('gpu-node-like-computeinstance')).toBeUndefined();
  });
});

describe('PrometheusConnector', () => {
  it('reads DCGM utilisation from the documented query API', async () => {
    const fetch = jest.fn(async (url: string) => {
      expect(url).toContain(`/api/v1/query?${new URLSearchParams({ query: GPU_UTIL_QUERY })}`);
      return json({ status: 'success', data: { resultType: 'vector', result: [{ metric: { Hostname: 'n1' }, value: [1, '42.5'] }, { metric: { Hostname: 'n2' }, value: [1, 'NaN'] }] } });
    });
    const t = await new PrometheusConnector('http://localhost:9090', new HttpClient({ allowedOrigins: ['http://localhost:9090'], timeoutMs: 1000, fetch })).sync();
    expect(t.samples).toEqual([{ node: 'n1', gpuUtilPercent: 42.5 }]);
  });

  it('reads Nebius Monitoring label shapes: instance_id (no Hostname) names the VM, one sample per VM', async () => {
    // Live 2026-10-11 (docs/evidence/2026-10-11-observability-read-only.md): DCGM series carry instance, instance_id,
    // job, mk8s_cluster_id, mk8s_node_group_id, uuid; no Hostname. Grouping by Hostname alone would merge every VM.
    expect(GPU_UTIL_QUERY).toBe('avg by (Hostname, instance_id) (DCGM_FI_DEV_GPU_UTIL)');
    const fetch = jest.fn(async () =>
      json({ status: 'success', data: { resultType: 'vector', result: [{ metric: { instance_id: 'computeinstance-e00mockgpu1' }, value: [1, '80'] }, { metric: { instance_id: 'computeinstance-e00mockgpu2' }, value: [1, '10'] }] } }),
    );
    const t = await new PrometheusConnector('http://localhost:9090', new HttpClient({ allowedOrigins: ['http://localhost:9090'], timeoutMs: 1000, fetch })).sync();
    expect(t.samples).toEqual([
      { node: 'computeinstance-e00mockgpu1', instanceId: 'computeinstance-e00mockgpu1', gpuUtilPercent: 80 },
      { node: 'computeinstance-e00mockgpu2', instanceId: 'computeinstance-e00mockgpu2', gpuUtilPercent: 10 },
    ]);
  });
});

describe('RepoReader safety', () => {
  it('allows only listed repository paths', () => {
    expect(isAllowedRepoPath('platform/stages.yaml')).toBe(true);
    expect(isAllowedRepoPath('terraform/live/prod/training/prod.auto.tfvars')).toBe(true);
    // The dated plans the README and docs/rescoping.md link open in the document viewer.
    expect(isAllowedRepoPath('docs/plans/2026-10-12-live-runs.md')).toBe(true);
    expect(isAllowedRepoPath('docs/specs/x.md')).toBe(false);
    for (const p of ['../x.md', 'docs/../README.md', 'docs//x.md', 'terraform/live/sandbox/inference/backend.hcl', 'docs\\x.md', 'docs/x.md\0.png', '.env', 'terraform/live/sandbox/inference/terraform.tfstate']) {
      expect(isAllowedRepoPath(p)).toBe(false);
    }
  });

  it('allows the solutions, their footprints, the new recipe READMEs and live roots, read-only', () => {
    for (const p of [
      'solutions/README.md',
      'solutions/S1-private-llm-serving-vpn/README.md',
      'solutions/S2-fine-tune-70b-two-weeks/footprint-b300.json',
      'solutions/S8-batch-inference/footprint.json',
      'docs/solutions/README.md',
      'docs/design/2026-10-11-solutions-and-recipes.md',
      'terraform/live/staging/gpu-vm/staging.auto.tfvars',
      'terraform/live/prod/ml-services/prod.auto.tfvars',
      'terraform/live/sandbox/governance/sandbox.auto.tfvars',
      'terraform/stacks/nvl/README.md',
      'terraform/modules/foundation/ci-federation/README.md',
      'recipes/finance/README.md',
      'workloads/kueue/README.md',
    ]) {
      expect([p, isAllowedRepoPath(p)]).toEqual([p, true]);
    }
    for (const p of ['solutions/S1-private-llm-serving-vpn/secret.json', 'solutions/S1-x/footprint.yaml', 'solutions/x/README.md', 'solutions/S1-x/../README.md', 'terraform/live/sandbox/gpu-vm/terraform.tfstate']) {
      expect([p, isAllowedRepoPath(p)]).toEqual([p, false]);
    }
  });

  it('lists a solution folder\'s footprint files only', async () => {
    const files = await new RepoReader(REPO_ROOT).footprints('solutions/S2-fine-tune-70b-two-weeks');
    expect(files).toEqual(['solutions/S2-fine-tune-70b-two-weeks/footprint.json', 'solutions/S2-fine-tune-70b-two-weeks/footprint-b300.json']);
    await expect(new RepoReader(REPO_ROOT).footprints('solutions/../docs')).rejects.toThrow(/not readable/);
  });

  it('refuses symlinks that escape the repository root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ne-repo-'));
    const outside = mkdtempSync(join(tmpdir(), 'ne-out-'));
    writeFileSync(join(outside, 'secret.md'), 'secret');
    mkdirSync(join(root, 'docs'));
    symlinkSync(join(outside, 'secret.md'), join(root, 'docs', 'leak.md'));
    const r = new RepoReader(root);
    await expect(r.read('docs/leak.md')).rejects.toThrow(/not readable/);
  });

  it('builds a model from the real repository', async () => {
    const m = await new RepoReader(REPO_ROOT).model();
    expect(m.liveRoots.map(x => `${x.stage}/${x.stack}`)).toEqual(
      expect.arrayContaining(['sandbox/inference', 'prod/training', 'staging/soperator', 'sandbox/network', 'prod/data']),
    );
    expect(m.liveRoots.find(x => x.stage === 'sandbox' && x.stack === 'inference')?.hasPlanTests).toBe(true);
    expect(m.liveRoots.find(x => x.stage === 'prod' && x.stack === 'network')).toMatchObject({ sizingFile: 'terraform/live/prod/network/prod.auto.tfvars', hasPlanTests: true });
    expect(m.versions.some(v => v.path.startsWith('tooling / '))).toBe(true);
    // R9, R10 and R12 live roots are read like R7 and R8 (read-only).
    expect(m.liveRoots.map(x => `${x.stage}/${x.stack}`)).toEqual(expect.arrayContaining(['sandbox/gpu-vm', 'staging/ml-services', 'prod/governance']));
    const r10 = m.recipes.find(r => r.id === 'R10')!;
    expect(r10).toMatchObject({ provisioning: 'live-root', caps: { sandbox: 1, staging: 1, prod: 0 }, docsAvailable: true });
    expect(r10.liveRoots).toEqual(['terraform/live/sandbox/gpu-vm', 'terraform/live/staging/gpu-vm']);
    expect(m.recipes.find(r => r.id === 'R15')).toMatchObject({ provisioning: 'documentation', caps: { sandbox: 0, staging: 0, prod: 0 }, liveRoots: [] });
  });

  it('gives each live root the regions its run profiles target, and none without a profile (F1.38)', async () => {
    const m = await new RepoReader(REPO_ROOT).model();
    // platform/profiles/inference/l40s-gpu-only.json: stack inference, stages [sandbox], region eu-north1.
    expect(m.liveRoots.find(x => x.stage === 'sandbox' && x.stack === 'inference')?.runRegions).toEqual(['eu-north1']);
    expect(m.liveRoots.find(x => x.stage === 'staging' && x.stack === 'inference')?.runRegions).toBeUndefined();
    expect(m.liveRoots.find(x => x.stage === 'prod' && x.stack === 'training')?.runRegions).toBeUndefined();
  });

  it('carries each run profile\'s name and vars, the sizing a PROFILE= run plans (G2.2)', async () => {
    const m = await new RepoReader(REPO_ROOT).model();
    const inf = m.liveRoots.find(x => x.stage === 'sandbox' && x.stack === 'inference')!;
    expect(inf.runProfiles).toEqual([
      expect.objectContaining({ name: 'l40s-gpu-only', region: 'eu-north1', vars: expect.objectContaining({ cpu_node_count: 0, gpu_platform: 'gpu-l40s-a', gpu_preset: '1gpu-8vcpu-32gb', gpu_preemptible: true }) }),
      expect.objectContaining({ name: 'l40s-serving', region: 'eu-north1', vars: expect.objectContaining({ cpu_node_count: 0, gpu_node_count: 1, gpu_platform: 'gpu-l40s-a', gpu_preset: '1gpu-8vcpu-32gb', gpu_preemptible: true, enable_o11y: false, alertmanager_enabled: false }) }),
    ]);
    const vm = m.liveRoots.find(x => x.stage === 'sandbox' && x.stack === 'gpu-vm')!;
    expect(vm.runProfiles?.map(p => [p.name, p.vars.preemptible])).toEqual([['l40s-preemptible', true]]);
  });

  it('allowlists every recipe document', () => {
    for (const recipe of RECIPES) expect(isAllowedRepoPath(recipe.docs)).toBe(true);
  });

  it('marks a recipe whose README is not in the checkout instead of failing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ne-repo-'));
    mkdirSync(join(root, 'platform'));
    for (const f of ['stages', 'regions', 'versions']) writeFileSync(join(root, 'platform', `${f}.yaml`), readFileSync(join(REPO_ROOT, 'platform', `${f}.yaml`)));
    mkdirSync(join(root, 'terraform/stacks/inference'), { recursive: true });
    writeFileSync(join(root, 'terraform/stacks/inference/README.md'), '# Inference');
    const m = await new RepoReader(root).model();
    expect(m.recipes.find(r => r.id === 'R1')?.docsAvailable).toBe(true);
    expect(m.recipes.find(r => r.id === 'R7')?.docsAvailable).toBe(false);
    expect(m.liveRoots).toEqual([]);
  });
});

describe('evidence index', () => {
  it('classifies prior upstream runs, never as this repository live evidence', async () => {
    const items = await evidenceIndex(new RepoReader(REPO_ROOT));
    // Runs of this repository's code are 'repo-live' (the portal's read-only run); upstream recipe runs never are.
    // The evidence folder grows with each run: these two are always there, and no prior upstream run is among them.
    const repoLive = items.filter(i => i.kind === 'repo-live').map(i => i.path ?? '');
    expect(repoLive).toEqual(expect.arrayContaining(['docs/evidence/2026-10-11-portal-live-read-only.md', 'docs/evidence/2026-10-11-sandbox-inference-portal-connectors.md']));
    expect(repoLive.filter(p => /2026-10-08/.test(p))).toEqual([]);
    const b300 = items.find(i => i.path === 'docs/evidence/2026-10-08-mk8s-b300-gpu-smoke.md');
    expect(b300).toMatchObject({ kind: 'upstream-live', region: 'uk-south1', date: '2026-10-08' });
    expect(items.some(i => i.kind === 'not-measured' && /InfiniBand/.test(i.title))).toBe(true);
    expect(items.filter(i => i.kind === 'mocked-plan-test').length).toBeGreaterThan(5);
  });

  it('ties evidence to recipes: the README run column, else the live root\'s stack; R9–R16 without a run say so', async () => {
    const items = await evidenceIndex(new RepoReader(REPO_ROOT));
    expect(items.find(i => i.path === 'docs/evidence/2026-10-11-token-factory-smoke.md')?.recipe).toBe('R11');
    expect(items.find(i => i.path === 'docs/evidence/2026-10-11-observability-read-only.md')?.recipe).toBe('R14');
    expect(items.find(i => i.path === 'docs/evidence/2026-10-11-sandbox-inference-populate.md')?.recipe).toBe('R1');
    const todo = items.filter(i => i.kind === 'not-measured').map(i => i.recipe);
    for (const id of ['R15', 'R16']) expect([id, todo.includes(id)]).toEqual([id, true]);
    // The live-plans file names R9, R7, R3 and R4 in its Run column: it is a run of each of them.
    const plans = items.find(i => i.path === 'docs/evidence/2026-10-11-sandbox-live-plans.md');
    expect(plans?.recipes).toEqual(expect.arrayContaining(['R3', 'R4', 'R7', 'R9']));
    const noRun = items.filter(i => /no run of this repository yet/.test(i.title)).map(i => i.recipe);
    for (const id of ['R3', 'R4', 'R7']) expect([id, noRun.includes(id)]).toEqual([id, false]);
    // First live runs on 2026-10-11 (R10 gpu-vm, R12 ml-services, R8 data, R9 governance, R13 foundation): measured, tied to their evidence.
    for (const id of ['R8', 'R9', 'R10', 'R12', 'R13']) expect([id, todo.includes(id)]).toEqual([id, false]);
    expect(items.find(i => i.path === 'docs/evidence/2026-10-11-sandbox-gpu-vm-live-recipe.md')?.recipe).toBe('R10');
  });

  it('no recipe proven live (Live run or Live read / plan) is listed as having no run of this repository', async () => {
    const items = await evidenceIndex(new RepoReader(REPO_ROOT));
    const noRun = new Set(items.filter(i => /no run of this repository yet/.test(i.title)).map(i => i.recipe));
    const live = RECIPES.filter(r => /^Live (run|read \/ plan):/.test(r.provenToday)).map(r => r.id);
    expect(live.length).toBeGreaterThan(0);
    expect(live.filter(id => noRun.has(id))).toEqual([]);
  });

  it('derives which live roots have been applied from the evidence files, not from a fixed sentence', async () => {
    const items = await evidenceIndex(new RepoReader(REPO_ROOT));
    const runs = items.filter(i => i.liveRoot);
    expect(runs.map(i => [i.path, i.liveRoot])).toContainEqual(['docs/evidence/2026-10-11-sandbox-inference-portal-connectors.md', 'terraform/live/sandbox/inference']);
    expect(runs.every(i => i.kind === 'repo-live')).toBe(true);
    expect(items.find(i => i.path === 'docs/evidence/2026-10-11-portal-live-read-only.md')?.liveRoot).toBeUndefined(); // read-only: no root applied
    const notMeasured = items.filter(i => i.kind === 'not-measured').map(i => `${i.title}: ${i.limitations}`).join('\n');
    expect(notMeasured).not.toMatch(/none yet/);
    expect(notMeasured).toMatch(/sandbox\/inference/);
  });

  it('summaries are plain text: no Markdown emphasis, code ticks or link syntax (walkthrough 3)', async () => {
    expect(firstParagraph('# T\n\nRoutes into a **null receiver**: see `amtool` and [docs/slo.md](../docs/slo.md), _now_.\n')).toBe(
      'Routes into a null receiver: see amtool and docs/slo.md, now.',
    );
    const repo = new RepoReader(REPO_ROOT);
    const all = [...(await runbookIndex(repo)), ...(await decisionIndex(repo))];
    expect(all.find(r => r.path === 'runbooks/alerting.md')?.summary).toMatch(/null receiver/);
    expect(all.filter(r => /\*\*|`|\]\(/.test(r.summary)).map(r => r.path)).toEqual([]);
  });

  it('G5.7: the single-segment foundation root counts as applied, and its run backs R2 as well as R13', async () => {
    expect(liveRootOf('run of this repository (`terraform/live/foundation`, R13), the first apply')).toBe('terraform/live/foundation');
    expect(liveRootOf('run of this repository (`terraform/live/sandbox/inference`)')).toBe('terraform/live/sandbox/inference');
    expect(recipesOfRun('first apply of `live/foundation` (R13)', 'terraform/live/foundation')).toEqual(['R13', 'R2']);
    const items = await evidenceIndex(new RepoReader(REPO_ROOT));
    const foundation = items.find(i => i.path === 'docs/evidence/2026-10-11-foundation-ci-federation-live.md');
    expect(foundation).toMatchObject({ liveRoot: 'terraform/live/foundation', recipe: 'R13', recipes: ['R13', 'R2'] });
    expect(items.find(i => i.id === 'todo:live-roots')?.limitations).toMatch(/Applied so far \(docs\/evidence\): foundation, /);
  });

  it('G5.10: a run whose README row names no recipe takes the R<n> of its heading; Proves reads on its own', async () => {
    const items = await evidenceIndex(new RepoReader(REPO_ROOT));
    expect(items.find(i => i.path === 'docs/evidence/2026-10-11-sandbox-ci-federated-plan.md')?.recipe).toBe('R13');
    expect(items.find(i => i.path === 'docs/evidence/2026-10-11-foundation-ci-federation-live.md')?.proves).not.toMatch(/next row/);
  });

  it('G5.8: summaries skip wrapped header bullets, keep glob stars in code, and end on a word', async () => {
    const adr = '# ADR 1\n\n- **Status:** accepted\n- **Note (2026-10-11):** one thing; it\n  does not build option 3.\n\n## Context\nCustomers ask for `a/*.yaml` and **b**.\n';
    expect(firstParagraph(adr)).toBe('Customers ask for a/*.yaml and b.');
    // A checklist with no prose reads its first item; code fences are not prose.
    expect(firstParagraph('# Drift\n\n1. Plan first,\n   then read it.\n2. Second.\n')).toBe('Plan first, then read it.');
    const long = `# T\n\n${'word '.repeat(120)}`;
    expect(firstParagraph(long)).toMatch(/^(word ){10}.*word…$/);
    expect(firstParagraph(long).length).toBeLessThanOrEqual(401);
    const repo = new RepoReader(REPO_ROOT);
    expect((await runbookIndex(repo)).find(r => r.path === 'runbooks/alerting.md')?.summary).toMatch(/platform\/alerts\/\*\.yaml/);
    const decisions = await decisionIndex(repo);
    for (const d of decisions) {
      expect([d.path, /^[A-Z0-9"]/.test(d.summary)]).toEqual([d.path, true]); // starts a sentence, not mid-way
      expect([d.path, /(^|\s)- /.test(d.summary)]).toEqual([d.path, false]); // no raw bullets
      expect([d.path, /[.…):]$/.test(d.summary)]).toEqual([d.path, true]); // never cut mid-word
    }
    expect(decisions.find(d => d.path.includes('0001'))?.summary).toMatch(/^Customers ask either/);
  });

  it('#9, #73: a runbook summary is never a command line or the note under a code block', async () => {
    // A checklist whose first item is a command (`terraform … plan`) reads the first item that is prose, one sentence.
    const drift = '# Drift\n\n1. `terraform plan -detailed-exitcode` (exit code 2 = drift).\n2. Identify the source: console, reconciler or upgrade. Expected: each line attributed.\n   More.\n';
    expect(firstParagraph(drift)).toBe('Identify the source: console, reconciler or upgrade.');
    // The paragraph right after a code block explains that block; the summary is the next section's prose.
    const rollback = '# R\n\n## Drill\n\n```bash\n# 0. baseline\nkubectl get x\n```\n\nRecord the timings.\n\n## Platform\n\nRoll back one component at a time.\n';
    expect(firstParagraph(rollback)).toBe('Roll back one component at a time.');
    // Only code and notes on it: the first sub-heading, never the note.
    expect(firstParagraph('# R\n\n## Drill once\n\n```bash\nkubectl get x\n```\n\nRecord the timings.\n')).toBe('Drill once');
    const runbooks = await runbookIndex(new RepoReader(REPO_ROOT));
    const summary = (p: string) => runbooks.find(r => r.path === p)?.summary ?? '';
    expect(summary('runbooks/drift.md')).toMatch(/^Identify the source: manual console change/);
    expect(summary('runbooks/rollback.md')).toMatch(/^Roll back one component at a time/);
    for (const r of runbooks) {
      // No summary starts with a command (the tools the runbooks call) or a note that only makes sense under its code.
      expect([r.path, /^(terraform|kubectl|make|nebius|helm|python3?|bash|curl|export|source)\s/.test(r.summary)]).toEqual([r.path, false]);
      expect([r.path, /^Record in /.test(r.summary)]).toEqual([r.path, false]);
      expect([r.path, r.summary.length > 0]).toEqual([r.path, true]);
    }
  });

  it('reads wrapped bold header bullets', () => {
    expect(headerField('- **Kind:** prior run\n  continued here.\n- **Cost:** $1', 'Kind')).toBe('prior run continued here.');
    expect(headerField('- Kind: run of this repository (commit abc)\n- Method: a script', 'Kind')).toBe('run of this repository (commit abc)');
  });
});

describe('disks and node VMs in the live shapes', () => {
  const ctx = { projectId: 'project-e00mocksandbox', observedAt: '2026-10-11T07:00:00Z' };
  const mk8s = { 'mk8s-cluster-id': 'mk8scluster-e00mockinf', 'mk8s-node-group-id': 'mk8snodegroup-e00mockinfgpu' };

  it('reads status.readWriteAttachment and status.managedBy, and links a node disk to its node group', () => {
    const d = mapDisk(
      { metadata: { id: 'computedisk-e00mockngboot0', name: 'mk8snodegroup-e00mockinfgpu-pmvxp-kqlq2', labels: mk8s }, spec: { sizeGibibytes: 512 }, status: { state: 'READY', readWriteAttachment: 'computeinstance-e00mockngnode0', managedBy: 'mk8snodegroup-e00mockinfgpu' } },
      ctx,
    );
    expect(d.spec).toMatchObject({ attachments: 1, managedBy: 'mk8snodegroup-e00mockinfgpu', sizeGib: 512 });
    expect(d.refs).toEqual([{ relation: 'attached-to', target: 'computeinstance-e00mockngnode0' }, { relation: 'managed-by', target: 'mk8snodegroup-e00mockinfgpu' }]);
    expect(mapDisk({ metadata: { id: 'computedisk-e00mockro' }, status: { readOnlyAttachments: ['computeinstance-a', 'computeinstance-b'] } }, ctx).spec.attachments).toBe(2);
  });

  it('places a node VM in its node group from the labels Managed Kubernetes sets', () => {
    const vm = mapInstance({ metadata: { id: 'computeinstance-e00mockngnode0', labels: mk8s }, spec: { resources: { platform: 'cpu-d3', preset: '8vcpu-32gb' } }, status: { state: 'RUNNING' } }, ctx);
    expect(vm.refs).toEqual([{ relation: 'member-of', target: 'mk8snodegroup-e00mockinfgpu' }]);
    const clusterOnly = mapInstance({ metadata: { id: 'computeinstance-e00mockx', labels: { 'mk8s-cluster-id': 'mk8scluster-e00mockinf' } }, spec: {}, status: {} }, ctx);
    expect(clusterOnly.refs).toEqual([{ relation: 'managed-by', target: 'mk8scluster-e00mockinf' }]);
  });
});

describe('recognising defaults and managed resources (docs/naming.md §6)', () => {
  const ctx = { projectId: 'project-e00mocksandbox', observedAt: '2026-10-11T07:00:00Z' };

  it('reads the documented node-group label first, and links a node named after its VM', () => {
    expect(nodeGroupIdFromLabels({ 'nebius.com/node-group-id': 'mk8snodegroup-e00mocka', other: 'mk8snodegroup-e00mockb' })).toBe('mk8snodegroup-e00mocka');
    expect(nodeGroupIdFromLabels({ whatever: 'mk8snodegroup-e00mockb' })).toBe('mk8snodegroup-e00mockb'); // fallback
    const c = mapKubeObjects('c', { nodes: [{ metadata: { name: 'computeinstance-e00mocknode', labels: {} }, spec: {}, status: { allocatable: {} } }], namespaces: [], deployments: [], statefulsets: [], replicasets: [], jobs: [], pods: [], pvcs: [], events: [] }, { observedAt: ctx.observedAt });
    expect(c.nodes[0].instanceId).toBe('computeinstance-e00mocknode');
  });

  it('marks default pools by the default network’s pool list or, as a fallback, by name', () => {
    const net = mapNetwork({ metadata: { id: 'vpcnetwork-e00mockdef', name: 'default-network' }, spec: { ipv4PrivatePools: { pools: [{ id: 'vpcpool-e00mockpriv' }] } }, status: { default: true } }, ctx);
    const priv = mapPool({ metadata: { id: 'vpcpool-e00mockpriv', name: 'my-pool' }, spec: {} }, ctx);
    const pub = mapPool({ metadata: { id: 'vpcpool-e00mockpub', name: 'default-public-pool-eu-north1' }, spec: { visibility: 'PUBLIC' } }, ctx);
    const ours = mapPool({ metadata: { id: 'vpcpool-e00mockours', name: 'nip-pool', labels: { 'nip-stack': 'network' } }, spec: {} }, ctx);
    markDefaultPools([net, priv, pub, ours]);
    expect([priv, pub, ours].map(p => Boolean(p.spec.platformDefault))).toEqual([true, true, false]);
    expect((net as any)._defaultPools).toBeUndefined();
  });

  it('a pool names the subnets and networks it is assigned to (status.assignment), in either case (#29)', () => {
    const p = mapPool({ metadata: { id: 'vpcpool-e00mockauto', name: 'auto-subnet-pool' }, spec: {}, status: { assignment: { subnets: ['vpcsubnet-e00mockwl'], networks: [] } } }, ctx);
    expect(p.refs).toEqual([{ relation: 'pool-of', target: 'vpcsubnet-e00mockwl' }]);
    const snake = mapPool({ metadata: { id: 'vpcpool-e00mocknet', name: 'p' }, spec: {}, status: { assignment: { networks: ['vpcnetwork-e00mocknet'] } } }, ctx);
    expect(snake.refs).toEqual([{ relation: 'pool-of', target: 'vpcnetwork-e00mocknet' }]);
    expect(mapPool({ metadata: { id: 'vpcpool-e00mockfree', name: 'p' }, spec: {} }, ctx)).toMatchObject({ refs: [] });
    // Whether the answer said where the pool is assigned: only then is "assigned to nothing" a fact.
    expect(mapPool({ metadata: { id: 'vpcpool-e00mockfree', name: 'p' }, spec: {} }, ctx).spec.assignmentRead).toBeUndefined();
    expect(mapPool({ metadata: { id: 'vpcpool-e00mockfree', name: 'p' }, spec: {}, status: { assignment: {} } }, ctx).spec.assignmentRead).toBe(true);
    expect(p.spec.assignmentRead).toBe(true);
  });

  it('recognises the MK8s system security group and mk8s-managed allocations as managed, inheriting the cluster', () => {
    const sg = mapSecurityGroup({ metadata: { id: 'vpcsecuritygroup-e00mocksys', name: 'mk8scluster-e00mockinf-node-groups-system' }, spec: {} }, ctx);
    expect(sg.refs).toEqual(expect.arrayContaining([{ relation: 'managed-by', target: 'mk8scluster-e00mockinf' }]));
    const cluster = { ...mapCluster({ metadata: { id: 'mk8scluster-e00mockinf', name: 'nip-sandbox-inference', labels: { 'nip-stage': 'sandbox', 'nip-stack': 'inference' } }, spec: {}, status: {} }, ctx) };
    const byId = new Map([cluster, sg].map(r => [r.providerId, r]));
    expect(attributeWithParents(sg, byId)).toMatchObject({ attributed: true, stack: 'inference', inheritedFrom: 'cluster nip-sandbox-inference' });
    const lb = mapAllocation({ metadata: { id: 'vpcallocation-e00mocklb', name: 'lb', labels: { 'nebius.com/managed-by': 'mk8s' } }, spec: { ipv4Public: {} }, status: {} }, ctx);
    expect(attributeWithParents(lb, byId)).toMatchObject({ attributed: false, managed: 'Managed Kubernetes' });
  });

  it('treats the per-network system DNS zone as a default, related to its network', () => {
    const z = mapDnsZone({ metadata: { id: 'dnszone-e00mocksys', name: 'sys' }, spec: { domainName: 'vpcnetwork-e00mocksbx.compute.internal.' }, status: {} }, ctx);
    expect(z.spec.platformDefault).toBe(true);
    expect(z.refs).toEqual([{ relation: 'in-network', target: 'vpcnetwork-e00mocksbx' }]);
  });

  it('reads nip-stack first and falls back to the deprecated nip-env', () => {
    expect(attribute({ labels: { 'nip-stack': 'training', 'nip-env': 'inference' } }).stack).toBe('training');
    expect(attribute({ labels: { 'nip-env': 'inference' } }).stack).toBe('inference');
  });
});
