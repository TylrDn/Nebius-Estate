/**
 * The day-one setup checklist (W1-P25): connected, billing export, rate book or list price, budgets, labels,
 * Kubernetes access. Each item is to do, in progress or done (or not applicable), from what the portal reads, with the
 * page where the next step happens.
 */
import type { ConnectorStatus, ResourceView } from './api';
import { connectorState } from './connectors';

/** checking: a read the step needs has not answered yet; unavailable: it failed (not a refusal). Neither is counted. */
export type SetupState = 'done' | 'in-progress' | 'to-do' | 'not-applicable' | 'checking' | 'unavailable';

/**
 * A read the checklist needs that gave no value: still loading, refused for the caller's role (a 403), or failed for
 * another reason. Only a refusal says "Not readable with your role".
 */
export type Unread = { unread: 'loading' } | { unread: 'forbidden' } | { unread: 'error'; message: string };

export interface SetupItem {
  id: 'connected' | 'billing' | 'pricing' | 'budgets' | 'labels' | 'kubernetes';
  label: string;
  state: SetupState;
  detail: string;
  /** The portal page where the next step happens. */
  to: string;
  action: string;
}

export interface SetupInputs {
  statuses: Pick<ConnectorStatus, 'id' | 'state' | 'lastSuccess' | 'missingCoverage' | 'error' | 'calls' | 'notes'>[];
  /** Rate books stored. */
  rateBooks: number | Unread;
  budgets: { budgets: number; credits: number } | Unread;
  resources: { total: number; unattributed: number } | Unread;
}

/** A resource with no nip-* labels and nothing that explains it (a parent's labels, a platform default, a Nebius service). */
export const isUnattributed = (r: Pick<ResourceView, 'type' | 'attribution'>) => !r.attribution.attributed && !r.attribution.platformDefault && !r.attribution.managed && r.type !== 'project';

const SETUP_DOC = '/evidence?doc=docs%2Fportal%2Fnebius-setup.md';
const UNREADABLE = 'Not readable with your role.';
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isUnread = (x: unknown): x is Unread => typeof x === 'object' && x !== null && 'unread' in x;

/** The item for a read that gave no value; a refusal is to do (the caller cannot confirm it), loading and errors are not counted. */
function unreadItem(u: Unread, forbiddenDetail = UNREADABLE): { state: SetupState; detail: string } {
  if (u.unread === 'loading') return { state: 'checking', detail: 'Checking…' };
  if (u.unread === 'forbidden') return { state: 'to-do', detail: forbiddenDetail };
  return { state: 'unavailable', detail: `Unavailable: ${u.message}` };
}

/** "Day-one setup: 3 of 4 done · 2 checking": steps still loading or unavailable are named, never counted as to do. */
export function setupProgress(items: SetupItem[]): { done: number; of: number; checking: number; unavailable: number; title: string } {
  const counted = items.filter(i => i.state !== 'not-applicable' && i.state !== 'checking' && i.state !== 'unavailable');
  const done = counted.filter(i => i.state === 'done').length;
  const checking = items.filter(i => i.state === 'checking').length;
  const unavailable = items.filter(i => i.state === 'unavailable').length;
  const title = `Day-one setup: ${done} of ${counted.length} done${checking ? ` · ${checking} checking` : ''}${unavailable ? ` · ${unavailable} unavailable` : ''}`;
  return { done, of: counted.length, checking, unavailable, title };
}

export function setupChecklist(i: SetupInputs): SetupItem[] {
  const by = (id: string) => i.statuses.find(s => s.id === id);
  const inv = by('nebius-inventory');
  const view = inv ? connectorState(inv) : undefined;
  const connected: SetupItem = (() => {
    const base = { id: 'connected' as const, label: 'Connected to Nebius (read-only)' };
    if (!inv || inv.state === 'not-configured') return { ...base, state: 'to-do', detail: 'No project to read: set NEBIUS_PROJECT_IDS and the read-only identity.', to: `${SETUP_DOC}#read-only-nebius-identity`, action: 'Set up the identity' };
    if (inv.state === 'starting') return { ...base, state: 'in-progress', detail: 'The first sync is running.', to: '/integrations#connectors', action: 'Watch it on Integrations' };
    if (view?.state === 'ok') return { ...base, state: 'done', detail: 'The inventory syncs.', to: '/integrations#connectors', action: 'Integrations' };
    if (view?.state === 'partial') return { ...base, state: 'in-progress', detail: `Synced, with ${plural(view.refused, 'call')} refused: grant the role each refused call names.`, to: '/integrations?connectors=partial#connector-summary', action: 'See the refused calls' };
    return { ...base, state: inv.lastSuccess ? 'in-progress' : 'to-do', detail: `The inventory is ${view?.label ?? inv.state}.`, to: '/integrations#connectors', action: 'See the error on Integrations' };
  })();
  const billing: SetupItem = (() => {
    const b = by('billing-object-storage');
    const base = { id: 'billing' as const, label: 'Billing export', to: '/costs' };
    if (!b || b.state === 'not-configured') return { ...base, state: 'to-do', detail: 'Set up the periodic export pull, or import a FOCUS CSV on Costs.', action: 'Import on Costs' };
    if (b.state === 'ok' && !b.missingCoverage.length) return { ...base, state: 'done', detail: b.notes?.[0] ?? 'The export pull reads the bucket.', action: 'Costs' };
    return { ...base, state: 'in-progress', detail: b.missingCoverage[0] ?? `The export pull is ${b.state.replace(/-/g, ' ')}.`, to: '/integrations#connectors', action: 'See the export pull' };
  })();
  const pricing: SetupItem = (() => {
    const base = { id: 'pricing' as const, label: 'Rate book or list price', to: '/commercial?tab=ratebooks' };
    if (!isUnread(i.rateBooks) && i.rateBooks) return { ...base, state: 'done', detail: `${plural(i.rateBooks, 'rate book')} stored.`, action: 'Rate books' };
    if (by('nebius-pricing')?.state === 'ok') return { ...base, state: 'done', detail: 'Priced at the Nebius list price (live calculator); a rate book is optional.', action: 'Add a rate book' };
    if (isUnread(i.rateBooks)) return { ...base, ...unreadItem(i.rateBooks, `${UNREADABLE} The live calculator does not answer.`), action: 'Import or build a rate book' };
    return { ...base, state: 'to-do', detail: 'No rate book, and the live calculator does not answer.', action: 'Import or build a rate book' };
  })();
  const budgets: SetupItem = (() => {
    const base = { id: 'budgets' as const, label: 'Budgets', to: '/budgets' };
    if (isUnread(i.budgets)) return { ...base, ...unreadItem(i.budgets), action: 'Budgets & credits' };
    if (i.budgets.budgets) return { ...base, state: 'done', detail: `${plural(i.budgets.budgets, 'budget')} set.`, action: 'Budgets & credits' };
    if (i.budgets.credits) return { ...base, state: 'in-progress', detail: `${plural(i.budgets.credits, 'credit')} tracked, no budget yet.`, action: 'Add a budget' };
    return { ...base, state: 'to-do', detail: 'No budget: spend is not checked against an amount.', action: 'Add a budget' };
  })();
  const labels: SetupItem = (() => {
    const base = { id: 'labels' as const, label: 'Labels (nip-* attribution)', to: '/estate?view=unattributed', action: 'See unattributed resources' };
    if (isUnread(i.resources)) return { ...base, ...unreadItem(i.resources) };
    if (!i.resources.total) return { ...base, state: 'not-applicable', detail: 'Nothing in the inventory yet.' };
    if (!i.resources.unattributed) return { ...base, state: 'done', detail: `Every one of ${plural(i.resources.total, 'resource')} is attributed.` };
    return { ...base, state: 'in-progress', detail: `${i.resources.unattributed} of ${plural(i.resources.total, 'resource')} carry no nip-* labels and no parent or service that explains them.` };
  })();
  const kubernetes: SetupItem = (() => {
    const k = i.statuses.filter(s => s.id.startsWith('mk8s:') || s.id === 'kubernetes' || s.id.startsWith('kubernetes:'));
    const base = { id: 'kubernetes' as const, label: 'Kubernetes access', to: '/integrations#connectors', action: 'Kubernetes on Integrations' };
    const live = k.filter(s => s.state !== 'disabled' && s.state !== 'optional' && s.state !== 'not-needed');
    if (!live.length) return { ...base, state: 'not-applicable', detail: 'No Managed Kubernetes cluster in the listed projects.' };
    const ok = live.filter(s => s.state === 'ok').length;
    if (ok) return { ...base, state: 'done', detail: `${ok} of ${plural(live.length, 'cluster')} connected.` };
    if (live.some(s => s.state === 'waiting' || s.state === 'starting')) return { ...base, state: 'in-progress', detail: 'A cluster is not ready yet: connected automatically once RUNNING.' };
    return { ...base, state: 'to-do', detail: 'No cluster answers: see its connector.' };
  })();
  return [connected, billing, pricing, budgets, labels, kubernetes];
}
