import { extractModelRefs, hfAccessFromStatus, parseHfModel, parseHfWhoami, parseTokenFactoryModels, serverlessListed } from './ai';

describe('workload model references', () => {
  it('finds Hugging Face repos in overlays, scripts and pinned versions, with where each is used', () => {
    const refs = extractModelRefs([
      { path: 'workloads/inference/overlays/qwen2.5-1.5b/kustomization.yaml', text: '      - MODEL=Qwen/Qwen2.5-1.5B-Instruct\n      - MODEL_REVISION=989aa79\n' },
      { path: 'workloads/inference/overlays/qwen2.5-7b/kustomization.yaml', text: '  - MODEL=Qwen/Qwen2.5-7B-Instruct\n' },
      { path: 'recipes/serverless/endpoint.sh', text: 'MODEL="${MODEL:-Qwen/Qwen2.5-1.5B-Instruct}"\n' },
      { path: 'platform/versions.yaml', text: '  qwen: { version: "x", source: "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct" }\n  vllm: { source: "https://hub.docker.com/r/vllm/vllm-openai/tags" }\n' },
      { path: 'workloads/x.yaml', text: 'image: vllm/vllm-openai:v1\nMODEL=$(MODEL)\n' },
    ]);
    expect(refs).toEqual([
      { repo: 'Qwen/Qwen2.5-1.5B-Instruct', usedBy: ['recipes/serverless/endpoint.sh', 'workloads/inference/overlays/qwen2.5-1.5b/kustomization.yaml'] },
      { repo: 'Qwen/Qwen2.5-7B-Instruct', usedBy: ['platform/versions.yaml', 'workloads/inference/overlays/qwen2.5-7b/kustomization.yaml'] },
    ]);
  });

  it('an overlay built on another overlay (`resources: - ../<overlay>`) uses its models too, unless it names its own (G3.17)', () => {
    const O = 'workloads/inference/overlays';
    const refs = extractModelRefs([
      { path: `${O}/qwen2.5-7b/kustomization.yaml`, text: '  - MODEL=Qwen/Qwen2.5-7B-Instruct\n' },
      { path: `${O}/qwen2.5-7b-prod/kustomization.yaml`, text: 'resources:\n  - ../qwen2.5-7b\npatches:\n  - target: { kind: Deployment, name: vllm }\n' },
      { path: `${O}/other/kustomization.yaml`, text: 'resources:\n  - ../qwen2.5-7b\n  - MODEL=Qwen/Qwen2.5-1.5B-Instruct\n' },
    ]);
    expect(refs).toEqual([
      { repo: 'Qwen/Qwen2.5-1.5B-Instruct', usedBy: [`${O}/other/kustomization.yaml`] },
      { repo: 'Qwen/Qwen2.5-7B-Instruct', usedBy: [`${O}/qwen2.5-7b-prod/kustomization.yaml`, `${O}/qwen2.5-7b/kustomization.yaml`] },
    ]);
  });
});

describe('Token Factory /v1/models', () => {
  it('reads the OpenAI-compatible list (id, owned_by, created)', () => {
    const r = parseTokenFactoryModels({ object: 'list', data: [{ id: 'Qwen/Qwen3-8B', object: 'model', created: 1785110400, owned_by: 'system' }, { id: 'b/m' }] });
    expect(r.models).toEqual([
      { id: 'Qwen/Qwen3-8B', ownedBy: 'system', created: '2026-07-27T00:00:00.000Z', object: 'model' },
      { id: 'b/m' },
    ]);
    expect(r.drift).toEqual([]);
  });

  it('reports drift instead of failing on an unexpected shape', () => {
    expect(parseTokenFactoryModels({ models: [] }).drift).toEqual(['response has no "data" list']);
    expect(parseTokenFactoryModels({ data: [{ name: 'x' }, { id: 'ok' }] })).toEqual({ models: [{ id: 'ok' }], drift: ['1 item(s) without an id were skipped'] });
  });
});

describe('Hugging Face', () => {
  it('keeps only the account fields the page needs from whoami-v2 (never the token or emails)', () => {
    const a = parseHfWhoami({
      type: 'user', name: 'someone', fullname: 'Some One', isPro: false, email: 'x@example.com', orgs: [{ name: 'o' }],
      auth: { type: 'access_token', accessToken: { displayName: 'portal', role: 'fineGrained', fineGrained: { canReadGatedRepos: true, scoped: [] } } },
    });
    expect(a).toEqual({ name: 'someone', type: 'user', isPro: false, orgs: 1, tokenName: 'portal', tokenRole: 'fineGrained', canReadGatedRepos: true });
    expect(JSON.stringify(a)).not.toMatch(/example\.com/);
  });

  it('reads gated status from the model API', () => {
    expect(parseHfModel({ id: 'a/b', gated: 'manual', private: false })).toEqual({ gated: 'manual', private: false });
    expect(parseHfModel({ id: 'a/b', gated: false })).toEqual({ gated: false, private: undefined });
    expect(parseHfModel({ id: 'a/b' })).toEqual({ gated: null, private: undefined });
  });

  it('maps the file probe status: 2xx/3xx accessible, 401/403 not, 404 missing', () => {
    expect(hfAccessFromStatus(200)).toBe(true);
    expect(hfAccessFromStatus(307)).toBe(true);
    expect(hfAccessFromStatus(401)).toBe(false);
    expect(hfAccessFromStatus(403)).toBe(false);
    expect(hfAccessFromStatus(404)).toBeNull();
  });
});

describe('Serverless lists read, partly read or unknown (F1.36)', () => {
  const cap = (id: string, state: string, perProject?: { id: string; state: string }[]) => ({ id, state, perProject }) as any;
  it('every list answered: all; none answered or not read yet: none; a mix: partial', () => {
    expect(serverlessListed([cap('ai.endpoints', 'ok'), cap('ai.jobs', 'ok')])).toBe('all');
    expect(serverlessListed([cap('ai.endpoints', 'unreachable'), cap('ai.jobs', 'unreachable')])).toBe('none');
    expect(serverlessListed([])).toBe('none');
    expect(serverlessListed([cap('ai.endpoints', 'ok'), cap('ai.jobs', 'error')])).toBe('partial');
    // One project of two answered: what was read is partial.
    expect(serverlessListed([cap('ai.endpoints', 'error', [{ id: 'project-e00mocka', state: 'ok' }, { id: 'project-e00mockb', state: 'unreachable' }]), cap('ai.jobs', 'ok')])).toBe('partial');
    expect(serverlessListed([cap('ai.endpoints', 'schema-drift'), cap('ai.jobs', 'ok')])).toBe('all');
  });
});
