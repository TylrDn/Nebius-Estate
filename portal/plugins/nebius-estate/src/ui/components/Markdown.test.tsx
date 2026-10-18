// Test-only: reads the stylesheet to check the code token colours.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'fs';
// eslint-disable-next-line no-restricted-imports
import { resolve } from 'path';
import { codeTokenRole, prepareCodeBlocks } from './Markdown';

/** A box whose content is `content` px wide in a `box` px wide viewport (jsdom has no layout). */
function sized<T extends HTMLElement>(el: T, box: number, content: number): T {
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: box });
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: content });
  return el;
}

describe('prepareCodeBlocks (#39: WCAG scrollable-region-focusable, token contrast)', () => {
  function doc(html: string): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = html;
    return root;
  }

  it('makes a code block that scrolls sideways keyboard-focusable and names it; one that fits is left alone', () => {
    const root = doc('<pre id="wide"><pre><code>terraform -chdir=platform/sandbox plan -detailed-exitcode</code></pre></pre><pre id="narrow"><code>ls</code></pre>');
    sized(root.querySelector<HTMLElement>('#wide')!, 300, 620);
    sized(root.querySelector<HTMLElement>('#narrow')!, 300, 300);
    prepareCodeBlocks(root);
    const wide = root.querySelector('#wide')!;
    expect(wide.getAttribute('tabindex')).toBe('0');
    expect(wide.getAttribute('role')).toBe('region');
    expect(wide.getAttribute('aria-label')).toBe('Code block (scrolls sideways)');
    // Only the outer box: Backstage's CodeSnippet nests its own <pre>, which does not scroll.
    expect(wide.querySelector('pre')!.hasAttribute('tabindex')).toBe(false);
    expect(root.querySelector('#narrow')!.hasAttribute('tabindex')).toBe(false);
  });

  it('takes the focus stop away again when the block fits after a resize', () => {
    const root = doc('<pre id="p"><code>x</code></pre>');
    const pre = sized(root.querySelector<HTMLElement>('#p')!, 300, 600);
    prepareCodeBlocks(root);
    expect(pre.getAttribute('tabindex')).toBe('0');
    sized(pre, 700, 600);
    prepareCodeBlocks(root);
    expect(pre.hasAttribute('tabindex')).toBe(false);
    expect(pre.hasAttribute('role')).toBe(false);
    expect(pre.hasAttribute('aria-label')).toBe(false);
  });

  it('a table that scrolls sideways is focusable too, and keeps its table role', () => {
    const root = doc('<table id="t"><tbody><tr><td>a</td></tr></tbody></table>');
    sized(root.querySelector<HTMLElement>('#t')!, 300, 900);
    prepareCodeBlocks(root);
    const t = root.querySelector('#t')!;
    expect(t.getAttribute('tabindex')).toBe('0');
    expect(t.hasAttribute('role')).toBe(false);
  });

  it('tags each highlighted token with its role, so the theme palette (not the highlighter inline colour) paints it', () => {
    const root = doc('<pre><code><span id="c" style="color: #408080">#</span><span id="s" style="color: #219161">"x"</span><span id="k" style="color: #954121">if</span><span id="o" style="color: #0086b3">echo</span></code></pre>');
    prepareCodeBlocks(root);
    expect(root.querySelector('#c')!.getAttribute('data-ne-tok')).toBe('comment');
    expect(root.querySelector('#s')!.getAttribute('data-ne-tok')).toBe('string');
    expect(root.querySelector('#k')!.getAttribute('data-ne-tok')).toBe('keyword');
    // Any other highlighter colour reads in the text colour: never a colour this palette has not checked.
    expect(root.querySelector('#o')!.getAttribute('data-ne-tok')).toBe('other');
  });

  it('maps both highlighter palettes (docco in light, dark in dark), hex or rgb', () => {
    expect(codeTokenRole('#408080')).toBe('comment');
    expect(codeTokenRole('rgb(64, 128, 128)')).toBe('comment');
    expect(codeTokenRole('#777')).toBe('comment');
    expect(codeTokenRole('rgb(33, 145, 97)')).toBe('string');
    expect(codeTokenRole('#d88')).toBe('string');
    expect(codeTokenRole('white')).toBe('keyword');
    expect(codeTokenRole('rgb(149, 65, 33)')).toBe('keyword');
    expect(codeTokenRole('')).toBe('other');
  });
});

describe('code token colours (WCAG 1.4.3, #39)', () => {
  // eslint-disable-next-line no-restricted-syntax
  const css = readFileSync(resolve(__dirname, '..', 'styles.css'), 'utf8');
  const block = (theme: 'light' | 'dark') => [...css.matchAll(/([^{}]*)\{([^{}]*--ne-code-comment:[^{}]*)\}/g)].find(b => b[1].includes(`data-theme-mode='${theme}'`))![2];
  const token = (theme: 'light' | 'dark', name: string) => {
    const all = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter(b => b[1].includes(`data-theme-mode='${theme}'`)).map(b => b[2]).join(';');
    return new RegExp(`--ne-${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(name.startsWith('code-') ? block(theme) : all)![1];
  };
  const lum = (hex: string) => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  it.each(['light', 'dark'] as const)('%s: every token role is at least 4.5:1 on the code block background', theme => {
    for (const role of ['comment', 'string', 'keyword']) {
      expect(contrast(token(theme, `code-${role}`), token(theme, 'bg-sunken'))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the palette overrides the highlighter inline colours', () => {
    expect(css).toMatch(/\.ne-markdown pre \[data-ne-tok='comment'\] \{[^}]*color: var\(--ne-code-comment\) !important/);
    expect(css).toMatch(/\.ne-markdown pre \[data-ne-tok='other'\] \{[^}]*color: inherit !important/);
  });

  it('#51: inline code wraps anywhere so a long path cannot widen the document; code blocks keep scrolling', () => {
    expect(css).toMatch(/\.ne-markdown code \{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.ne-markdown pre code \{[^}]*overflow-wrap: normal/);
  });

  it('a table cell keeps its words, above Backstage\'s own cell rule (word-break: break-word split "intende|d?")', () => {
    expect(css).toMatch(/\.ne-markdown table th,\s*\.ne-markdown table td \{[^}]*word-break: normal/);
  });

  it('the alert runbook box has no fixed height of its own (a scroll box inside the drawer, not focusable)', () => {
    expect(css).not.toMatch(/\.ne-fix-runbook \{[^}]*max-height/);
  });
});
