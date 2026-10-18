import { defaultLogProject, newestLineOf, projectsInFilter } from './defaultProject';

describe('defaultLogProject', () => {
  const projects = [
    { id: 'project-e00west2', name: 'default-project-eu-west2' },
    { id: 'project-e00north1', name: 'default-project-eu-north1' },
    { id: 'project-e00labs', name: 'nbis-labs' },
  ];

  it('opens on the project that has log buckets, not the first in scope, and lists every project with logs', async () => {
    const buckets = jest.fn(async (id: string) => (id === 'project-e00north1' ? ['sp_serial', 'sp_mk8s_control_plane'] : id === 'project-e00labs' ? ['sp_serial'] : []));
    const r = await defaultLogProject(projects, buckets);
    expect(r.project.id).toBe('project-e00north1');
    expect(r.withLogs).toEqual([
      { id: 'project-e00north1', name: 'default-project-eu-north1', buckets: ['sp_serial', 'sp_mk8s_control_plane'], recent: true },
      { id: 'project-e00labs', name: 'nbis-labs', buckets: ['sp_serial'], recent: true },
    ]);
  });

  it('opens on the project with logs in the last 24 h before one whose newest logs are older (G3.14)', async () => {
    // Live: nbis-labs (first in configuration order) last wrote on 10-08; eu-north1 wrote yesterday.
    const day = 86_400_000;
    const buckets = jest.fn(async (id: string, sinceMs: number) =>
      id === 'project-e00labs' ? (sinceMs > day ? ['sp_serial'] : []) : id === 'project-e00north1' ? ['sp_serial'] : []);
    const r = await defaultLogProject([projects[2], projects[1], projects[0]], buckets);
    expect(r.project.id).toBe('project-e00north1');
    expect(r.withLogs).toEqual([
      { id: 'project-e00labs', name: 'nbis-labs', buckets: ['sp_serial'], recent: false },
      { id: 'project-e00north1', name: 'default-project-eu-north1', buckets: ['sp_serial'], recent: true },
    ]);
    // None active in 24 h: the first with logs in 7 days, as before.
    const old = await defaultLogProject(projects, async (id, sinceMs) => (id === 'project-e00labs' && sinceMs > day ? ['sp_serial'] : []));
    expect(old.project.id).toBe('project-e00labs');
  });

  it('judges "recent" and picks by the newest line, not by the 24 h label probe (#31)', async () => {
    // Live: the 24 h label probe listed nbis-labs's bucket (label values come from the index, not from lines),
    // though its newest line was days old; eu-north1 wrote an hour ago.
    const now = Date.parse('2026-10-12T20:00:00Z');
    const buckets = jest.fn(async () => ['sp_serial']);
    const newest = jest.fn(async (id: string) => (id === 'project-e00labs' ? '2026-10-08T11:00:00Z' : id === 'project-e00north1' ? '2026-10-12T19:00:00Z' : undefined));
    const r = await defaultLogProject([projects[2], projects[1]], buckets, { newest, now });
    expect(r.project.id).toBe('project-e00north1');
    expect(r.withLogs).toEqual([
      { id: 'project-e00labs', name: 'nbis-labs', buckets: ['sp_serial'], recent: false, newest: '2026-10-08T11:00:00Z' },
      { id: 'project-e00north1', name: 'default-project-eu-north1', buckets: ['sp_serial'], recent: true, newest: '2026-10-12T19:00:00Z' },
    ]);
    expect(newest).toHaveBeenCalledWith('project-e00labs', ['sp_serial']);
    // Neither recent: still the one that wrote last.
    const older = await defaultLogProject([projects[1], projects[2]], buckets, { newest: async id => (id === 'project-e00labs' ? '2026-10-10T00:00:00Z' : '2026-10-09T00:00:00Z'), now });
    expect(older.project.id).toBe('project-e00labs');
    // A failed newest-line read falls back to the label probe for that project.
    const failed = await defaultLogProject([projects[2]], buckets, { newest: async () => { throw new Error('500'); }, now });
    expect(failed.withLogs[0]).toMatchObject({ recent: true });
    expect(failed.withLogs[0]).not.toHaveProperty('newest');
  });

  it('keeps only the projects in the global filter\'s region and stage (G3.3)', () => {
    const r = (providerId: string, type: string, projectId: string, region: string, labels: Record<string, string> = {}) => ({ providerId, type, projectId, region, labels }) as any;
    const resources = [
      r('project-e00north1', 'project', 'project-e00north1', 'eu-north1'),
      r('project-e00labs', 'project', 'project-e00labs', 'uk-south1'),
      r('project-e00west2', 'project', 'project-e00west2', 'eu-west2'),
      r('computeinstance-e00sbx', 'compute-instance', 'project-e00north1', 'eu-north1', { 'nip-stage': 'sandbox' }),
    ];
    expect(projectsInFilter(projects, resources, { region: 'eu-north1' }).map(p => p.id)).toEqual(['project-e00north1']);
    expect(projectsInFilter(projects, resources, { region: 'uk-south1' }).map(p => p.id)).toEqual(['project-e00labs']);
    expect(projectsInFilter(projects, resources, { stage: 'sandbox' }).map(p => p.id)).toEqual(['project-e00north1']);
    expect(projectsInFilter(projects, resources, { region: 'uk-south1', stage: 'sandbox' })).toEqual([]);
    expect(projectsInFilter(projects, resources, {})).toEqual(projects);
  });

  it('falls back to the first project when none has logs or the probes fail', async () => {
    expect((await defaultLogProject(projects, async () => [])).project.id).toBe('project-e00west2');
    const r = await defaultLogProject(projects, async () => {
      throw new Error('403');
    });
    expect(r).toEqual({ project: projects[0], withLogs: [] });
  });
});

describe('newestLineOf (#31)', () => {
  it('one bucket that cannot be read does not hide the newest line of the others', async () => {
    const times: Record<string, string | undefined> = { sp_serial: '2026-10-12T19:55:00Z', sp_mk8s_control_plane: '2026-10-12T10:00:00Z', sp_empty: undefined };
    const read = async (b: string) => {
      if (b === 'sp_denied') throw new Error('403');
      return times[b];
    };
    expect(await newestLineOf(['sp_denied', 'sp_serial', 'sp_mk8s_control_plane', 'sp_empty'], read)).toBe('2026-10-12T19:55:00Z');
    // Read and empty: no newest line. Not one bucket read: unknown, so the caller falls back to the label probe.
    expect(await newestLineOf(['sp_empty'], read)).toBeUndefined();
    await expect(newestLineOf(['sp_denied'], read)).rejects.toThrow('403');
  });
});
