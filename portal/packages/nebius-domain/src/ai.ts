import type { CapabilityStatus } from './api';
/**
 * AI services (OPERATE → AI services): Token Factory and Hugging Face, read through the backend only.
 *
 * - Token Factory: `GET https://api.tokenfactory.nebius.com/v1/models` (OpenAI-compatible) with the
 *   NEBIUS_API_KEY bearer key. There is no usage or balance API (`/v1/usage`, `/v1/billing` answer 404,
 *   2026-10-11): usage and balance stay in the Token Factory console.
 * - Hugging Face: `GET /api/whoami-v2` checks the token; per model the workloads use,
 *   `GET /api/models/<repo>` gives the gated status and a HEAD of `<repo>/resolve/main/config.json`
 *   with the token says whether it can be read (401/403: no access). Weights are never downloaded.
 */

export const TOKEN_FACTORY_API = 'https://api.tokenfactory.nebius.com';
export const TOKEN_FACTORY_CONSOLE = 'https://tokenfactory.nebius.com';
export const HUGGING_FACE = 'https://huggingface.co';

export interface TokenFactoryModel {
  id: string;
  ownedBy?: string;
  /** ISO time from the `created` epoch seconds. */
  created?: string;
  object?: string;
}

export type AiCheckState = 'ok' | 'not-configured' | 'invalid-credential' | 'unreachable' | 'schema-drift' | 'not-checked';

export interface TokenFactoryView {
  state: AiCheckState;
  keyConfigured: boolean;
  /** null until checked. */
  keyValid: boolean | null;
  models: TokenFactoryModel[];
  lastCheck?: string;
  lastSuccess?: string;
  /** Data kept from the last success while the latest check failed. */
  stale?: boolean;
  error?: string;
  drift?: string[];
  /** What to do about the current state. */
  hint?: string;
  usageNote: string;
  consoleUrl: string;
}

export interface HfAccount {
  name?: string;
  type?: string;
  isPro?: boolean;
  orgs?: number;
  tokenName?: string;
  tokenRole?: string;
  canReadGatedRepos?: boolean;
}

export interface HfModelCheck {
  repo: string;
  /** Repository files that reference it. */
  usedBy: string[];
  /** 'auto' | 'manual' when gated, false when open, null when not read. */
  gated: 'auto' | 'manual' | false | null;
  private?: boolean;
  /** Whether the token can read the repo's files; null when unknown. */
  accessible: boolean | null;
  status?: number;
  note: string;
}

export interface HuggingFaceView {
  state: AiCheckState;
  tokenConfigured: boolean;
  tokenValid: boolean | null;
  account?: HfAccount;
  models: HfModelCheck[];
  lastCheck?: string;
  lastSuccess?: string;
  stale?: boolean;
  error?: string;
  hint?: string;
}

export interface AiServicesResponse {
  tokenFactory: TokenFactoryView;
  huggingface: HuggingFaceView;
  /** Serverless AI endpoints and jobs from the inventory (Nebius REST lists). */
  serverless: {
    endpoints: { uid: string; name: string; projectId?: string; region?: string; status: string; platform?: string; preset?: string }[];
    jobs: { uid: string; name: string; projectId?: string; region?: string; status: string; platform?: string; preset?: string }[];
    observedAt?: string;
    /** Why the lists are missing or partial (capability state of the inventory calls). */
    note?: string;
    /** Whether the lists answered: every one, some (by list or project), or none; empty lists read as "unknown" unless all (F1.36). */
    listed: ServerlessListed;
  };
  /** Container registries and Managed MLflow clusters from the inventory (followup 20), with their Explorer uids. */
  mlServices: {
    registries: { uid: string; name: string; projectId?: string; region?: string; status: string; detail?: string }[];
    mlflow: { uid: string; name: string; projectId?: string; region?: string; status: string; detail?: string }[];
    /** The lists' own read time (the older of the two). */
    observedAt?: string;
    note?: string;
    listed: ServerlessListed;
  };
  /** Checks are cached for one sync interval. */
  syncIntervalMinutes: number;
}

export type ServerlessListed = 'all' | 'partial' | 'none';

/** Whether the Serverless endpoint and job lists answered (state ok or schema drift), in whole, in part or not at all. */
export function serverlessListed(caps: Pick<CapabilityStatus, 'state' | 'perProject'>[]): ServerlessListed {
  const ok = (state: string) => state === 'ok' || state === 'schema-drift';
  if (caps.length && caps.every(c => ok(c.state))) return 'all';
  return caps.some(c => ok(c.state) || c.perProject?.some(p => ok(p.state))) ? 'partial' : 'none';
}

/** Hugging Face repo ids referenced by the workloads and recipes, with where each is used. */
export function extractModelRefs(files: { path: string; text: string }[]): { repo: string; usedBy: string[] }[] {
  const repo = '([A-Za-z0-9][A-Za-z0-9_.-]{0,95}/[A-Za-z0-9][A-Za-z0-9_.-]{0,95})';
  const patterns = [new RegExp(`MODEL\\s*=\\s*["']?(?:\\$\\{MODEL:-)?${repo}`, 'g'), new RegExp(`huggingface\\.co/${repo}`, 'g')];
  const out = new Map<string, Set<string>>();
  for (const f of files) {
    for (const p of patterns) {
      for (const m of f.text.matchAll(p)) {
        const id = m[1].replace(/\.git$/, '');
        const set = out.get(id) ?? new Set<string>();
        set.add(f.path);
        out.set(id, set);
      }
    }
  }
  // G3.17: a kustomization built on a sibling overlay (`resources: - ../<overlay>`) pulls that overlay's models, unless
  // it names a model of its own. One level, as the repository's overlays use it.
  const own = (path: string) => [...out.values()].some(set => set.has(path));
  for (const f of files) {
    if (!/\/kustomization\.ya?ml$/.test(f.path) || own(f.path)) continue;
    const dir = f.path.replace(/\/[^/]+$/, '');
    for (const m of f.text.matchAll(/^\s*-\s*\.\.\/([A-Za-z0-9_.-]+)\/?\s*$/gm)) {
      const base = files.find(b => b.path.replace(/\/[^/]+$/, '') === `${dir.replace(/\/[^/]+$/, '')}/${m[1]}` && /\/kustomization\.ya?ml$/.test(b.path));
      if (!base) continue;
      for (const set of out.values()) if (set.has(base.path)) set.add(f.path);
    }
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, paths]) => ({ repo: id, usedBy: [...paths].sort() }));
}

/** The OpenAI-compatible model list: `{ object: 'list', data: [{ id, object, created, owned_by }] }`. */
export function parseTokenFactoryModels(body: unknown): { models: TokenFactoryModel[]; drift: string[] } {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return { models: [], drift: ['response has no "data" list'] };
  const models: TokenFactoryModel[] = [];
  let skipped = 0;
  for (const item of data) {
    const i = item as Record<string, unknown>;
    if (!i || typeof i.id !== 'string' || !i.id) {
      skipped++;
      continue;
    }
    models.push({
      id: i.id,
      ...(typeof i.owned_by === 'string' ? { ownedBy: i.owned_by } : {}),
      ...(typeof i.created === 'number' && Number.isFinite(i.created) ? { created: new Date(i.created * 1000).toISOString() } : {}),
      ...(typeof i.object === 'string' ? { object: i.object } : {}),
    });
  }
  return { models, drift: skipped ? [`${skipped} item(s) without an id were skipped`] : [] };
}

/** Account fields shown on the page; the token itself, ids and emails are dropped. */
export function parseHfWhoami(body: unknown): HfAccount {
  const b = (body ?? {}) as Record<string, any>;
  const token = b.auth?.accessToken ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    name: str(b.name),
    type: str(b.type),
    isPro: typeof b.isPro === 'boolean' ? b.isPro : undefined,
    orgs: Array.isArray(b.orgs) ? b.orgs.length : undefined,
    tokenName: str(token.displayName),
    tokenRole: str(token.role),
    canReadGatedRepos: typeof token.fineGrained?.canReadGatedRepos === 'boolean' ? token.fineGrained.canReadGatedRepos : undefined,
  };
}

export function parseHfModel(body: unknown): { gated: HfModelCheck['gated']; private?: boolean } {
  const b = (body ?? {}) as Record<string, unknown>;
  const gated = b.gated === 'auto' || b.gated === 'manual' ? b.gated : b.gated === false ? false : null;
  return { gated, private: typeof b.private === 'boolean' ? b.private : undefined };
}

/** A HEAD of a repo file with the token: 2xx/3xx (redirect to the CDN) can read, 401/403 cannot, anything else unknown. */
export function hfAccessFromStatus(status: number): boolean | null {
  if (status >= 200 && status < 400) return true;
  if (status === 401 || status === 403) return false;
  return null;
}
