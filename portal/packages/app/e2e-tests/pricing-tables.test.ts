import { expect, Page, test } from '@playwright/test';
import { axeBuilder } from './axe';
// Test-only: locates the shared test data next to the stub.
// eslint-disable-next-line no-restricted-imports
import { resolve } from 'path';

/**
 * Pricing, costs, tables and layout (UI audit 2026-10-12, W1d: F1.16–F1.24) against the e2e stub: the billing
 * calculator's invented XTS prices, the test rate book (e2e-stub/ratebook.json) and the FOCUS export the stub's
 * bucket serves.
 */

// eslint-disable-next-line no-restricted-syntax
const TEST_DATA = resolve(__dirname, '../../../e2e-stub');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const axe = async (page: Page) => (await axeBuilder(page).include('#main').withTags(AXE_TAGS).analyze()).violations.map(v => v.id);

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('F1.16: the Commercial subtitle names both sources: rate books and the Nebius live price', async ({ page }) => {
  await page.goto('/commercial');
  const header = page.locator('.ne-header');
  await expect(header).not.toContainText('No price is fetched');
  await expect(header).toContainText('user-managed rate books');
  await expect(header).toContainText('Nebius live price (billing calculator)');
});

test('F1.17: a reason every footprint shares is said once, in words', async ({ page }) => {
  // S2's B300 footprint is in eu-west2, where the stub lists no project: every capacity type fails alike.
  await page.goto('/solutions?price=S2');
  const panel = page.locator('.ne-card', { hasText: 'Price this footprint · S2' });
  await panel.getByLabel('Footprint file').selectOption({ label: 'footprint-b300.json · eu-west2 · 336 h' });
  await expect(panel.getByText(/No listed project is in eu-west2/)).toHaveCount(1);
  await expect(panel.getByRole('region', { name: /Nebius live price \(billing calculator\)/ }).first()).toContainText('The reason is above.');
});

test('F1.19: Costs names the cost metrics in words (FOCUS column as hint) and shows the range in force', async ({ page }) => {
  await page.goto('/costs');
  const metrics = page.getByRole('group', { name: 'Cost metric' });
  await expect(metrics.getByRole('button')).toHaveText(['Billed cost', 'Effective cost', 'List cost', 'Contracted cost']);
  await expect(metrics.getByRole('button', { name: 'Billed cost' })).toHaveAttribute('title', 'FOCUS column BilledCost');
  // No range in the link, yet the fields show the days the rows span (the end exclusive), marked as such.
  await expect(page).not.toHaveURL(/from=|to=/);
  const from = page.getByLabel('From (UTC)');
  const to = page.getByLabel('To (exclusive)');
  await expect(from).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(to).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  expect((await to.inputValue()) > (await from.inputValue())).toBe(true);
  await expect(page.getByText('first row (no start chosen)')).toBeVisible();
  await expect(page.getByText('after the last row (no end chosen)')).toBeVisible();
  // Choosing an end applies it and puts it in the link; Whole period clears both.
  await from.fill('2026-01-01');
  await expect(page).toHaveURL(/from=2026-01-01/);
  await expect(page.getByText('first row (no start chosen)')).toHaveCount(0);
  await page.getByRole('button', { name: 'Whole period' }).click();
  await expect(page).not.toHaveURL(/from=|to=/);
  expect(await axe(page)).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`F1.20: a table box that scrolls says how many rows it hides (Alerts → Rules, ${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto('/alerts?tab=rules');
    const box = page.getByRole('region', { name: 'Alert rules' });
    await expect(box.getByRole('row').nth(5)).toBeVisible();
    const cue = page.getByRole('button', { name: /more rows? below in Alert rules: scroll down/ });
    await expect(cue).toBeVisible();
    // On the first screen, not under the fold: the box is taller than what is left of the viewport (review of F1.20).
    const onScreen = () => cue.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight + 0.5; });
    expect(await onScreen()).toBe(true);
    // The count is the rows not seen at all: wholly below the box's edge, or under the cue where it holds at the foot
    // of the screen; a row the edge cuts is partly seen and not counted (F1.50).
    const hiddenRows = () =>
      box.evaluate(el => {
        const cueTop = el.nextElementSibling?.getBoundingClientRect().top ?? Infinity;
        const edge = Math.min(el.getBoundingClientRect().bottom, cueTop);
        return [...el.querySelectorAll('tbody > tr')].filter(r => r.getBoundingClientRect().top > edge - 1).length;
      });
    const hidden = await hiddenRows();
    expect(hidden).toBeGreaterThan(0);
    // F1.50: a row on screen, even cut by the edge, is never in the count ("25 more" with 25 rules).
    expect(hidden).toBeLessThan(await box.locator('tbody > tr').count());
    await expect(cue).toHaveText(`↓ ${hidden} more ${hidden === 1 ? 'row' : 'rows'} below`);
    // A click scrolls the rows on: fewer are hidden, and the cue says the new count.
    await cue.click();
    await expect.poll(hiddenRows).toBeLessThan(hidden);
    // Read together on each poll: the smooth scroll may still be moving.
    const shownCount = async () => ((await cue.isVisible()) ? Number((await cue.textContent())?.match(/\d+/)?.[0]) : 0);
    await expect.poll(async () => (await shownCount()) - (await hiddenRows())).toBe(0);
    // At the bottom of the box, with the box's end on screen, nothing is hidden: the cue goes.
    await box.evaluate(el => {
      el.scrollTo({ top: el.scrollHeight });
      window.scrollTo({ top: document.documentElement.scrollHeight });
    });
    await expect(cue).toHaveCount(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await axe(page)).toEqual([]);
  });
}

test('F1.21: the estate graph fits its box at 1440 px; region nodes name their project; containers have no status', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/estate');
  const graph = page.locator('.ne-graph');
  await expect(graph.locator('svg')).toBeVisible();
  // No sideways scroll inside the graph box: the drawing is scaled to its width.
  await expect.poll(() => graph.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await expect(page.getByText(/scroll the graph sideways/)).toHaveCount(0);
  // Two projects in eu-north1 are two groups, each named.
  await expect(page.getByRole('button', { name: /^eu-north1 Region · nip-sandbox/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^eu-north1 Region · nip-staging/ })).toBeVisible();
  // The table: a project reads "active" (its API state), never "running" (F1.44); a disk is "ready", not "running".
  const table = page.getByRole('table').first();
  await expect(table.getByRole('row', { name: /nip-sandbox project-e00mocksandbox/ }).getByRole('cell').nth(2)).toHaveText('active');
  await expect(table.getByRole('row', { name: /pvc-3f1c0e5a-tsdb/ })).toContainText('ready');
  await expect(table.getByRole('row', { name: /pvc-3f1c0e5a-tsdb/ })).not.toContainText('running');
  expect(await axe(page)).toEqual([]);
});

test('F1.21 at 390 px: the layered graph does not fit, so it is drawn as an indented tree that does (#21), never scrolling the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/estate');
  await expect(page.locator('.ne-graph svg')).toBeVisible();
  await expect(page.locator('.ne-graph')).toHaveAttribute('data-layout', 'tree');
  await expect(page.getByRole('note').filter({ hasText: 'Drawn as an indented tree to fit this screen' })).toBeVisible();
  await expect(page.getByText(/scroll the graph sideways/)).toHaveCount(0);
  // The box is no taller than the drawing it holds, nor than most of the screen.
  const sizes = await page.locator('.ne-graph').evaluate(el => ({ box: el.clientHeight, drawn: el.querySelector('svg')!.getBoundingClientRect().height, screen: window.innerHeight }));
  expect(sizes.box).toBeLessThanOrEqual(Math.ceil(sizes.drawn) + 1);
  expect(sizes.box).toBeLessThanOrEqual(sizes.screen * 0.7 + 1);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test('F1.23: Solutions is its own page in the nav; an old Evidence link lands there; every card has the same header and action row', async ({ page }) => {
  await page.goto('/evidence?tab=solutions&price=S4');
  await expect(page).toHaveURL(/\/solutions\?price=S4$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Solutions' })).toBeVisible();
  await expect(page.locator('#solution-price-panel')).toContainText('Price this footprint · S4');
  const assurance = page.getByRole('navigation', { name: 'Primary' }).getByRole('group', { name: 'Assurance' });
  await expect(assurance.getByRole('link')).toHaveText(['Evidence & Runbooks', 'Solutions', 'Nebius docs', 'Integrations & Coverage']);
  await expect(assurance.getByRole('link', { name: 'Solutions' })).toHaveAttribute('aria-current', 'page');
  await page.goto('/evidence');
  await expect(page.getByRole('tab', { name: /Solutions/ })).toHaveCount(0);
  await page.goto('/solutions');
  const cards = page.locator('.ne-sol-card');
  await expect(cards).toHaveCount(9);
  for (const card of await cards.all()) {
    // The header holds the title only; Price and Read sit in one row at the foot of the body.
    await expect(card.locator('.ne-card-head button')).toHaveCount(0);
    await expect(card.locator('.ne-sol-actions').getByRole('button', { name: /^(Price this footprint|Read solutions)/ }).first()).toBeVisible();
  }
  expect(await axe(page)).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`F1.23: "Price this footprint" on a card far down the page brings the price panel on screen and focuses it (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto('/solutions');
    await page.getByRole('button', { name: 'Price this footprint: S8' }).click();
    const panel = page.locator('#solution-price-panel');
    await expect(panel).toContainText('Price this footprint · S8');
    await expect.poll(() => panel.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < window.innerHeight; })).toBe(true);
    await expect(panel.getByRole('heading', { name: /Price this footprint · S8/ })).toBeFocused();
    // A price panel opened from the link (no click) leaves the page where it is.
  });
}

test('F1.23: every page in the nav has its own icon (the icon rail below 900 px has no labels)', async ({ page }) => {
  await page.goto('/');
  const links = page.getByRole('navigation', { name: 'Primary' }).getByRole('link');
  // evaluateAll does not wait: the nav is rendered first.
  await expect(links).toHaveCount(16);
  const icons = await links.evaluateAll(as => as.map(a => a.querySelector('svg')?.innerHTML ?? ''));
  expect(icons).toHaveLength(16);
  expect(icons.every(Boolean)).toBe(true);
  expect(new Set(icons).size).toBe(icons.length);
});

for (const scheme of ['dark', 'light'] as const) {
  test(`F1.24: the log list is sized to its lines; the bucket the query reads is clearly selected (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/logs?project=project-e00mocksandbox');
    const list = page.getByRole('region', { name: /^Log lines, \d+ in total/ });
    await expect(list).toBeVisible();
    const lines = await list.getByRole('button').count();
    const box = (await list.boundingBox())!;
    const row = (await list.getByRole('button').first().boundingBox())!;
    // A few lines: the box ends after them (no ~450 px of empty box).
    expect(lines).toBeLessThan(10);
    expect(box.height).toBeLessThanOrEqual(lines * row.height + 4);
    // The default preset reads the serial-console bucket: that bucket is the selected one, and looks it.
    const buckets = page.getByRole('group', { name: 'Buckets' });
    const selected = buckets.getByRole('button', { pressed: true });
    await expect(selected).toHaveCount(1);
    await expect(selected).toContainText('Compute VMs');
    const look = (b: import('@playwright/test').Locator) => b.evaluate(el => { const c = getComputedStyle(el); return `${c.borderColor}|${c.backgroundColor}`; });
    const other = buckets.getByRole('button', { pressed: false }).first();
    expect(await look(selected)).not.toEqual(await look(other));
    expect(await axe(page)).toEqual([]);
  });
}

test('F1.25: the nav lists the sixteen pages in their groups and order (as docs/portal/acceptance-checklist.md says)', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const groups = { Operate: ['Overview', 'Estate Explorer', 'GPU & Capacity', 'Fleet', 'Alerts', 'Logs', 'Workloads', 'AI services'], Change: ['Provisioning'], Finance: ['Costs', 'Commercial Scenarios', 'Budgets & credits'], Assurance: ['Evidence & Runbooks', 'Solutions', 'Nebius docs', 'Integrations & Coverage'] };
  for (const [group, links] of Object.entries(groups)) await expect(nav.getByRole('group', { name: group }).getByRole('link')).toHaveText(links);
  await expect(nav.getByRole('link')).toHaveCount(16);
});
