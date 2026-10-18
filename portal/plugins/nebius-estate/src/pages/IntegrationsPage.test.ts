import { ApiError } from '../ui/api';
import { collapseCoverage, syncNote } from './IntegrationsPage';

describe('collapseCoverage', () => {
  const ok = (id: string) => ({ connector: 'nebius-inventory', project: { id, name: `name-${id}` }, services: ['compute.disks', 'iam.projects'], partial: false });

  it('folds identical complete projects into one row and keeps differing ones apart', () => {
    const rows = collapseCoverage([ok('project-e00mocka'), ok('project-e00mockb'), { ...ok('project-e00mockc'), partial: true, note: 'vpc.networks (403) unavailable' }]);
    expect(rows.map(r => r.label)).toEqual(['name-project-e00mockc', '2 projects']);
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length); // unique React keys
  });

  it('says "all N projects" when every project is covered the same way', () => {
    expect(collapseCoverage(['a', 'b', 'c'].map(x => ok(`project-e00mock${x}`))).map(r => r.label)).toEqual(['all 3 projects']);
  });
});

describe('syncNote', () => {
  const s = { id: 'nebius-inventory', title: 'Nebius inventory' };

  it('says "sync in progress" for a 409 instead of an error', () => {
    const n = syncNote(s, { error: new ApiError(409, 'a sync is running') });
    expect(n.tone).toBe('info');
    expect(n.text).toMatch(/sync in progress/i);
  });

  it('reports other failures as errors and successes with the backend note', () => {
    expect(syncNote(s, { error: new ApiError(500, 'boom') })).toEqual({ tone: 'danger', text: 'Sync of Nebius inventory failed: boom' });
    expect(syncNote(s, { ok: { ok: true, note: 'not repeated' } })).toEqual({ tone: 'info', text: 'not repeated' });
    expect(syncNote(s, { ok: { ok: true } }).text).toBe('Sync of Nebius inventory finished.');
  });
});
