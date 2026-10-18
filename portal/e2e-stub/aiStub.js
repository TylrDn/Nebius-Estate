// TEST ONLY: Token Factory (/v1/models) and Hugging Face (whoami-v2, model API, file probe) in their
// documented shapes, with invented data. Bearer values are the placeholders set in playwright.config.ts.
const TF_KEY = 'e2e-tf-key';
const HF_TOKEN = 'e2e-hf-token';

const MODELS = {
  'Qwen/Qwen2.5-1.5B-Instruct': { gated: false, readable: true },
  'Qwen/Qwen2.5-7B-Instruct': { gated: false, readable: true },
  'mock-org/gated-model': { gated: 'manual', readable: false },
};

const bearer = headers => (headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '');

/** Answers an AI-services path, or undefined when the path is not one. */
function aiHandle(method, url, headers) {
  const p = url.pathname;
  if (p === '/v1/models') {
    if (bearer(headers) !== TF_KEY) return { status: 401, body: { detail: 'Invalid API key' } };
    return {
      status: 200,
      body: {
        object: 'list',
        data: [
          { id: 'mock-org/mock-chat-70b', object: 'model', created: 1785110400, owned_by: 'system' },
          { id: 'mock-org/mock-embed-8b', object: 'model', created: 1785196800, owned_by: 'system' },
          { id: 'mock-org/mock-vision-12b', object: 'model', created: 1785283200, owned_by: 'system' },
        ],
      },
    };
  }
  if (p === '/api/whoami-v2') {
    if (bearer(headers) !== HF_TOKEN) return { status: 401, body: { error: 'Invalid credentials in Authorization header' } };
    return { status: 200, body: { type: 'user', name: 'e2e-mock-user', isPro: false, orgs: [], auth: { type: 'access_token', accessToken: { displayName: 'portal-read', role: 'fineGrained', fineGrained: { canReadGatedRepos: true } } } } };
  }
  const model = /^\/api\/models\/(.+)$/.exec(p);
  if (model) {
    const m = MODELS[decodeURIComponent(model[1])];
    return m ? { status: 200, body: { id: decodeURIComponent(model[1]), gated: m.gated, private: false } } : { status: 404, body: { error: 'Repository not found' } };
  }
  const file = /^\/(.+)\/resolve\/main\/config\.json$/.exec(p);
  if (file && method === 'HEAD') {
    const m = MODELS[decodeURIComponent(file[1])];
    if (!m) return { status: 404, body: {} };
    if (bearer(headers) !== HF_TOKEN) return { status: 401, body: {} };
    return m.readable ? { status: 302, body: {} } : { status: 403, body: {} };
  }
  return undefined;
}

module.exports = { aiHandle, TF_KEY, HF_TOKEN };
