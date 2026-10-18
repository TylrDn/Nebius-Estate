import { forwardRef, useCallback, useEffect, useRef } from 'react';
import { MarkdownContent } from '@backstage/core-components';

export type CodeTokenRole = 'comment' | 'string' | 'keyword' | 'other';

/**
 * Backstage's CodeSnippet highlights with react-syntax-highlighter's hljs `docco` (light) or `dark` palette as inline
 * colours and drops the hljs class names, so the only trace of a token's kind is its colour. Two of docco's fail
 * WCAG 1.4.3 on the code background (#408080 3.94:1, #219161 3.44:1; #39). Each colour is mapped to a role that the
 * theme's own palette paints (`--ne-code-*`); any other colour reads in the text colour.
 */
const ROLES: Record<string, CodeTokenRole> = {
  // docco
  '#408080': 'comment',
  '#999999': 'comment',
  '#219161': 'string',
  '#bb6688': 'string',
  '#954121': 'keyword',
  // dark
  '#777777': 'comment',
  '#dd8888': 'string',
  '#ffffff': 'keyword',
};

/** "#abc", "#aabbcc", "rgb(r, g, b)" or "white" → "#aabbcc" (lower case); anything else unchanged. */
function hex(color: string): string {
  const c = color.trim().toLowerCase();
  if (c === 'white') return '#ffffff';
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (rgb) return `#${rgb.slice(1, 4).map(n => Number(n).toString(16).padStart(2, '0')).join('')}`;
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${[...c.slice(1)].map(x => x + x).join('')}`;
  return c;
}

export function codeTokenRole(color: string): CodeTokenRole {
  return ROLES[hex(color)] ?? 'other';
}

const SCROLLS = 'data-ne-scrolls';

/**
 * WCAG scrollable-region-focusable (#39): an outer code block or a table that scrolls sideways gets a tab stop (and,
 * for a code block, a name), so a keyboard user can scroll it; one that fits loses it again. Highlighted tokens get
 * their role (`data-ne-tok`). Idempotent: called again on every DOM change and resize.
 */
export function prepareCodeBlocks(root: HTMLElement): void {
  const boxes = [...root.querySelectorAll<HTMLElement>('pre, table')].filter(el => !el.parentElement?.closest('pre'));
  for (const el of boxes) {
    const scrolls = el.scrollWidth > el.clientWidth + 1;
    const isPre = el.tagName === 'PRE';
    if (scrolls && !el.hasAttribute(SCROLLS)) {
      el.setAttribute(SCROLLS, '');
      el.setAttribute('tabindex', '0');
      if (isPre) {
        el.setAttribute('role', 'region');
        el.setAttribute('aria-label', 'Code block (scrolls sideways)');
      }
    } else if (!scrolls && el.hasAttribute(SCROLLS)) {
      for (const a of [SCROLLS, 'tabindex', ...(isPre ? ['role', 'aria-label'] : [])]) el.removeAttribute(a);
    }
  }
  for (const span of root.querySelectorAll<HTMLElement>('pre span[style]')) {
    const role = codeTokenRole(span.style.color);
    if (span.getAttribute('data-ne-tok') !== role) span.setAttribute('data-ne-tok', role);
  }
}

/** Keeps `prepareCodeBlocks` applied while the highlighter (which loads its languages asynchronously) and the layout change. */
function useCodeBlocks() {
  const observers = useRef<{ m?: MutationObserver; r?: ResizeObserver }>({});
  useEffect(() => () => {
    observers.current.m?.disconnect();
    observers.current.r?.disconnect();
  }, []);
  return useCallback((root: HTMLElement | null) => {
    observers.current.m?.disconnect();
    observers.current.r?.disconnect();
    if (!root) return;
    const run = () => prepareCodeBlocks(root);
    run();
    if (typeof MutationObserver !== 'undefined') {
      observers.current.m = new MutationObserver(run);
      // Attributes are not observed: prepareCodeBlocks writes them, and it would observe itself.
      observers.current.m.observe(root, { childList: true, subtree: true });
    }
    if (typeof ResizeObserver !== 'undefined') {
      observers.current.r = new ResizeObserver(run);
      observers.current.r.observe(root);
    }
  }, []);
}

/**
 * Repository or documentation Markdown in the portal's `ne-markdown` styles. Every Markdown view uses this, so code
 * blocks and wide tables are keyboard-scrollable and highlighted code meets contrast in both themes.
 */
export const Markdown = forwardRef<HTMLDivElement, { content: string; transformLinkUri?: (href: string) => string; className?: string }>(function MarkdownView(
  { content, transformLinkUri, className },
  ref,
) {
  const prepare = useCodeBlocks();
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      prepare(el);
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [prepare, ref],
  );
  return (
    <div className={['ne-markdown', className].filter(Boolean).join(' ')} ref={setRef}>
      <MarkdownContent content={content} dialect="gfm" transformLinkUri={transformLinkUri} />
    </div>
  );
});
