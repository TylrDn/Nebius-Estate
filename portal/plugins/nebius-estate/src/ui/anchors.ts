import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/** Opens every folded section (`<details>`, e.g. a Reference section) that holds `el`, itself included, so a link to it shows it. */
export function revealSection(el: Element) {
  for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true;
}

/**
 * Scrolls to the element the URL's #hash names once the page has rendered it (`ready`). React Router does not,
 * so links such as `/capacity#maintenance` from the Overview would otherwise land at the top of the page.
 */
export function useScrollToHash(ready: boolean) {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || !hash) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!el) return;
    revealSection(el);
    el.scrollIntoView?.({ block: 'start' });
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  }, [ready, hash]);
}
