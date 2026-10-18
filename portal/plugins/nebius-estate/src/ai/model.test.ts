import { accessBadge, checkBadge, createdSortValue, createdText, serverlessEmpty } from './model';

describe('AI services page model', () => {
  it('says what each check state means', () => {
    expect(checkBadge('ok')).toEqual({ tone: 'ok', label: 'connected' });
    expect(checkBadge('not-configured')).toEqual({ tone: 'neutral', label: 'not configured' });
    expect(checkBadge('invalid-credential')).toEqual({ tone: 'danger', label: 'refused' });
    expect(checkBadge('unreachable', true)).toEqual({ tone: 'warn', label: 'unreachable · showing last good data' });
    expect(checkBadge('not-checked')).toEqual({ tone: 'neutral', label: 'first check pending' });
  });

  it('labels gated access per model', () => {
    expect(accessBadge({ gated: false, accessible: true })).toEqual({ tone: 'ok', label: 'open · readable' });
    expect(accessBadge({ gated: 'manual', accessible: true })).toEqual({ tone: 'ok', label: 'gated · access granted' });
    expect(accessBadge({ gated: 'auto', accessible: false })).toEqual({ tone: 'danger', label: 'gated · no access' });
    expect(accessBadge({ gated: null, accessible: null })).toEqual({ tone: 'neutral', label: 'not checked' });
  });

  it('shows "not reported" for a Token Factory model whose created time is just the fetch time echoed back', () => {
    const fetched = '2026-10-11T10:26:17.420Z';
    expect(createdText('2026-10-11T10:26:02.000Z', fetched)).toBe('not reported');
    expect(createdText('2026-07-27T00:00:00.000Z', fetched)).toBe('2026-07-27');
    expect(createdText(undefined, fetched)).toBe('not reported');
    expect(createdText('2026-10-11T10:26:02.000Z', undefined)).toBe('2026-10-11');
  });
});

describe('an empty Serverless list says what is known (F1.36)', () => {
  it('unreachable lists are "unknown", never "None in the listed projects"', () => {
    const e = serverlessEmpty({ listed: 'none', note: 'Serverless endpoints: unreachable' });
    expect(e.title).toBe('Serverless endpoints and jobs: unknown');
    expect(e.text).toBe('Not read: Serverless endpoints: unreachable. They show here once the lists answer (Integrations).');
    expect(`${e.title} ${e.text}`).not.toMatch(/None in the listed projects/);
  });
  it('partly read: none found where read, and what was not read', () => {
    expect(serverlessEmpty({ listed: 'partial', note: 'Serverless jobs: error' })).toEqual({ title: 'None found where the lists answered', text: 'Not every list or project answered (Serverless jobs: error), so some may be missing.' });
  });
  it('every list answered: none in the listed projects', () => {
    expect(serverlessEmpty({ listed: 'all' })).toEqual({ title: 'No Serverless endpoints or jobs', text: 'None in the listed projects (Nebius Serverless AI lists).' });
  });
});

describe('Token Factory created sort (G3.16)', () => {
  it('sorts a model whose created time is only the request echoed back as unknown, below every real date', () => {
    const fetched = '2026-10-12T15:00:00Z';
    const models = [{ id: 'echo', created: '2026-10-12T14:59:58Z' }, { id: 'real', created: '2025-03-01T00:00:00Z' }, { id: 'none', created: undefined }];
    const sorted = [...models].sort((a, b) => createdSortValue(b.created, fetched).localeCompare(createdSortValue(a.created, fetched)));
    expect(sorted[0].id).toBe('real');
    expect(createdSortValue('2026-10-12T14:59:58Z', fetched)).toBe('');
  });
});
