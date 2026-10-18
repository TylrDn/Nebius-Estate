import {
  AiCheckState,
  CapabilityStatus,
  ConnectorStatus,
  HfModelCheck,
  hfAccessFromStatus,
  HuggingFaceView,
  parseHfModel,
  parseHfWhoami,
  parseTokenFactoryModels,
  TOKEN_FACTORY_CONSOLE,
  TokenFactoryView,
} from '@internal/nebius-domain';
import { FetchFn, HttpClient, redact } from '../lib/http';
import { classify } from '../inventory/contract';
import { ExtensionPatch, SyncExtension } from '../inventory/extension';
import { AiConfig } from './config';

/** Verified with a real key and token on this date (read-only GETs and a HEAD; no weights downloaded). */
export const AI_VERIFIED = '2026-10-11';

const USAGE_NOTE = 'Usage and balance: console only. Token Factory has no usage or balance API (/v1/usage and /v1/billing answer 404, checked 2026-10-11); enter its spend on Budgets & credits.';

export interface AiServicesOptions {
  /** Hugging Face repos the workloads reference (read from the repository each sync). */
  modelRefs: () => Promise<{ repo: string; usedBy: string[] }[]>;
  fetch?: FetchFn;
  env?: NodeJS.ProcessEnv;
  maxRetries?: number;
}

type Patch = ExtensionPatch;

/**
 * Token Factory and Hugging Face checks on the inventory's sync loop (a SyncExtension): the results are
 * cached until the next sync (one sync interval), health is recorded in the HealthStore as the
 * connectors `token-factory` and `huggingface`, and the key and token stay in the backend environment.
 * Read-only: GETs and one HEAD per model file; never a download.
 */
export class AiServices implements SyncExtension {
  private tf: TokenFactoryView;
  private hf: HuggingFaceView;

  constructor(private readonly cfg: AiConfig, private readonly opts: AiServicesOptions) {
    this.tf = { state: this.tfKey() ? 'not-checked' : 'not-configured', keyConfigured: Boolean(this.tfKey()), keyValid: null, models: [], usageNote: USAGE_NOTE, consoleUrl: TOKEN_FACTORY_CONSOLE, hint: this.tfKey() ? undefined : this.tfSetupHint() };
    this.hf = { state: this.hfToken() ? 'not-checked' : 'not-configured', tokenConfigured: Boolean(this.hfToken()), tokenValid: null, models: [], hint: this.hfToken() ? undefined : this.hfSetupHint() };
  }

  private get env() {
    return this.opts.env ?? process.env;
  }

  private tfKey() {
    return this.cfg.tokenFactory ? this.env[this.cfg.tokenFactory.apiKeyEnv] || undefined : undefined;
  }

  private hfToken() {
    return this.cfg.huggingface ? this.env[this.cfg.huggingface.tokenEnv] || undefined : undefined;
  }

  private tfSetupHint() {
    return this.cfg.tokenFactory
      ? `Set ${this.cfg.tokenFactory.apiKeyEnv} in the backend environment (.env) to a Token Factory API key (Token Factory console → API keys; docs/credentials.md#other-slots).`
      : 'Not set up: add nebiusEstate.ai.tokenFactory.apiKeyEnv (e.g. NEBIUS_API_KEY) to the portal configuration (docs/portal/billing-and-pricing.md#ai-services).';
  }

  private hfSetupHint() {
    return this.cfg.huggingface
      ? `Set ${this.cfg.huggingface.tokenEnv} in the backend environment (.env) to a read-only Hugging Face token (docs/credentials.md#other-slots).`
      : 'Not set up: add nebiusEstate.ai.huggingface.tokenEnv (e.g. HF_TOKEN) to the portal configuration (docs/portal/billing-and-pricing.md#ai-services).';
  }

  views(): { tokenFactory: TokenFactoryView; huggingface: HuggingFaceView } {
    return { tokenFactory: this.tf, huggingface: this.hf };
  }

  definitions(): ConnectorStatus[] {
    const stale = this.cfg.syncIntervalMinutes * 3;
    return [
      {
        id: 'token-factory', title: 'Token Factory (models, key health)', state: this.tfKey() ? 'starting' : 'not-configured',
        scope: this.cfg.tokenFactory ? `API key in ${this.cfg.tokenFactory.apiKeyEnv}` : '—', permissions: 'a Token Factory API key (lists models; creates nothing)',
        services: ['GET /v1/models'], staleAfterMinutes: stale,
        missingCoverage: this.tfKey() ? ['Usage and balance: console only (no API)'] : [this.tfSetupHint()], setup: 'docs/credentials.md#other-slots',
      },
      {
        id: 'huggingface', title: 'Hugging Face (token, gated access)', state: this.hfToken() ? 'starting' : 'not-configured',
        scope: this.cfg.huggingface ? `token in ${this.cfg.huggingface.tokenEnv}` : '—', permissions: 'a read-only Hugging Face token (fine-grained: read access to gated repos)',
        services: ['GET /api/whoami-v2', 'GET /api/models/<repo>', 'HEAD <repo>/resolve/main/config.json'], staleAfterMinutes: stale,
        missingCoverage: this.hfToken() ? [] : [this.hfSetupHint()], setup: 'docs/credentials.md#other-slots',
      },
    ];
  }

  async sync(attempt: string, only?: string): Promise<{ statuses: Patch[]; capabilities: CapabilityStatus[] }> {
    // Each connector is timed and fails on its own (G1.7): one slow or broken service never colours the other.
    const run = async (id: string, f: () => Promise<{ status: Patch; capabilities: CapabilityStatus[] }>) => {
      const t0 = performance.now();
      try {
        const r = await f();
        return { status: { ...r.status, durationMs: performance.now() - t0 }, capabilities: r.capabilities };
      } catch (e) {
        return { status: { id, state: 'error' as const, error: redact((e as Error).message).slice(0, 300), durationMs: performance.now() - t0 }, capabilities: [] };
      }
    };
    const runs = await Promise.all([
      !only || only === 'token-factory' ? run('token-factory', () => this.syncTokenFactory(attempt)) : undefined,
      !only || only === 'huggingface' ? run('huggingface', () => this.syncHuggingFace(attempt)) : undefined,
    ]);
    const done = runs.filter((r): r is NonNullable<typeof r> => Boolean(r));
    return { statuses: done.map(r => r.status), capabilities: done.flatMap(r => r.capabilities) };
  }

  private client(origin: string, secret: string, head = false) {
    return new HttpClient({ allowedOrigins: [origin], timeoutMs: this.cfg.timeoutMs, fetch: this.opts.fetch, authorization: async () => `Bearer ${secret}`, maxRetries: this.opts.maxRetries ?? 2, allowHead: head });
  }

  /* ------------------------------------------------------------ Token Factory */

  private async syncTokenFactory(attempt: string): Promise<{ status: Patch; capabilities: CapabilityStatus[] }> {
    const base = { id: 'tokenfactory.models', title: 'Token Factory models', service: 'ai', connector: 'token-factory' as const, scope: 'tenant' as const, path: '/v1/models', method: 'GET' as const, verified: AI_VERIFIED };
    const key = this.tfKey();
    if (!key || !this.cfg.tokenFactory) {
      const hint = this.tfSetupHint();
      this.tf = { ...this.tf, state: 'not-configured', keyConfigured: false, keyValid: null, lastCheck: attempt, hint };
      return { status: { id: 'token-factory', state: 'not-configured', error: hint }, capabilities: [{ ...base, state: 'not-configured', lastAttempt: attempt, hint }] };
    }
    const started = Date.now();
    try {
      const body = await this.client(this.cfg.tokenFactory.endpoint, key).request<unknown>(`${this.cfg.tokenFactory.endpoint}/v1/models`);
      const { models, drift } = parseTokenFactoryModels(body);
      const state: AiCheckState = drift.length && !models.length ? 'schema-drift' : 'ok';
      this.tf = { ...this.tf, state, keyConfigured: true, keyValid: true, models, lastCheck: attempt, lastSuccess: attempt, stale: false, error: undefined, drift, hint: undefined };
      return {
        status: { id: 'token-factory', state: 'ok', lastSuccess: attempt, error: drift.length ? drift.join('; ') : undefined, missingCoverage: ['Usage and balance: console only (no API)'] },
        capabilities: [{ ...base, state: drift.length ? 'schema-drift' : 'ok', items: models.length, latencyMs: Date.now() - started, lastAttempt: attempt, lastSuccess: attempt, drift }],
      };
    } catch (e) {
      const c = classify(e);
      const message = redact((e as Error).message).slice(0, 300);
      const refused = c.state === 'permission-denied';
      const hint = refused
        ? `The key in ${this.cfg.tokenFactory.apiKeyEnv} was refused (${c.status}): create a new key in Token Factory → API keys and replace it in .env.`
        : `Token Factory did not answer (${message}); the last good model list is kept and the check runs again next sync.`;
      // Last good models stay on screen, marked stale; a refused key is not "valid" any more.
      this.tf = { ...this.tf, state: refused ? 'invalid-credential' : 'unreachable', keyConfigured: true, keyValid: refused ? false : this.tf.keyValid, lastCheck: attempt, stale: this.tf.models.length > 0, error: message, hint };
      return {
        status: { id: 'token-factory', state: 'error', error: hint },
        capabilities: [{ ...base, state: c.state, latencyMs: Date.now() - started, lastAttempt: attempt, lastError: message, hint }],
      };
    }
  }

  /* ------------------------------------------------------------- Hugging Face */

  private async syncHuggingFace(attempt: string): Promise<{ status: Patch; capabilities: CapabilityStatus[] }> {
    const base = { service: 'ai', connector: 'huggingface' as const, scope: 'tenant' as const, method: 'GET' as const, verified: AI_VERIFIED };
    const refs = await this.opts.modelRefs().catch(() => []);
    const token = this.hfToken();
    if (!token || !this.cfg.huggingface) {
      const hint = this.hfSetupHint();
      this.hf = {
        ...this.hf, state: 'not-configured', tokenConfigured: false, tokenValid: null, lastCheck: attempt, hint,
        models: refs.map(r => ({ ...r, gated: null, accessible: null, note: 'Not checked: no Hugging Face token configured.' })),
      };
      return {
        status: { id: 'huggingface', state: 'not-configured', error: hint },
        capabilities: [
          { ...base, id: 'huggingface.whoami', title: 'Hugging Face token (whoami-v2)', path: '/api/whoami-v2', state: 'not-configured', lastAttempt: attempt, hint },
          { ...base, id: 'huggingface.models', title: 'Hugging Face gated access per workload model', path: '/api/models/<repo>, HEAD /<repo>/resolve/main/config.json', state: 'not-configured', lastAttempt: attempt, hint },
        ],
      };
    }
    const origin = this.cfg.huggingface.endpoint;
    const http = this.client(origin, token, true);
    const started = Date.now();
    const whoamiCap = { ...base, id: 'huggingface.whoami', title: 'Hugging Face token (whoami-v2)', path: '/api/whoami-v2' };
    let account: HuggingFaceView['account'];
    try {
      account = parseHfWhoami(await http.request<unknown>(`${origin}/api/whoami-v2`));
    } catch (e) {
      const c = classify(e);
      const message = redact((e as Error).message).slice(0, 300);
      const refused = c.state === 'permission-denied';
      const hint = refused
        ? `The token in ${this.cfg.huggingface.tokenEnv} was refused (${c.status}): create a new read-only token at huggingface.co → Settings → Access Tokens and replace it in .env.`
        : `Hugging Face did not answer (${message}); the last results are kept and the check runs again next sync.`;
      this.hf = { ...this.hf, state: refused ? 'invalid-credential' : 'unreachable', tokenConfigured: true, tokenValid: refused ? false : this.hf.tokenValid, lastCheck: attempt, stale: this.hf.models.length > 0, error: message, hint };
      return { status: { id: 'huggingface', state: 'error', error: hint }, capabilities: [{ ...whoamiCap, state: c.state, latencyMs: Date.now() - started, lastAttempt: attempt, lastError: message, hint }] };
    }
    const whoamiMs = Date.now() - started;

    const modelsStarted = Date.now();
    const max = this.cfg.huggingface.maxModels;
    const checks: HfModelCheck[] = [];
    let failures = 0;
    for (const ref of refs.slice(0, max)) {
      try {
        checks.push(await this.checkModel(http, origin, ref, account));
      } catch (e) {
        failures++;
        checks.push({ ...ref, gated: null, accessible: null, note: `Not checked: ${redact((e as Error).message).slice(0, 160)}` });
      }
    }
    const skipped = refs.length - checks.length;
    const notChecked = refs.slice(max).map(r => ({ ...r, gated: null, accessible: null, note: `Not checked: more than ${max} models (nebiusEstate.ai.huggingface.maxModels).` }));
    const blocked = checks.filter(c => c.accessible === false);
    this.hf = {
      ...this.hf, state: 'ok', tokenConfigured: true, tokenValid: true, account, models: [...checks, ...notChecked], lastCheck: attempt, lastSuccess: attempt, stale: false, error: undefined,
      hint: blocked.length ? `${blocked.length} model(s) are gated and this token cannot read them: request access on each model page with the account that owns the token.` : undefined,
    };
    return {
      status: {
        id: 'huggingface', state: 'ok', lastSuccess: attempt,
        error: failures ? `${failures} model check(s) failed` : undefined,
        missingCoverage: [...(blocked.length ? [`No access to gated: ${blocked.map(b => b.repo).join(', ')}`] : []), ...(skipped ? [`${skipped} model(s) not checked (limit ${max})`] : [])],
      },
      capabilities: [
        { ...whoamiCap, state: 'ok', items: 1, latencyMs: whoamiMs, lastAttempt: attempt, lastSuccess: attempt },
        {
          ...base, id: 'huggingface.models', title: 'Hugging Face gated access per workload model', path: '/api/models/<repo>, HEAD /<repo>/resolve/main/config.json',
          state: failures && failures === checks.length && checks.length ? 'unreachable' : 'ok', items: checks.length, latencyMs: Date.now() - modelsStarted, lastAttempt: attempt,
          lastSuccess: failures && failures === checks.length && checks.length ? undefined : attempt, lastError: failures ? `${failures} of ${checks.length} model checks failed` : undefined,
          hint: refs.length ? undefined : 'No Hugging Face model ids found in workloads/inference/overlays, recipes/serverless or platform/versions.yaml.',
        },
      ],
    };
  }

  /** Gated status from the model API, then a HEAD of one small file with the token (never the weights). */
  private async checkModel(http: HttpClient, origin: string, ref: { repo: string; usedBy: string[] }, account: HuggingFaceView['account']): Promise<HfModelCheck> {
    const path = ref.repo.split('/').map(encodeURIComponent).join('/');
    const meta = parseHfModel(await http.request<unknown>(`${origin}/api/models/${path}`));
    const status = await http.head(`${origin}/${path}/resolve/main/config.json`);
    const accessible = hfAccessFromStatus(status);
    const note =
      accessible === null
        ? `Access unknown: the file probe answered ${status}${status === 404 ? ' (no config.json at main)' : ''}.`
        : accessible
          ? meta.gated
            ? 'Gated; this token has access.'
            : 'Open model; readable with this token.'
          : meta.gated
            ? `Gated (${meta.gated} approval); this token has no access: request it on https://huggingface.co/${ref.repo}${account?.canReadGatedRepos === false ? ', and allow "read access to public gated repos" on the fine-grained token' : ''}.`
            : 'Not readable with this token (private or restricted repository).';
    return { ...ref, gated: meta.gated, private: meta.private, accessible, status, note };
  }
}
