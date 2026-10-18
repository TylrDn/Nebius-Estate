import { defaultQuery, displayLine, initialQuery, lineTime, listHeight, projectNote, spansDays, visibleWindow } from './model';

describe('Logs view helpers', () => {
  it('open pre-filtered from a deep link (alert or VM), a preset, or a query', () => {
    expect(initialQuery({ bucket: 'sp_serial', resource: 'computeinstance-1' })).toBe('{__bucket__="sp_serial", sp_resource_id="computeinstance-1"}');
    expect(initialQuery({ preset: 'postgres-errors' })).toBe('{__bucket__="sp_postgres"} |~ "ERROR|FATAL|PANIC"');
    expect(initialQuery({ q: '{__bucket__="default"}', preset: 'postgres-errors' })).toBe('{__bucket__="default"}');
    expect(initialQuery({})).toMatch(/^\{__bucket__="sp_serial"\}/);
  });

  it('render only the visible window of a long list', () => {
    expect(visibleWindow(0, 440, 22, 1000)).toEqual({ start: 0, end: 30 });
    expect(visibleWindow(22 * 500, 440, 22, 1000)).toEqual({ start: 490, end: 530 });
    expect(visibleWindow(22 * 995, 440, 22, 1000)).toEqual({ start: 985, end: 1000 });
    expect(visibleWindow(0, 440, 22, 0)).toEqual({ start: 0, end: 0 });
  });

  it('size the line list to its lines, up to the viewport (F1.24)', () => {
    expect(listHeight(3, 24, 460)).toBe(72);
    expect(listHeight(1000, 24, 460)).toBe(460);
    expect(listHeight(0, 24, 460)).toBe(0);
  });

  it('show line times in UTC to the millisecond', () => {
    expect(lineTime('2026-10-11T07:53:28.203Z')).toBe('07:53:28.203');
    expect(lineTime('2026-10-11T07:53:28.203Z', true)).toBe('10-11 07:53:28.203');
    expect(spansDays('2026-10-11T00:00:00Z', '2026-10-11T23:59:59Z')).toBe(false);
    expect(spansDays('2026-10-11T22:00:00Z', '2026-10-12T04:00:00Z')).toBe(true);
  });

  it('strip non-printable control bytes from a displayed line, keeping tabs and text', () => {
    expect(displayLine('mo\u0000\u001b\ufffd[ 5.61]\tok\u007f\u0085')).toBe('mo[ 5.61]\tok');
    expect(displayLine('plain line')).toBe('plain line');
  });

  it('say which project the page opened on and which projects have logs', () => {
    const b = { project: { id: 'p2', name: 'eu-north1' }, projects: [{ id: 'p1', name: 'eu-west2' }, { id: 'p2', name: 'eu-north1' }], projectsWithLogs: [{ id: 'p2', name: 'eu-north1', buckets: ['sp_serial'] }] };
    expect(projectNote(b as any, false)).toBe('the project in your scope with log buckets in the last 7 days; pick another with the project filter above');
    const two = { ...b, projectsWithLogs: [...b.projectsWithLogs, { id: 'p3', name: 'labs', buckets: ['sp_serial'] }] };
    expect(projectNote(two as any, false)).toBe('the first of 2 projects with log buckets in the last 7 days (eu-north1, labs); pick another with the project filter above');
    // G3.14: the page opens on the project with logs in the last 24 h, and says so.
    const recent = { ...b, project: { id: 'p3', name: 'labs' }, projectsWithLogs: [{ id: 'p2', name: 'eu-north1', buckets: ['sp_serial'] }, { id: 'p3', name: 'labs', buckets: ['sp_serial'], recent: true }] };
    expect(projectNote(recent as any, false)).toBe('the one with logs in the last 24 h of 2 projects with log buckets in the last 7 days (eu-north1, labs); pick another with the project filter above');
    // #31: the page opens on the project that wrote last, which need not be the first; the note says that, with when.
    const byNewest = {
      ...b,
      project: { id: 'p3', name: 'labs' },
      projectsWithLogs: [
        { id: 'p2', name: 'eu-north1', buckets: ['sp_serial'], recent: true, newest: '2026-10-12T17:00:00.000Z' },
        { id: 'p3', name: 'labs', buckets: ['sp_serial'], recent: true, newest: '2026-10-12T19:58:03.000Z' },
      ],
    };
    expect(projectNote(byNewest as any, false)).toBe('the one that wrote last (2026-10-12 19:58 UTC) of 2 projects with log buckets in the last 7 days (eu-north1, labs); pick another with the project filter above');
    // Neither recent: still the one that wrote last, never "the first".
    const stale = { ...byNewest, projectsWithLogs: byNewest.projectsWithLogs.map(p => ({ ...p, recent: false })) };
    expect(projectNote(stale as any, false)).toMatch(/^the one that wrote last \(2026-10-12 19:58 UTC\) of 2 projects/);
    expect(projectNote({ ...b, projectsWithLogs: [] } as any, false)).toBe('no project in your scope has log buckets in the last 7 days; showing the first');
    expect(projectNote(b as any, true)).toBe('');
    expect(projectNote({ ...b, projectsWithLogs: undefined } as any, false)).toBe('the first in your scope; pick another with the project filter above');
  });
});

describe('the query Logs opens on when the link names none (Wave 1 verification: it opened on a bucket with no lines)', () => {
  const b = (id: string, newest?: string, state: 'present' | 'no-logs-yet' = newest ? 'present' : 'no-logs-yet') => ({ id, service: id, description: '', state, ...(newest ? { newest } : {}) });
  it('the serial-console errors preset while that bucket has lines', () => {
    expect(defaultQuery([b('sp_serial', '2026-10-13T10:00:00Z'), b('sp_mk8s_control_plane', '2026-10-13T11:00:00Z')]).query).toMatch(/^\{__bucket__="sp_serial"\} \|~/);
  });
  it('else the bucket that wrote last, all its lines, and says why', () => {
    const d = defaultQuery([b('sp_serial'), b('sp_mk8s_control_plane', '2026-10-13T10:00:00Z'), b('default', '2026-10-13T11:00:00Z')]);
    expect(d.query).toBe('{__bucket__="default"}');
    expect(d.note).toBe('sp_serial has no lines in the last 7 days; showing default, the bucket that wrote last (2026-10-13 11:00 UTC)');
  });
  it('with no bucket that has lines, the preset (its empty state says so)', () => {
    expect(defaultQuery([b('sp_serial'), b('default')]).query).toMatch(/^\{__bucket__="sp_serial"\}/);
  });
  it('when no newest line could be read, a listed bucket counts as having lines', () => {
    expect(defaultQuery([b('sp_serial', undefined, 'no-logs-yet'), b('default', undefined, 'present')]).query).toBe('{__bucket__="default"}');
  });
});
