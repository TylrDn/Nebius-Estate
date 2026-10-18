import { z } from 'zod';
import { CapabilityState } from '@internal/nebius-domain';
import { HttpError, MethodNotAllowedError, OriginNotAllowedError } from '../lib/http';
import { API_CONTRACTS } from './apiContracts';

type Json = Record<string, any>;

/**
 * Response checking against the documented contracts. Items are validated
 * with passthrough schemas (unknown fields are fine); what does not match is
 * reported as drift and the sync carries on with what it can read.
 */
const itemSchema = z.object({ metadata: z.object({ id: z.string().min(1) }).passthrough() }).passthrough();

/**
 * Lists whose items carry no metadata.id on the live API (verified 2026-10-11): their identity is
 * parent + name (+ region for quotas). For these, a missing id is the contract, not drift.
 */
const NAME_KEYED: Partial<Record<string, (item: Json) => string>> = {
  '/quotas/v1/quota-allowances': i => `${i.metadata?.parentId ?? ''}/${i.metadata?.name ?? ''}/${i.spec?.region ?? ''}`,
  '/capacity/v1/resource-advice': i => [i.spec?.region, i.spec?.fabric, i.spec?.computeInstance?.platform, i.spec?.computeInstance?.preset?.name].map(x => x ?? '').join('/'),
};
/** Name-keyed lists need the fields their key is made of. */
const KEY_SCHEMAS: Record<string, z.ZodTypeAny> = {
  '/quotas/v1/quota-allowances': z.object({ metadata: z.object({ name: z.string().min(1) }).passthrough() }).passthrough(),
  '/capacity/v1/resource-advice': z
    .object({ metadata: z.object({}).passthrough().optional(), spec: z.object({ region: z.string().min(1), computeInstance: z.object({ platform: z.string().min(1) }).passthrough() }).passthrough() })
    .passthrough(),
};

/** Nested enums the generator does not reach (status.<capacity type>.* of resource advice). */
const LEVELS = ['AVAILABILITY_LEVEL_UNSPECIFIED', 'AVAILABILITY_LEVEL_HIGH', 'AVAILABILITY_LEVEL_MEDIUM', 'AVAILABILITY_LEVEL_LOW', 'AVAILABILITY_LEVEL_LIMIT_REACHED', 'AVAILABILITY_LEVEL_UNKNOWN'];
const DATA_STATES = ['DATA_STATE_UNSPECIFIED', 'DATA_STATE_FRESH', 'DATA_STATE_STALE', 'DATA_STATE_UNKNOWN'];
const EXTRA_ENUMS: Record<string, Record<string, readonly string[]>> = {
  '/capacity/v1/resource-advice': Object.fromEntries(
    ['onDemand', 'preemptible', 'reserved'].flatMap(t => [
      [`status.${t}.availabilityLevel`, LEVELS],
      [`status.${t}.dataState`, DATA_STATES],
    ]),
  ),
};

const at = (o: Json, path: string): unknown => path.split('.').reduce<any>((v, k) => (v && typeof v === 'object' ? v[k] : undefined), o);

/** The items array of a list response, by its documented key. */
export function listItems(path: string, body: Json): { items: unknown[]; drift: string[] } {
  const key = API_CONTRACTS[path]?.listKey ?? 'items';
  const v = body?.[key];
  if (v === undefined) return { items: [], drift: [] }; // an empty list omits the field
  if (!Array.isArray(v)) return { items: [], drift: [`response field "${key}" is not a list`] };
  return { items: v, drift: [] };
}

export function checkItems(path: string, raw: unknown[]): { valid: Json[]; drift: string[] } {
  const valid: Json[] = [];
  const drift = new Set<string>();
  let skipped = 0;
  const enums = { ...(API_CONTRACTS[path]?.enums ?? {}), ...(EXTRA_ENUMS[path] ?? {}) };
  const keyOf = NAME_KEYED[path];
  for (const item of raw) {
    const r = (keyOf ? KEY_SCHEMAS[path] : itemSchema).safeParse(item);
    if (!r.success) {
      skipped++;
      continue;
    }
    const data = r.data as Json;
    // The key stands in for the id; `idFromKey` keeps "the API gave no id" knowable (quota placeholders).
    if (keyOf && !data.metadata?.id) data.metadata = { ...data.metadata, id: keyOf(data), idFromKey: true };
    for (const [field, values] of Object.entries(enums)) {
      const v = at(data, field);
      if (typeof v === 'string' && !values.includes(v)) drift.add(`${field}: undocumented value "${v.slice(0, 60)}"`);
    }
    valid.push(data);
  }
  if (skipped) drift.add(`${skipped} item(s) without ${keyOf ? 'their identifying fields' : 'metadata.id'} were skipped`);
  return { valid, drift: [...drift] };
}

/** Maps a failure to a capability state; never includes credentials (messages are already redacted). */
export function classify(e: unknown): { state: CapabilityState; status?: number } {
  if (e instanceof HttpError) {
    if (e.status === 401 || e.status === 403) return { state: 'permission-denied', status: e.status };
    if (e.status === 404) return { state: 'not-found', status: e.status };
    if (e.status === 400) return { state: 'rejected', status: e.status };
    return { state: 'unreachable', status: e.status };
  }
  if (e instanceof MethodNotAllowedError || e instanceof OriginNotAllowedError) return { state: 'rejected' };
  return { state: 'unreachable' };
}

/** The most actionable of several states (what the Integrations page should lead with). */
const RANK: CapabilityState[] = ['ok', 'not-configured', 'not-found', 'rejected', 'schema-drift', 'unreachable', 'permission-denied'];
export function worst(states: CapabilityState[]): CapabilityState {
  return states.reduce<CapabilityState>((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a), states.length ? 'ok' : 'not-configured');
}
