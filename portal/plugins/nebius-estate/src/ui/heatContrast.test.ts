// Test-only: reads the stylesheet to check the heat-map colour tokens.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'fs';
// eslint-disable-next-line no-restricted-imports
import { resolve } from 'path';

// eslint-disable-next-line no-restricted-syntax
const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8');

/** The heat tokens of one theme block (light: `:root, body[data-theme-mode='light']`; dark: `body[data-theme-mode='dark']`). */
function heatTokens(theme: 'light' | 'dark'): Record<string, string> {
  const blocks = [...css.matchAll(/([^{}]*)\{([^{}]*--ne-heat-0:[^{}]*)\}/g)];
  const block = blocks.find(b => b[1].includes(`data-theme-mode='${theme}'`))!;
  return Object.fromEntries([...block[2].matchAll(/--ne-heat-([a-z0-9]+):\s*(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]));
}

const lum = (hex: string) => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe('heat map colours (WCAG 1.4.11)', () => {
  it.each(['light', 'dark'] as const)('%s: "not observed" is hatched with stripes that contrast at least 3:1 with 0 %', theme => {
    const t = heatTokens(theme);
    expect(t.hatch).toBeDefined();
    expect(contrast(t.hatch, t['0'])).toBeGreaterThanOrEqual(3);
  });

  it('draws "not observed" as the hatch, not as a flat colour', () => {
    expect(css).toMatch(/\.ne-heat-cnone \{[^}]*fill: transparent;[^}]*repeating-linear-gradient\(.*var\(--ne-heat-hatch\)/);
    expect(css).toMatch(/\.ne-heat-row \{[^}]*repeating-linear-gradient\(.*var\(--ne-heat-hatch\)/);
  });
});
