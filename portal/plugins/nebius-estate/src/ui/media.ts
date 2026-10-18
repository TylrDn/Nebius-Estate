import { useEffect, useState } from 'react';

/** Phone width: the breakpoint the stylesheet uses for its one-column layouts. */
export const NARROW_QUERY = '(max-width: 600px)';

/** Whether a CSS media query matches now, following changes; false where matchMedia is missing (tests, old browsers). */
export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, [query]);
  return matches;
}
