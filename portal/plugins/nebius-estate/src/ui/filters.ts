import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FilterOptions, GlobalFilter, globalFilterSchema } from '@internal/nebius-domain';
import { useGet } from './api';

/**
 * Global project / region / stage filter, kept in the URL (`?project=…&region=…&stage=…`)
 * so every view is shareable and bookmarkable. The nav carries these three
 * parameters from page to page. The backend still scopes every response by the
 * caller's permissions: the filter only narrows the view. Values the backend
 * would reject (globalFilterSchema), or that match nothing in the caller's scope,
 * are not applied, and the filter bar says which (ignoredFilterValues).
 * A change is pushed onto the history, so Back undoes it.
 */
const FILTER_KEYS = ['project', 'region', 'stage'] as const;

export function readFilter(params: URLSearchParams): GlobalFilter {
  const out: GlobalFilter = {};
  for (const k of FILTER_KEYS) {
    const v = params.get(k);
    if (v && globalFilterSchema.shape[k].safeParse(v).success) out[k] = v;
  }
  return out;
}

/** `?project=…` for the filter keys present in `search` (used by nav links). */
export function filterSearch(search: string): string {
  const f = readFilter(new URLSearchParams(search));
  const q = new URLSearchParams(f as Record<string, string>).toString();
  return q ? `?${q}` : '';
}

export interface IgnoredFilterValue {
  key: (typeof FILTER_KEYS)[number];
  value: string;
  reason: string;
}

/** Filter values in the URL that cannot apply: invalid, or matching no project, region or stage in the caller's scope. */
export function ignoredFilterValues(params: URLSearchParams, o: FilterOptions): IgnoredFilterValue[] {
  const out: IgnoredFilterValue[] = [];
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (!value) continue;
    if (!globalFilterSchema.shape[key].safeParse(value).success) out.push({ key, value, reason: `not a valid ${key} id` });
    // #32: before the first inventory sync the scope is unknown (no projects yet): a valid value is kept, not judged.
    else if (o.pending) continue;
    else if (key === 'project' && !o.projects.some(p => p.id === value)) out.push({ key, value, reason: 'not a project in your scope' });
    else if (key === 'region' && !o.regions.includes(value)) out.push({ key, value, reason: 'no project in your scope is in this region' });
    else if (key === 'stage' && !o.stages.includes(value)) out.push({ key, value, reason: 'no resource in your scope carries this stage' });
  }
  return out;
}

export function useGlobalFilter(): [GlobalFilter, (p: Partial<GlobalFilter>, opts?: { replace?: boolean }) => void] {
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => readFilter(params), [params]);
  const set = useCallback(
    (patch: Partial<GlobalFilter>, opts: { replace?: boolean } = {}) =>
      setParams(
        prev => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v) next.set(k, v);
            else next.delete(k);
          }
          return next;
        },
        { replace: opts.replace ?? false },
      ),
    [setParams],
  );
  return [filter, set];
}

export function filterQuery(f: GlobalFilter, extra: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Project id → name from the projects the caller can see (the filter options), for ProjectName. */
export function useProjectNames(): (id: string) => string | undefined {
  const opts = useGet<FilterOptions>('/filters');
  const byId = useMemo(() => new Map((opts.data?.projects ?? []).map(p => [p.id, p.name])), [opts.data]);
  return useCallback((id: string) => byId.get(id), [byId]);
}
