import type { ConnectorStatus } from './api';
import { isUnattributed, setupChecklist, setupProgress } from './setup';

const st = (id: string, state: ConnectorStatus['state'], over: Partial<ConnectorStatus> = {}) => ({ id, state, missingCoverage: [], ...over } as ConnectorStatus);
const day0 = { statuses: [st('nebius-inventory', 'not-configured'), st('billing-object-storage', 'not-configured'), st('nebius-pricing', 'not-configured')], rateBooks: 0, budgets: { budgets: 0, credits: 0 }, resources: { total: 0, unattributed: 0 } };

describe('the day-one setup checklist (W1-P25)', () => {
  it('a new deployment: everything to do, Kubernetes not applicable without a cluster, each with where to do it', () => {
    const items = setupChecklist(day0);
    expect(items.map(i => [i.id, i.state])).toEqual([
      ['connected', 'to-do'],
      ['billing', 'to-do'],
      ['pricing', 'to-do'],
      ['budgets', 'to-do'],
      ['labels', 'not-applicable'],
      ['kubernetes', 'not-applicable'],
    ]);
    expect(items.find(i => i.id === 'billing')!.to).toBe('/costs');
    expect(items.find(i => i.id === 'pricing')!.to).toBe('/commercial?tab=ratebooks');
    expect(items.find(i => i.id === 'budgets')!.to).toBe('/budgets');
    for (const i of items) expect(i.to).toMatch(/^\//);
  });

  it('in progress: a partial sync, an export with no file yet, credits without a budget, unlabelled resources, a cluster still provisioning', () => {
    const items = setupChecklist({
      statuses: [
        st('nebius-inventory', 'permission-denied', { lastSuccess: '2026-10-13T10:00:00Z', missingCoverage: ['Networks (permission denied)'] }),
        st('billing-object-storage', 'ok', { missingCoverage: ['No export files yet: enable Billing → Export → Periodic export to b in the Nebius console.'] }),
        st('nebius-pricing', 'error'),
        st('mk8s:mk8scluster-e00mockx', 'waiting'),
      ],
      rateBooks: 0,
      budgets: { budgets: 0, credits: 1 },
      resources: { total: 40, unattributed: 6 },
    });
    expect(Object.fromEntries(items.map(i => [i.id, i.state]))).toEqual({ connected: 'in-progress', billing: 'in-progress', pricing: 'to-do', budgets: 'in-progress', labels: 'in-progress', kubernetes: 'in-progress' });
    expect(items.find(i => i.id === 'connected')!.detail).toBe('Synced, with 1 call refused: grant the role each refused call names.');
    expect(items.find(i => i.id === 'labels')!.detail).toBe('6 of 40 resources carry no nip-* labels and no parent or service that explains them.');
    expect(items.find(i => i.id === 'labels')!.to).toBe('/estate?view=unattributed');
  });

  it('done: synced, export imported, list price (a rate book is optional), a budget, every resource attributed, a cluster connected', () => {
    const items = setupChecklist({
      statuses: [st('nebius-inventory', 'ok', { lastSuccess: 'x' }), st('billing-object-storage', 'ok', { notes: ['Last import: a.csv.gz (2026-10), 3 rows'] }), st('nebius-pricing', 'ok'), st('mk8s:a', 'ok'), st('mk8s:b', 'waiting')],
      rateBooks: 0,
      budgets: { budgets: 2, credits: 0 },
      resources: { total: 10, unattributed: 0 },
    });
    expect(items.every(i => i.state === 'done')).toBe(true);
    expect(items.find(i => i.id === 'pricing')!.detail).toBe('Priced at the Nebius list price (live calculator); a rate book is optional.');
    expect(items.find(i => i.id === 'billing')!.detail).toBe('Last import: a.csv.gz (2026-10), 3 rows');
  });

  it('what the caller is refused (403) is said as not readable, never guessed as done', () => {
    const forbidden = { unread: 'forbidden' } as const;
    const items = setupChecklist({ ...day0, rateBooks: forbidden, budgets: forbidden, resources: forbidden });
    expect(items.find(i => i.id === 'budgets')).toMatchObject({ state: 'to-do', detail: 'Not readable with your role.' });
    expect(items.find(i => i.id === 'labels')).toMatchObject({ state: 'to-do', detail: 'Not readable with your role.' });
    expect(items.find(i => i.id === 'pricing')).toMatchObject({ state: 'to-do', detail: 'Not readable with your role. The live calculator does not answer.' });
  });

  it('a read still loading is checking, not to do, and left out of the done count; no role problem is claimed', () => {
    const loading = { unread: 'loading' } as const;
    const items = setupChecklist({ ...day0, rateBooks: loading, budgets: loading, resources: loading });
    for (const id of ['pricing', 'budgets', 'labels']) expect(items.find(i => i.id === id)).toMatchObject({ state: 'checking', detail: 'Checking…' });
    expect(JSON.stringify(items)).not.toContain('Not readable');
    expect(setupProgress(items)).toEqual({ done: 0, of: 2, checking: 3, unavailable: 0, title: 'Day-one setup: 0 of 2 done · 3 checking' });
  });

  it('a read that failed (a 500) states its error as unavailable, never as a role problem, and is not counted', () => {
    const items = setupChecklist({ ...day0, budgets: { unread: 'error', message: '500 Internal Server Error' } });
    expect(items.find(i => i.id === 'budgets')).toMatchObject({ state: 'unavailable', detail: 'Unavailable: 500 Internal Server Error' });
    expect(setupProgress(items)).toMatchObject({ done: 0, of: 3, unavailable: 1, title: 'Day-one setup: 0 of 3 done · 1 unavailable' });
  });

  it('the list price answers: pricing is done whatever the rate book read says', () => {
    const items = setupChecklist({ ...day0, statuses: [...day0.statuses.slice(0, 2), st('nebius-pricing', 'ok')], rateBooks: { unread: 'loading' } });
    expect(items.find(i => i.id === 'pricing')!.state).toBe('done');
  });

  it('isUnattributed: projects, platform defaults and service-managed resources are not unattributed', () => {
    const r = (a: object, type = 'compute.instance') => ({ type, attribution: { attributed: false, platformDefault: false, ...a } } as any);
    expect(isUnattributed(r({}))).toBe(true);
    expect(isUnattributed(r({ attributed: true }))).toBe(false);
    expect(isUnattributed(r({ platformDefault: true }))).toBe(false);
    expect(isUnattributed(r({ managed: 'Managed Kubernetes' }))).toBe(false);
    expect(isUnattributed(r({}, 'project'))).toBe(false);
  });
});
