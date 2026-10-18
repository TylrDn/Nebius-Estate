import type { ObservedResource } from '@internal/nebius-domain';
import { filterResources } from '../views';

const DAY_MS = 86_400_000;
/** Projects are probed over the last day, then the last week: the page opens on recent logs where there are any. */
export const RECENT_MS = DAY_MS;
export const PROBE_MS = 7 * DAY_MS;

/**
 * Which project the Logs page opens on when no project is chosen: the one whose newest line is newest (#31), else one
 * with log buckets in the last 24 h,
 * else one with buckets in the last 7 days, else the first in scope (G3.14: the first in configuration order with
 * any bucket in 7 days last wrote days ago, so the page's default 1 h view was always empty). Every project with
 * logs in 7 days is listed, with `recent` when it also has logs in 24 h. A failed probe counts as "no logs known".
 * `buckets(projectId, sinceMs)`: the bucket names with lines in the last `sinceMs`.
 */
export async function defaultLogProject<P extends { id: string; name?: string }>(
  projects: P[],
  buckets: (projectId: string, sinceMs: number) => Promise<string[]>,
  /**
   * #31: the time of a project's newest line in those buckets, when it can be read. The label probe answers from the
   * index, so a bucket can be "in the last 24 h" with no line in it (live: nbis-labs, newest line days old); with
   * this, "recent" and the pick go by the newest line. A failed read falls back to the label probe.
   */
  lines?: { newest: (projectId: string, buckets: string[]) => Promise<string | undefined>; now: number },
): Promise<{ project: P; withLogs: (P & { buckets: string[]; recent: boolean; newest?: string })[] }> {
  const probe = (id: string, ms: number) => buckets(id, ms).then(b => b, () => [] as string[]);
  const found = await Promise.all(projects.map(async p => {
    const [week, day] = await Promise.all([probe(p.id, PROBE_MS), probe(p.id, RECENT_MS)]);
    const all = week.length ? week : day;
    const newest = lines && all.length ? await lines.newest(p.id, all).then(t => t, () => undefined) : undefined;
    return { week, day, newest };
  }));
  const withLogs = projects
    .map((p, i) => {
      const { week, day, newest } = found[i];
      const recent = newest && lines ? lines.now - Date.parse(newest) < RECENT_MS : day.length > 0;
      return { ...p, buckets: week.length ? week : day, recent, ...(newest ? { newest } : {}) };
    })
    .filter(p => p.buckets.length > 0);
  const byNewest = withLogs.filter(p => p.newest).sort((a, b) => b.newest!.localeCompare(a.newest!))[0];
  const pick = byNewest ?? withLogs.find(p => p.recent) ?? withLogs[0];
  return { project: projects.find(p => p.id === pick?.id) ?? projects[0], withLogs };
}

/**
 * The projects the global filter's region and stage keep (G3.3): a project is in a region when it or one of its
 * resources is there; in a stage when one of its resources carries that stage (own label or its parents').
 */
export function projectsInFilter<P extends { id: string }>(
  projects: P[],
  resources: Pick<ObservedResource, 'providerId' | 'type' | 'projectId' | 'region' | 'labels'>[],
  f: { region?: string; stage?: string },
): P[] {
  if (!f.region && !f.stage) return projects;
  const rs = resources as ObservedResource[];
  const kept = new Set<string>();
  if (f.stage) {
    for (const r of filterResources(rs.filter(x => x.type !== 'project'), { region: f.region, stage: f.stage })) if (r.projectId) kept.add(r.projectId);
  } else {
    for (const r of rs) {
      const id = r.type === 'project' ? r.providerId : r.projectId;
      if (r.region === f.region && id) kept.add(id);
    }
  }
  return projects.filter(p => kept.has(p.id));
}

/**
 * A project's newest line over its buckets (#31): each bucket read on its own, so one bucket that cannot be read
 * (403, 503) does not hide the others' lines and hand the pick to a project that wrote days ago. Rejects only when no
 * bucket could be read, so the caller falls back to the label probe.
 */
export async function newestLineOf(buckets: string[], read: (bucket: string) => Promise<string | undefined>): Promise<string | undefined> {
  const results = await Promise.allSettled(buckets.map(b => read(b)));
  const ok = results.filter((r): r is PromiseFulfilledResult<string | undefined> => r.status === 'fulfilled');
  if (!ok.length && results.length) throw (results[0] as PromiseRejectedResult).reason;
  return ok.map(r => r.value).filter((t): t is string => Boolean(t)).sort().pop();
}
