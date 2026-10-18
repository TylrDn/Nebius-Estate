import { expect, Page, Route, test } from '@playwright/test';
import { axeBuilder } from './axe';

/**
 * Overview and Integrations (Wave 1, G6) against the e2e stub: counts that agree with their tables, one incident for one
 * connector's failed sync, a Fix link on every Unavailable, the setup checklist, docs coverage and the phone layout.
 * Where the stub has no such case, the reply is changed in the test (route), never the stub's shared data.
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

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Rewrites a JSON reply (the real one from the stub, then `edit`). */
async function editReply(page: Page, glob: string, edit: (body: any) => void) {
  await page.route(glob, async (route: Route) => {
    const res = await route.fetch();
    const body = await res.json();
    edit(body);
    await route.fulfill({ response: res, json: body });
  });
}

test('#7, W1-P29: every connector count on the Overview is a filter link, and the filtered Integrations table lists exactly that many', async ({ page }) => {
  await page.goto('/');
  const health = page.getByRole('region', { name: 'Connector health' });
  await expect(health).toContainText(/\d+ connectors: \d+ ok/);
  const chips = health.locator('a.ne-chip-link');
  const n = await chips.count();
  expect(n).toBeGreaterThanOrEqual(3);
  const seen: { text: string; count: number }[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const text = ((await chips.nth(i).textContent()) ?? '').trim();
    seen.push({ text, count: Number(/^(\d+)/.exec(text)![1]) });
  }
  // "Not needed" is its own count, never inside "ok" (#7).
  expect(seen.map(s => s.text)).toEqual(expect.arrayContaining([expect.stringMatching(/^\d+ ok$/), expect.stringMatching(/^1 not needed$/)]));
  for (const { text, count } of seen) {
    await page.goto('/');
    await page.getByRole('region', { name: 'Connector health' }).getByRole('link', { name: text, exact: true }).click();
    await expect(page).toHaveURL(/\/integrations\?connectors=/);
    const table = page.getByRole('table', { name: 'Connector health' });
    await expect(table.locator('tbody tr')).toHaveCount(count);
    // The chip on Integrations says the same count and is marked as the active filter.
    await expect(page.locator('#connector-summary a.ne-chip-link[aria-current="true"]')).toHaveText(text);
    total += count;
  }
  await page.getByRole('link', { name: 'Show every connector' }).click();
  await expect(page.getByRole('table', { name: 'Connector health' }).locator('tbody tr')).toHaveCount(total);
});

test('#35, #28, W1-P27: one connector\'s failed sync is one incident of that connector, with its calls and recovery, not "every connector"', async ({ page }) => {
  const T1 = '2026-10-12T16:23:00.000Z';
  const T2 = '2026-10-12T16:38:00.000Z';
  const failedOnce = (h: any) => ({
    ...(h ?? { p50Ms: 5, p95Ms: 9 }),
    runs24h: 2,
    failures24h: 1,
    successRate24h: 0.5,
    consecutiveFailures: 0,
    lastFailureAt: T1,
    recentRuns: [
      { at: T2, ok: true, durationMs: 9 },
      { at: T1, ok: false, durationMs: 9, errorClass: 'unreachable' },
    ],
  });
  let calls = 0;
  await editReply(page, '**/api/nebius-estate/integrations', body => {
    for (const c of body.capabilities ?? []) {
      if (c.connector !== 'nebius-inventory' || !c.health?.runs24h) continue;
      c.health = failedOnce(c.health);
      calls++;
    }
    const inv = body.statuses.find((s: any) => s.id === 'nebius-inventory');
    inv.health = failedOnce(inv.health);
  });
  await page.goto('/integrations');
  const callout = page.getByRole('list', { name: 'Failed syncs' });
  await expect(callout).toBeVisible();
  expect(calls).toBeGreaterThanOrEqual(3);
  await expect(callout).toContainText(`Nebius inventory (REST API): one sync failed across ${calls} calls`);
  await expect(callout).toContainText(/recovered 2026-10-12 16:38/);
  await expect(page.locator('#main')).not.toContainText('every connector at once');
  // The incident is not counted against each call: no call of it reads flaky.
  await page.evaluate(() => document.querySelectorAll('#capabilities details').forEach(d => ((d as HTMLDetailsElement).open = true)));
  await expect(page.locator('#capabilities')).toContainText('answered at the last sync');
  await expect(page.locator('#capabilities')).not.toContainText(/flaky/i);
});

test('W1-P28, #54: optional and not-needed connectors fold under a grey "Not applicable" group, never among the cards that need a look', async ({ page }) => {
  await page.goto('/integrations');
  const na = page.locator('#connectors-not-applicable');
  await expect(na).toContainText('Not applicable (1)');
  await expect(na).toContainText('External Prometheus: not needed. Not counted as gaps.');
  // Folded: its card is not on screen until opened, and the open cards above do not include it.
  expect(await na.evaluate(d => (d as HTMLDetailsElement).open)).toBe(false);
  await expect(page.locator('.ne-grid-2').first().getByRole('heading', { name: 'External Prometheus' })).toHaveCount(0);
  // In the counts it is grey text, not a badge, and the Overview's attention figure leaves it out.
  await expect(page.locator('#connector-summary a.ne-chip-link-na')).toHaveText('1 not needed');
});

test('#2, #4: each project-cap row names its project, and says acknowledging an intended cap with a note is the expected action', async ({ page }) => {
  await page.goto('/');
  const row = page.getByRole('region', { name: 'Needs attention' }).locator('li', { has: page.getByRole('link', { name: 'Project quota caps below the tenant limit' }) });
  await row.getByText('Show the list').click();
  const items = row.locator('.ne-ov-mini > li');
  await expect(items.first()).toBeVisible();
  const texts = await items.allTextContents();
  // Every cap row starts with a project name (the stub's projects are nip-…, legacy-research …), never a raw id.
  for (const t of texts.filter(x => /cap 0| of /.test(x))) expect(t).toMatch(/^[a-z][a-z0-9-]+ · /);
  expect(texts.join(' ')).not.toContain('project-e00');
  await expect(row).toContainText('Intended (a project kept small on purpose)? Acknowledge its alert with a note');
  await row.getByRole('link', { name: 'Acknowledge on Alerts' }).click();
  await expect(page).toHaveURL(/\/alerts$/);
});

for (const theme of THEMES) {
  test(`#25, #44: on a phone "Needs attention" is a short list, count first, with "Show all N checks"; widening never leaves it folded (${theme})`, async ({ page }) => {
    await useTheme(page, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const attention = page.getByRole('region', { name: 'Needs attention' });
    const summary = attention.locator('summary.ne-attn-summary');
    const rows = summary.locator('.ne-attn-sum-row');
    await expect(rows.first()).toBeVisible();
    const n = await rows.count();
    expect(n).toBeGreaterThanOrEqual(3);
    // One row per item, each starting with its count and on its own line(s): no run-on sentence.
    const boxes = await rows.evaluateAll(els => els.map(e => ({ top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom, text: e.textContent ?? '' })));
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].top).toBeGreaterThanOrEqual(boxes[i - 1].bottom - 1);
    for (const b of boxes) expect(b.text).toMatch(/^(\d+|unavailable) /);
    const checks = await attention.locator('ul.ne-attn-grid > li').count();
    await expect(summary.locator('.ne-attn-more')).toHaveText(`Show all ${checks} checks`);
    await expect(page.getByRole('region', { name: 'Projects · regions' })).toBeInViewport();
    await axe(page);
    // Open then close on the phone, then widen: the list is there with no fold (#44).
    await summary.click();
    await expect(summary.locator('.ne-attn-more')).toHaveText('Hide the list');
    await summary.click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(attention.locator('details.ne-attn-fold')).toHaveCount(0);
    await expect(attention.getByRole('link', { name: 'Scheduled maintenance' })).toBeVisible();
    await expect(attention.getByRole('link', { name: 'TTL expired' })).toBeVisible();
  });
}

for (const theme of THEMES) {
  test(`#24: on a phone the filters are one "Filters" control and the intro one sentence, so the first figures of Overview, Estate and Fleet are above the fold (${theme})`, async ({ page }) => {
    await useTheme(page, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    const first: [string, (p: Page) => ReturnType<Page['locator']>][] = [
      ['/', p => p.getByRole('region', { name: 'Projects · regions' })],
      ['/estate', p => p.getByRole('tab', { name: /All resources/ })],
      ['/fleet', p => p.locator('.ne-tile').first()],
    ];
    for (const [path, figure] of first) {
      await page.goto(path);
      const fold = page.locator('details.ne-filter-fold');
      await expect(fold).toBeVisible();
      await expect(fold.locator('summary')).toContainText('Filters: all projects · all regions · all stages');
      await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toBeHidden();
      await expect(page.locator('.ne-subtitle-more > summary')).toHaveText('More about this page');
      // The header ends in the top third; the page's first figure is on the first screen.
      const header = await page.locator('header.ne-header').boundingBox();
      expect(header!.y + header!.height).toBeLessThanOrEqual(300);
      const box = await figure(page).first().boundingBox();
      expect(box!.y).toBeLessThan(844);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    }
    // A filter applied from the link is named on the folded control, and the selects work once it is opened.
    await page.goto('/?stage=sandbox');
    await expect(page.locator('details.ne-filter-fold > summary')).toContainText('all projects · all regions · sandbox');
    await page.locator('details.ne-filter-fold > summary').click();
    await expect(page.getByRole('combobox', { name: 'Stage', exact: true })).toHaveValue('sandbox');
    await page.locator('.ne-subtitle-more > summary').click();
    await expect(page.locator('.ne-subtitle-more')).toContainText('Every number names its source');
    await axe(page);
    // A wide screen keeps the bar and the whole intro.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('details.ne-filter-fold')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Stage', exact: true })).toBeVisible();
  });
}

test('W1-P24: every Unavailable on the Overview carries exactly one Fix link, and each opens the page where the fix happens', async ({ page }) => {
  // Sources down: the live calculator, the alerts, no billing export imported and no rate book (other tests import one
  // into the shared database, so the reply is changed here). With the calculator down too, nothing prices the run-rate,
  // so the rate book is needed, not optional.
  for (const glob of ['**/api/nebius-estate/runrate?*', '**/api/nebius-estate/runrate']) {
    await editReply(page, glob, b => {
      delete b.value;
      delete b.rateBookOptional;
      b.unavailableReason = 'No rate book has been imported.';
    });
  }
  await page.route('**/api/nebius-estate/runrate/live*', route => route.fulfill({ status: 503, json: { error: { message: 'calculator unavailable' } } }));
  await page.route('**/api/nebius-estate/alerts?*', route => route.fulfill({ status: 500, json: { error: { message: 'alerts down' } } }));
  await editReply(page, '**/api/nebius-estate/billing/summary*', b => {
    b.health.imports = 0;
    b.health.rows = 0;
  });
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Run-rate (live)' })).toContainText('Unavailable');
  // Every tile or attention row that says Unavailable, and its links.
  const holders = page.locator('section.ne-tile:not(.ne-attn), .ne-attn-grid > li').filter({ has: page.locator('.ne-tile-unavailable, :text-is("Unavailable")') });
  const n = await holders.count();
  expect(n).toBeGreaterThanOrEqual(4);
  const fixes: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = holders.nth(i);
    const fix = h.locator('.ne-ov-setup a');
    await expect(fix, `${await h.textContent()}`).toHaveCount(1);
    await expect(fix).toHaveText(/^Fix: .+ →$/);
    fixes.push((await fix.getAttribute('href'))!);
  }
  expect(fixes).toEqual(expect.arrayContaining(['/commercial?tab=ratebooks', '/costs', '/alerts?tab=rules', '/integrations#connectors']));
  // The scripted click test: each Fix opens its page (and its section when it names one).
  for (const href of [...new Set(fixes)]) {
    await page.goto('/');
    await page.locator(`.ne-ov-setup a[href="${href}"]`).first().click();
    const url = new URL(page.url());
    expect(`${url.pathname}${url.search}${url.hash}`).toBe(href);
    await expect(page.locator('h1.ne-title')).not.toHaveText(/not found/i);
    const hash = href.split('#')[1];
    if (hash) await expect(page.locator(`[id="${hash}"]`)).toBeVisible();
  }
});

test('Rate book, one model: with no rate book and the live list price answering, the Overview says "not set (optional)" as Integrations says done, not Unavailable', async ({ page }) => {
  // No rate book in use (other tests import one into the shared database, so the reply is the backend's no-book reply).
  for (const glob of ['**/api/nebius-estate/runrate?*', '**/api/nebius-estate/runrate']) {
    await editReply(page, glob, b => {
      delete b.value;
      delete b.rateBookChoice;
      delete b.observedAt;
      b.unavailableReason = 'No rate book has been imported.';
      b.rateBookOptional = true;
    });
  }
  await page.goto('/');
  const tile = page.getByRole('region', { name: 'Run-rate at user rate book' });
  await expect(tile).toContainText('Not set (optional)');
  await expect(tile).toContainText(/Nebius list price/);
  await expect(tile).not.toContainText('Unavailable');
  await expect(tile.locator('.ne-ov-setup')).toHaveCount(0); // no Fix: nothing is broken
  await expect(page.getByRole('region', { name: 'Run-rate (live)' })).not.toContainText(/user rate book.*unavailable/);
  await page.goto('/integrations');
  const step = page.getByRole('region', { name: 'Day-one setup' }).locator('li', { hasText: 'Rate book or list price' });
  await expect(step.locator('.ne-badge')).toHaveText('done');
});

test('#5, #6: the billing export pull says its last import as information, by file name and month, not "Not covered:" with the key path', async ({ page }) => {
  await page.goto('/integrations');
  const row = page.getByRole('table', { name: 'Connector health' }).getByRole('row', { name: /Billing export pull/ });
  await expect(row).toContainText(/Last import: focus-export-2026-10-06\.csv\.gz \(2026-10\), \d+ rows/);
  await expect(row).not.toContainText('Not covered');
  await expect(row).not.toContainText('focus/focus-export');
  // On its card (healthy, so folded) it is the last sync's note, not a gap.
  await page.locator('#connectors-healthy > summary').click();
  const card = page.locator('section.ne-card').filter({ has: page.getByRole('heading', { name: 'Billing export pull (Object Storage)', exact: true }) });
  await card.getByText('Permissions, services and run history').click();
  await expect(card).toContainText(/Last import: focus-export-2026-10-06\.csv\.gz/);
  await expect(card).not.toContainText('Known gaps');
});

for (const theme of THEMES) {
  test(`#57: the capability matrix fits its card at 1440 px with paths broken at their separators, and an opened section shows its title once (${theme})`, async ({ page }) => {
    await useTheme(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/integrations#matrix');
    const matrix = page.locator('#matrix');
    const table = matrix.getByRole('table', { name: 'Capability matrix' });
    await expect(table).toBeVisible();
    const fit = await matrix.evaluate(e => ({ table: e.querySelector('table')!.getBoundingClientRect().width, wrap: e.querySelector('.ne-table-wrap')!.clientWidth }));
    expect(fit.table).toBeLessThanOrEqual(fit.wrap + 1);
    // No documented path is broken into a column of single characters: every line of a path cell is wider than 4 characters.
    const narrowest = await table.locator('.ne-mono').evaluateAll(els => Math.min(...els.map(e => e.getBoundingClientRect().width)));
    expect(narrowest).toBeGreaterThan(60);
    // Each opened section names itself once (its fold title), not again in a card title below it.
    for (const id of ['capabilities', 'coverage', 'matrix']) {
      await page.goto(`/integrations#${id}`);
      const fold = page.locator(`#${id}`);
      const title = ((await fold.locator('.ne-ref-title').textContent()) ?? '').replace(/\s*\(.*\)$/, '');
      const inner = await fold.locator('.ne-ref-body h2').allTextContents();
      expect(inner.filter(t => t.trim().startsWith(title))).toEqual([]);
    }
    await page.evaluate(() => document.querySelectorAll('details').forEach(d => ((d as HTMLDetailsElement).open = true)));
    await axe(page);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
}

for (const theme of THEMES) {
  for (const width of [1440, 390]) {
    test(`#11, W1-P26: the Nebius docs page lists the catalog with coverage against it, opens a page in the drawer, and searches by recipe (${theme}, ${width} px)`, async ({ page }) => {
      await useTheme(page, theme);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/nebius-docs');
      await expect(page.getByRole('heading', { name: 'Nebius docs', level: 1 })).toBeVisible();
      const coverage = page.locator('#docs-coverage');
      // Stated against the catalog: how many service sections are read, and the ones not read named with why.
      await expect(coverage).toContainText(/Reads \d+ of \d+ service sections of the Nebius docs catalog; not read: .*applications/);
      const apps = coverage.getByRole('row', { name: /applications/ });
      await expect(apps).toContainText('not read');
      await expect(apps).toContainText('The portal makes no call for applications.');
      await expect(apps).toContainText('Standalone applications are not listed');
      // The stub refuses VPC in one project only: VPC is still read.
      await expect(coverage.getByRole('row').filter({ has: page.getByRole('link', { name: 'vpc', exact: true }) })).toContainText('read');
      // A key page opens in the drawer; this checkout has no mirror, so it links to docs.nebius.com with its sections.
      await page.locator('#docs-key').getByRole('button', { name: 'Quotas in Nebius AI Cloud' }).click();
      const drawer = page.getByRole('dialog');
      await expect(drawer).toContainText('Not in the local mirror');
      await expect(drawer.getByRole('link', { name: 'Open on docs.nebius.com ↗' })).toHaveAttribute('href', 'https://docs.nebius.com/overview/quotas');
      await expect(drawer.getByRole('link', { name: 'Change quotas' })).toHaveAttribute('href', 'https://docs.nebius.com/overview/quotas#change-quotas');
      await expect(page).toHaveURL(/page=%2Foverview%2Fquotas/);
      await axe(page);
      await page.keyboard.press('Escape');
      // Search: by recipe, through the key pages' notes.
      await page.getByRole('searchbox', { name: 'Search the docs catalog' }).fill('R3');
      await expect(page.getByRole('button', { name: /InfiniBand™ networking for Compute virtual machines with GPUs/ }).first()).toBeVisible();
      await page.evaluate(() => document.querySelectorAll('details').forEach(d => ((d as HTMLDetailsElement).open = true)));
      await axe(page);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }
}

test('W1-P29: the Healthy group and the "ok" chip share one count; an ok connector open for a look says why', async ({ page }) => {
  await page.goto('/integrations');
  const chips = page.getByRole('region', { name: 'Connector summary' });
  const ok = Number(/^(\d+) ok$/.exec(((await chips.getByRole('link', { name: /^\d+ ok$/ }).textContent()) ?? '').trim())![1]);
  const healthy = page.locator('#connectors-healthy summary').first();
  const m = /Healthy connectors \((\d+) of (\d+) ok\)/.exec((await healthy.textContent()) ?? '');
  expect(m).not.toBeNull();
  const [h, of] = [Number(m![1]), Number(m![2])];
  expect(of).toBe(ok);
  const open = page.getByRole('list', { name: 'Ok connectors open for a look' }).locator('li');
  await expect(open).toHaveCount(ok - h);
  if (ok - h) await expect(open.first()).toContainText(/: .+/);
});

test('W1-P26: with /integrations failing, the Nebius docs page says coverage is unavailable and gives no "not read" verdict', async ({ page }) => {
  await page.route('**/api/nebius-estate/integrations', route => route.fulfill({ status: 500, json: { error: { message: 'integrations down' } } }));
  await page.goto('/nebius-docs');
  const coverage = page.locator('#docs-coverage');
  await expect(coverage).toContainText('Coverage unavailable: integrations down');
  await expect(coverage.getByRole('alert')).toContainText('integrations down');
  await expect(page.locator('#main')).not.toContainText('No call for it');
  await expect(page.locator('#main')).not.toContainText(/Reads 0 of|Not read by the portal/);
  await expect(coverage).not.toContainText('not read');
  // The catalog itself still lists: the sections are there, with their pages, without a verdict.
  await expect(page.locator('#docs-section-compute')).toBeVisible();
});

test('W1-P26: while /integrations loads, the Nebius docs page shows no coverage verdict', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(r => (release = r));
  await page.route('**/api/nebius-estate/integrations', async route => {
    await held;
    await route.fallback();
  });
  await page.goto('/nebius-docs');
  await expect(page.locator('#docs-section-compute')).toBeVisible();
  await expect(page.locator('#main')).not.toContainText(/Reads 0 of|No call for it|Not read by the portal/);
  release();
  await expect(page.locator('#docs-coverage')).toContainText(/Reads \d+ of \d+ service sections/);
});

test('W1-P26: Slurm is read only through a Soperator cluster: the stub\'s one is provisioning, so the section is not counted as read', async ({ page }) => {
  await page.goto('/nebius-docs');
  const coverage = page.locator('#docs-coverage');
  const slurm = coverage.getByRole('row').filter({ has: page.getByRole('link', { name: 'slurm-soperator', exact: true }) });
  await expect(slurm).toContainText('called, not answering');
  await expect(slurm).toContainText('0 of 1 call answered');
  await expect(coverage).toContainText(/not read: .*slurm-soperator/);
});

test('W1-P26: Integrations states its coverage against the docs catalog, each section linking to the Nebius docs page', async ({ page }) => {
  await page.goto('/integrations');
  const fold = page.locator('#docs-coverage');
  await expect(fold.locator('.ne-ref-hint')).toContainText(/Reads \d+ of \d+ service sections of the Nebius docs catalog; not read: .*applications/);
  await fold.locator('summary').click();
  await fold.getByRole('row', { name: /applications/ }).getByRole('link', { name: 'applications' }).click();
  await expect(page).toHaveURL(/\/nebius-docs\?section=applications/);
  await expect(page.locator('#docs-section-applications')).toHaveAttribute('open', '');
});

test('#11: Capacity, Alerts and the Evidence recipe cards link the Nebius docs page', async ({ page }) => {
  await page.goto('/capacity#quotas');
  await page.getByRole('link', { name: 'Quotas in Nebius AI Cloud' }).first().click();
  await expect(page).toHaveURL(/\/nebius-docs\?page=%2Foverview%2Fquotas/);
  await expect(page.getByRole('dialog')).toContainText('Quotas in Nebius AI Cloud');
  await page.goto('/alerts');
  await page.getByRole('link', { name: 'Nebius docs: metrics →' }).click();
  await expect(page.getByRole('dialog')).toContainText('Metrics in Nebius AI Cloud');
  await page.goto('/evidence?tab=recipes');
  const r3 = page.getByRole('link', { name: /^Nebius docs for R3 \(\d+\)$/ });
  await expect(r3).toBeVisible();
  await r3.click();
  await expect(page).toHaveURL(/\/nebius-docs\?q=R3/);
  await expect(page.getByRole('button', { name: /InfiniBand™ networking for Compute virtual machines with GPUs/ }).first()).toBeVisible();
});

for (const theme of THEMES) {
  test(`W1-P25: Integrations opens with the day-one setup checklist, each step done, in progress or to do, with where to do it (${theme})`, async ({ page }) => {
    await useTheme(page, theme);
    await page.goto('/integrations');
    const setup = page.getByRole('region', { name: 'Day-one setup' });
    const rows = setup.locator('li');
    await expect(rows).toHaveCount(6);
    // Web-first: a step whose read is still loading says "checking" first (a full run read one mid-load).
    const state = (label: string) => setup.locator('li', { hasText: label }).locator('.ne-badge');
    // The stub: a partial inventory sync, an imported export file, the live list price, a config budget, unlabelled resources, clusters.
    await expect(state('Connected to Nebius')).toHaveText('in progress');
    await expect(state('Billing export')).toHaveText('done');
    await expect(state('Rate book or list price')).toHaveText('done');
    await expect(state('Budgets')).toHaveText('done');
    await expect(state('Labels')).toHaveText('in progress');
    await expect(state('Kubernetes access')).toHaveText('done');
    await expect(setup).toContainText(/Day-one setup: 4 of 6 done/);
    await expect(setup.locator('li', { hasText: 'Labels' })).toContainText(/\d+ of \d+ resources carry no nip-\* labels/);
    await setup.locator('li', { hasText: 'Labels' }).getByRole('link').click();
    await expect(page).toHaveURL(/\/estate\?view=unattributed/);
    await page.goBack();
    await setup.locator('li', { hasText: 'Connected to Nebius' }).getByRole('link', { name: 'See the refused calls →' }).click();
    await expect(page.getByRole('table', { name: 'Connector health' }).locator('tbody tr')).toHaveCount(1);
    await axe(page);
  });
}

test('W1-P25: reads still loading show as checking, not "to do", and are left out of the done count', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(r => (release = r));
  for (const glob of ['**/api/nebius-estate/budgets', '**/api/nebius-estate/resources', '**/api/nebius-estate/ratebooks']) {
    await page.route(glob, async route => {
      await held;
      await route.fallback();
    });
  }
  await page.goto('/integrations');
  const setup = page.getByRole('region', { name: 'Day-one setup' });
  await expect(setup.locator('li', { hasText: 'Budgets' })).toContainText('checking');
  await expect(setup.locator('li', { hasText: 'Labels' })).toContainText('checking');
  await expect(setup).not.toContainText('Not readable with your role.');
  await expect(setup).toContainText(/Day-one setup: \d+ of \d+ done · 2 checking/);
  release();
  await expect(setup).toContainText(/Day-one setup: 4 of 6 done(?! ·)/);
  await expect(setup).not.toContainText('checking');
});

test('W1-P25: a read that fails (500) says unavailable with its error, never a role problem', async ({ page }) => {
  await page.route('**/api/nebius-estate/budgets', route => route.fulfill({ status: 500, json: { error: { message: 'budgets store down' } } }));
  await page.goto('/integrations');
  const setup = page.getByRole('region', { name: 'Day-one setup' });
  const budgets = setup.locator('li', { hasText: 'Budgets' });
  await expect(budgets).toContainText('unavailable');
  await expect(budgets).toContainText('Unavailable: budgets store down');
  await expect(budgets).not.toContainText('Not readable with your role.');
  await expect(setup).toContainText(/Day-one setup: 3 of 5 done · 1 unavailable/);
});

test('W1-P25: a deployment with no budget and nothing readable says "to do" and "not readable", never "done"', async ({ page }) => {
  await editReply(page, '**/api/nebius-estate/budgets', b => {
    b.budgets = [];
    b.configBudgets = [];
    b.credits = [];
  });
  await page.route('**/api/nebius-estate/resources', route => route.fulfill({ status: 403, json: { error: { name: 'NotAllowedError', message: 'You do not have nebius.estate.read.' } } }));
  await page.goto('/integrations');
  const setup = page.getByRole('region', { name: 'Day-one setup' });
  await expect(setup.locator('li', { hasText: 'Budgets' })).toContainText('to do');
  await expect(setup.locator('li', { hasText: 'Budgets' })).toContainText('No budget: spend is not checked against an amount.');
  await expect(setup.locator('li', { hasText: 'Budgets' }).getByRole('link', { name: 'Add a budget →' })).toHaveAttribute('href', '/budgets');
  await expect(setup.locator('li', { hasText: 'Labels' })).toContainText('Not readable with your role.');
});
