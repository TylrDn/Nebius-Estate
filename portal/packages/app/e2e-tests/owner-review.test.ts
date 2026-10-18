import { expect, Page, test } from '@playwright/test';
import { axeBuilder } from './axe';

/**
 * Owner review findings (W1F, 2026-10-12) against the e2e stub (e2e-stub/estate.json): every route says it shows test
 * data, phones can sort tables and read long ids and log lines, the long reference pages fold, and labels that read
 * the same tell their rows apart.
 */

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const THEMES = ['nebius-dark', 'nebius-light'];

async function useTheme(page: Page, theme: string) {
  await page.addInitScript(t => {
    try {
      localStorage.setItem('theme', t);
    } catch {
      // storage unavailable: the default theme
    }
  }, theme);
}

async function axe(page: Page) {
  const r = await axeBuilder(page).include('#main').withTags(AXE_TAGS).analyze();
  expect(r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
}

for (const theme of THEMES) {
  test(`F1.29b: the page-not-found route says "Test data — not your tenant" on a stub run (${theme}, 1440 and 390 px)`, async ({ page }) => {
    await useTheme(page, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/no-such-page');
      await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
      await expect(page.locator('.ne-header').getByRole('note', { name: 'Test data' })).toContainText('Test data — not your tenant');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      await axe(page);
    }
  });
}

test('S4: "Collapse" folds the estate graph to the tenant; a click on the tenant or a region opens it, on a project opens its drawer', async ({ page }) => {
  await page.goto('/estate');
  const graph = page.getByRole('group', { name: 'Resource relationship graph' });
  await expect(graph.getByRole('button', { name: /^nip-sandbox Project/ })).toBeVisible();
  await page.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(graph.getByRole('button', { name: /^\S+ Project(,|:|$)/ })).toHaveCount(0);
  await expect(page.getByText(/^1 of \d+ nodes shown/)).toBeVisible();
  await graph.getByRole('button', { name: /^Tenant tenant-e00mocktest/ }).click();
  await expect(graph.getByRole('button', { name: /^\S+ Project(,|:|$)/ })).toHaveCount(4);
  await graph.getByRole('button', { name: /^nip-lab Project/ }).click();
  await expect(page).toHaveURL(/uid=nebius%3Aproject-e00mocklab|uid=nebius:project-e00mocklab/);
  await expect(page.getByRole('dialog')).toContainText('nip-lab');
  await page.keyboard.press('Escape');
  const region = graph.getByRole('button', { name: /^uk-south1 Region · nip-lab/ });
  await expect(region).toBeVisible();
  const before = await graph.getByRole('button').count();
  await region.click();
  expect(await graph.getByRole('button').count()).toBeGreaterThan(before);
});

test('S7 and S8: the partial-coverage callout is whole sentences; "nip-sandbox · eu-north1" never breaks inside the region at 1440 px', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/estate');
  const callout = page.locator('.ne-callout', { hasText: 'Partial inventory coverage' });
  await expect(callout).toContainText(/legacy-research: .* unavailable\. See Integrations & Coverage\./);
  await expect(callout.getByRole('link', { name: 'Integrations & Coverage' })).toBeVisible();
  const regions = page.getByRole('table', { name: 'Discovered resources' }).locator('.ne-xproj .ne-nowrap');
  expect(await regions.count()).toBeGreaterThan(10);
  for (const r of await regions.all()) {
    const lines = await r.evaluate(el => el.getClientRects().length);
    expect(lines, await r.innerText()).toBe(1);
  }
});

for (const theme of THEMES) {
  test(`F1.37b: at 390 px the estate graph and table show long ids in full, wrapped, never cut (${theme})`, async ({ page }) => {
    await useTheme(page, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/estate');
    // "Expand all" acts on the graph's loaded nodes: wait for the graph and the resource table before acting or counting.
    await expect(page.getByRole('group', { name: 'Resource relationship graph' }).getByRole('button', { name: /^Tenant / })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Discovered resources' }).locator('tbody tr').nth(10)).toBeVisible();
    await page.getByRole('button', { name: 'Expand all' }).click();
    const labels = page.locator('.ne-graph svg .ne-gnode > text:first-of-type');
    await expect(labels.nth(30)).toBeAttached();
    expect(await labels.count()).toBeGreaterThan(30);
    const cut = await labels.evaluateAll(ts => ts.map(t => t.textContent ?? '').filter(t => t.includes('…')));
    expect(cut).toEqual([]);
    await expect(page.locator('.ne-graph svg')).toContainText('soperator-controller-spool');
    const ids = page.getByRole('table', { name: 'Discovered resources' }).locator('.ne-ellipsis');
    // count() does not wait: under a loaded full run it read the table before its rows rendered (0).
    await expect(ids.nth(10)).toBeAttached();
    expect(await ids.count()).toBeGreaterThan(10);
    const clipped = await ids.evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent));
    expect(clipped).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await axe(page);
  });
}

for (const theme of THEMES) {
  test(`S5: at 390 px log lines wrap in full without selecting them (${theme})`, async ({ page }) => {
    await useTheme(page, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/logs?project=project-e00mocksandbox');
    const list = page.getByRole('region', { name: /^Log lines, \d+ in total/ });
    await expect(list.locator('.ne-logrow').first()).toBeVisible();
    const rows = await list.locator('.ne-logrow-text').evaluateAll(els => els.map(e => ({ cut: e.scrollWidth > e.clientWidth + 1, h: e.getBoundingClientRect().height, text: e.textContent ?? '' })));
    expect(rows.filter(r => r.cut)).toEqual([]);
    // The stub's lines are longer than a phone row: they take more than one line, in full.
    expect(rows.some(r => r.h > 24 && r.text.length > 40)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await axe(page);
  });
}

test('G1.19: at 390 px the Explorer search takes the full row, its placeholder whole', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/estate');
  // On a phone the filters are one "Filters" control (#24); opened, the search takes its own row.
  await page.locator('details.ne-filter-fold > summary').click();
  const search = page.getByRole('searchbox', { name: 'Search' });
  // The search spans the filter bar (its own row), not 160 px beside the selects.
  const w = await search.evaluate(e => e.getBoundingClientRect().width);
  const bar = await page.getByRole('search', { name: 'Global filter' }).evaluate(e => e.getBoundingClientRect().width);
  expect(w).toBeGreaterThan(bar * 0.95);
  expect(await search.evaluate(e => (e as HTMLInputElement).scrollWidth <= e.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

const SORT_PAGES = ['/capacity', '/fleet', '/alerts', '/alerts?tab=rules', '/logs', '/workloads', '/ai-services', '/costs', '/estate?mode=table', '/integrations'];

test('S1: at 390 px every stacked table sorts with a select, and no hidden header button takes focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let selects = 0;
  for (const path of SORT_PAGES) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    // Count once the data has rendered: under a loaded suite 'networkidle' came before the tables (2 selects of 9).
    await expect(page.locator('#main table.ne-table').first(), path).toBeAttached();
    await page.evaluate(() => document.querySelectorAll('details').forEach(d => (d.open = true)));
    expect(await page.locator('table.ne-table-stack thead button').count(), path).toBe(0);
    const sorts = page.getByRole('combobox', { name: /^Sort .+ by$/ });
    const n = await sorts.count();
    selects += n;
    if (!n) continue;
    // Sorting by the select sets aria-sort on that column of its table.
    const first = sorts.first();
    const value = await first.locator('option').nth(1).getAttribute('value');
    await first.selectOption(value!);
    await expect(first.locator('xpath=ancestor::div[contains(@class,"ne-table-sort")]/following-sibling::div[1]//th[@aria-sort]')).toHaveCount(1);
  }
  expect(selects).toBeGreaterThanOrEqual(SORT_PAGES.length - 1);
});

test('S1: keyboard at 390 px: Tab reaches the sort select and never lands on something unseen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/alerts?tab=rules');
  await page.waitForLoadState('networkidle');
  const seen: { label: string; w: number; h: number }[] = [];
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    seen.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        // Focus left the page (Tab past the last control): nothing on it is focused.
        if (el === document.body) return { label: 'body', w: 100, h: 100 };
        const r = el.getBoundingClientRect();
        return { label: el.getAttribute('aria-label') ?? el.textContent?.slice(0, 30) ?? el.tagName, w: r.width, h: r.height };
      }),
    );
  }
  expect(seen.filter(s => s.w < 2 || s.h < 2)).toEqual([]);
  expect(seen.some(s => /^Sort .+ by$/.test(s.label))).toBe(true);
  await axe(page);
});

for (const theme of THEMES) {
    // Before: 25,252, 10,306 and 19,818 px. Recipes: 16 cards whose evidence rows no longer grow per session (two lead,
    // the rest fold); what is left tracks the README's What is proven text (7,416 px after the 2026-10-12 session, 7,075
    // with one lead row), so each card is held to a height below as well as the page.
    // Each page is measured once its data is on screen (a marker of its loaded state, and no loading skeleton left):
    // a page measured while loading is short and passes for the wrong reason, and its value column is not there yet.
  const loaded: Record<string, string> = {
      '/evidence': 'details#ev-repo-live',
      '/evidence?tab=recipes': '#main section.ne-card >> nth=10',
      '/integrations': '#main table tbody tr',
    };
  for (const [path, max] of [['/evidence', 8000], ['/evidence?tab=recipes', 8000], ['/integrations', 8000]] as const) {
    test(`N5: ${path} folds to a phone-sized page with a readable value column (${theme})`, async ({ page }) => {
      await useTheme(page, theme);
      await page.setViewportSize({ width: 390, height: 844 });
      const height = () => page.evaluate(() => document.documentElement.scrollHeight);
      await page.goto(path);
      await expect(page.locator(loaded[path]).first()).toBeVisible();
      await expect(page.locator('#main .ne-skel')).toHaveCount(0);
      expect(await height(), path).toBeLessThan(max);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), path).toBe(0);
      // A value is as wide as its card on a phone: the name sits above it, not in a 150 px column beside it.
      const values = page.locator('#main .ne-kv dd:visible');
      if (await values.count()) {
        const w = await values.first().evaluate(e => e.getBoundingClientRect().width);
        expect(w, path).toBeGreaterThan(250);
      }
      await axe(page);
      // Folded sections open, and are axe clean open too.
      await page.evaluate(() => document.querySelectorAll('details').forEach(d => (d.open = true)));
      await axe(page);
    });
  }
  test(`N5: recipe cards, connector tables and earlier sessions stay folded and readable (${theme})`, async ({ page }) => {
    await useTheme(page, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    // No recipe card outgrows a phone screen and a bit (tallest 565 px at 390 on 2026-10-12): its evidence folds.
    await page.goto('/evidence?tab=recipes');
    // evaluateAll does not wait: under a loaded full run it counted the cards before they loaded (0).
    await expect(page.locator('#main section.ne-card').nth(10)).toBeVisible();
    const cards = await page.locator('#main section.ne-card').evaluateAll(cs => cs.map(c => [c.querySelector('h2,h3')?.textContent ?? '', Math.round(c.getBoundingClientRect().height)] as const));
    expect(cards.length).toBeGreaterThan(10);
    expect(cards.filter(([, h]) => h > 650)).toEqual([]);
    // The connector table fits its card: no column cut at the right.
    await page.goto('/integrations');
    const table = page.getByRole('region', { name: 'Connector health' }).first();
    await expect(table.locator('tbody tr').first()).toBeVisible();
    expect(await table.evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
    // The API capabilities table stacks too: the role to grant is on screen, not 600 px to the right (G1.11).
    await page.evaluate(() => document.querySelectorAll('details').forEach(d => (d.open = true)));
    const caps = page.getByRole('region', { name: 'API capabilities by service' });
    expect(await caps.evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
    // The runs of this repository lead, open; the other kinds are folded with their count.
    await page.goto('/evidence');
    await expect(page.locator('details#ev-repo-live')).toHaveAttribute('open', '');
    // Only the newest live session is open; each earlier one folds under its date and count, so the page stays one session long.
    const earlier = page.locator('details#ev-repo-live details[id^="ev-repo-live-"]');
    expect(await earlier.count()).toBeGreaterThan(0);
    await expect(earlier.first().locator('> summary')).toHaveText(/^Session \d{4}-\d{2}-\d{2} \(\d+\)$/);
    for (const d of await earlier.all()) await expect(d).not.toHaveAttribute('open', '');
    await expect(page.locator('details#ev-mocked-plan-test')).not.toHaveAttribute('open', '');
    await expect(page.locator('details#ev-mocked-plan-test summary')).toContainText(/Mocked plan test \(\d+\)/);
  });
}

test('S3: the inventory connector reads the same on its card, in the Integrations table and on the Overview', async ({ page }) => {
  await page.goto('/integrations');
  const card = page.locator('section.ne-card').filter({ has: page.getByRole('heading', { name: 'Nebius inventory (REST API)', exact: true }) });
  // The stub's first sync may still run under a loaded suite ("sync in progress"): wait for the settled label.
  const badge = card.locator('.ne-card-head .ne-badge').first();
  await expect(badge).toHaveText(/^partial \(3 calls refused, \d+ failing or rejected, \d+ waiting for data\)$/);
  const label = (await badge.innerText()).trim();
  await expect(page.getByRole('table', { name: 'Connector health' }).getByRole('row', { name: /Nebius inventory/ })).toContainText(label);
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Connector health' }).locator('.ne-badge')).toHaveText(`1 ${label}`);
});

test('S2: Costs with an empty range says how many rows the range and the imports hold, and that completeness is the whole export', async ({ page }) => {
  await page.goto('/costs?from=2025-01-01&to=2025-01-02');
  await expect(page.getByText('No billed rows in this range')).toBeVisible();
  const data = page.getByRole('region', { name: 'Data', exact: true });
  await expect(data).toContainText(/0\s*rows in this range/);
  await expect(data).toContainText(/[\d,]+ rows in the imports in all · superseded rows are deleted on import/);
  expect((await data.innerText()).trim()).not.toMatch(/·\s*$|import\(s\)/);
  const rows = (await data.innerText()).match(/([\d,]+) rows in the imports/)![1];
  await expect(page.getByText(new RegExp(`The imports hold ${rows} row`))).toBeVisible();
  await expect(page.getByRole('region', { name: 'Completeness' })).toContainText('Completeness (whole export)');
  await expect(page.getByRole('region', { name: 'Completeness' })).toContainText('Not limited to the chosen range.');
  // The whole period: no range wording.
  await page.goto('/costs');
  await expect(page.getByRole('region', { name: 'Data', exact: true })).toContainText(/active rows/);
  await expect(page.getByRole('region', { name: 'Completeness' })).not.toContainText('whole export');
});

test('S6: every page writes numbers one way: a space before %, °C, h and "/ h", thousands grouped', async ({ page }) => {
  test.setTimeout(180_000);
  const BAD: [string, RegExp][] = [
    ['percent without a space', /\d%/],
    ['°C without a space', /\d°C/],
    ['hours without a space', /\b\d+(?:\.\d+)?h\b/],
    ['per hour without spaces', /[A-Z]{3}\/ ?h\b|\d\/h\b/],
    ['amount without grouping', /(?<![\d,.])\d{4,}\.\d{2}\b/],
  ];
  const found: string[] = [];
  for (const path of ['/', '/capacity', '/fleet', '/alerts', '/alerts?tab=rules', '/costs', '/commercial', '/budgets', '/ai-services', '/provisioning']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const tabs = await page.locator('#main [role=tab]').count();
    for (let t = 0; t <= tabs; t++) {
      if (t) await page.locator('#main [role=tab]').nth(t - 1).click();
      await page.evaluate(() => document.querySelectorAll('#main details').forEach(d => (d.open = true)));
      // Visible text only: ids, timestamps and code are not numbers with units.
      // Each element's own text, one per line (adjacent table cells never run together).
      const text = await page.locator('#main').evaluate(el => {
        const out: string[] = [];
        const walk = (n: Element) => {
          if (n.matches('code, pre, .ne-mono, time, svg')) return;
          const own = [...n.childNodes].filter(c => c.nodeType === 3).map(c => c.textContent ?? '').join('');
          if (own.trim()) out.push(n.textContent ?? '');
          for (const c of n.children) walk(c);
        };
        walk(el);
        return out.join('\n');
      });
      for (const [name, rx] of BAD) {
        const m = rx.exec(text.replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/g, ''));
        if (m) found.push(`${path} tab ${t}: ${name}: "${text.slice(Math.max(0, m.index - 30), m.index + 20).replace(/\s+/g, ' ')}"`);
      }
    }
  }
  expect(found).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`N4: Fleet roll-up names and Costs share labels are whole, never cut (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/costs');
    const labels = page.getByRole('list', { name: 'Cost share' }).locator('.ne-barlist-label');
    await expect(labels.first()).toBeVisible();
    expect(await labels.count()).toBeGreaterThan(1);
    expect(await labels.evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth + 1 || getComputedStyle(e).textOverflow === 'ellipsis').map(e => e.textContent))).toEqual([]);
    await page.goto('/fleet');
    const names = page.getByRole('table', { name: 'Node groups and standalone VMs' }).locator('tbody td:first-child span[title]');
    await expect(names.first()).toBeVisible();
    expect(await names.count()).toBeGreaterThan(1);
    // Heat-map labels are whole (they wrap), so two runs of one name read apart.
    const heat = page.locator('.ne-heat-label');
    expect(await heat.evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth + 1 || getComputedStyle(e).textOverflow === 'ellipsis').map(e => e.textContent))).toEqual([]);
    // A name never wraps a letter or two at a time: each is at least 14 characters wide.
    for (const n of await names.all()) expect((await n.boundingBox())!.width).toBeGreaterThan(90);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  });
}
