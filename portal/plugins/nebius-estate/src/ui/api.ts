import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { discoveryApiRef, fetchApiRef, useApi } from '@backstage/frontend-plugin-api';
import type { Meta } from '@internal/nebius-domain';

/**
 * Typed calls to the Nebius Estate backend through Backstage's fetchApi,
 * which attaches the signed-in user's token. The browser never holds cloud
 * credentials: every call goes to this portal's own backend.
 */

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
  get permissionDenied() {
    return this.status === 403;
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    message = body?.error?.message ?? message;
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, message);
}

export function useBackend() {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  return useCallback(
    async <T>(path: string, init?: RequestInit & { raw?: boolean }): Promise<T> => {
      const base = await discovery.getBaseUrl('nebius-estate');
      const res = await fetchApi.fetch(`${base}${path}`, init);
      if (!res.ok) throw await errorFrom(res);
      if (init?.raw) return (await res.text()) as unknown as T;
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    },
    [discovery, fetchApi],
  );
}

export interface Loadable<T> {
  data?: T;
  error?: ApiError | Error;
  loading: boolean;
  reload: () => void;
}

/* ------------------------------------------------------------- refresh */

/**
 * One page-wide refresh clock: the header's Refresh button (and a quiet
 * five-minute interval while the tab is visible) bumps it, and every useGet
 * on the page refetches. `refreshedAt` is wall-clock time, not the demo clock.
 */
type RefreshState = { tick: number; refreshedAt: number };
let refreshState: RefreshState = { tick: 0, refreshedAt: Date.now() };
const refreshListeners = new Set<() => void>();

export function refreshAll() {
  refreshState = { tick: refreshState.tick + 1, refreshedAt: Date.now() };
  refreshListeners.forEach(l => l());
}

export function useRefreshClock(): RefreshState {
  return useSyncExternalStore(
    l => {
      refreshListeners.add(l);
      return () => refreshListeners.delete(l);
    },
    () => refreshState,
    () => refreshState,
  );
}

/**
 * GET with loading/error state; refetches when `path` changes or on a page
 * refresh. Data stays on screen while refetching. Stale responses are dropped.
 */
export function useGet<T>(path: string | null): Loadable<T> {
  const call = useBackend();
  const { tick: pageTick } = useRefreshClock();
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: path !== null });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (path === null) return;
    const mine = ++seq.current;
    setState(s => ({ ...s, loading: true }));
    call<T>(path)
      .then(data => mine === seq.current && setState({ data, loading: false }))
      .catch(error => mine === seq.current && setState(s => ({ data: s.data, error, loading: false })));
  }, [call, path, tick, pageTick]);
  return { ...state, reload: () => setTick(t => t + 1) };
}

/** Fetches a text file from the backend and saves it; a failure is returned as `error`, never dropped. */
export function useDownload(): { download: (path: string, filename: string, type?: string) => void; error?: string } {
  const call = useBackend();
  const [error, setError] = useState<string>();
  const download = useCallback(
    (path: string, filename: string, type = 'text/plain') => {
      setError(undefined);
      call<string>(path, { raw: true })
        .then(text => {
          const url = URL.createObjectURL(new Blob([text], { type }));
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        })
        .catch((e: Error) => setError(`Download failed: ${e.message}`));
    },
    [call],
  );
  return { download, error };
}

let metaCache: Promise<Meta> | undefined;
let metaValue: Meta | undefined;

/** How long a page waits before it asks /meta again after a failed call. */
export const META_RETRY_MS = 3000;

/**
 * Session meta: mode, demo clock, caller scope and permission map (cached per page load). A failed call is asked
 * again every few seconds while the page is open: the "Test data" banner and the permission map come from here, so
 * one failed call (a busy backend) must not leave a stub run's page without its banner until a reload.
 */
export function useMeta(): Omit<Loadable<Meta>, 'reload'> {
  const call = useBackend();
  const [state, setState] = useState<{ data?: Meta; error?: Error; loading: boolean }>(() => ({ data: metaValue, loading: !metaValue }));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (metaValue) {
      setState(s => (s.data === metaValue ? s : { data: metaValue, loading: false }));
      return undefined;
    }
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    metaCache ??= call<Meta>('/meta');
    metaCache
      .then(data => {
        metaValue = data;
        if (live) setState({ data, loading: false });
      })
      .catch(error => {
        metaCache = undefined;
        if (!live) return;
        setState({ error, loading: false });
        retry = setTimeout(() => setAttempt(a => a + 1), META_RETRY_MS);
      });
    return () => {
      live = false;
      if (retry) clearTimeout(retry);
    };
  }, [call, attempt]);
  return state;
}
