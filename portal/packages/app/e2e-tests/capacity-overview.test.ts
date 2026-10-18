import { expect, Page, test } from '@playwright/test';
import { axeBuilder } from './axe';

/**
 * Capacity, Overview and Integrations reconciled and compact (UI audit 2026-10-12, W1c: F1.10–F1.15), against the
 * e2e stub (e2e-stub/estate.json): an allowance on a reservation the block-group list does not show, a tenant vCPU
 * quota of 0 with 48 vCPUs in use, node groups scaled to zero and above their size, and an inventory sync with
 * three refused calls.
 */

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Opens every folded reference section and quota table on the page. */
async function openAll(page: Page) {
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => (d.open = true)));
}

test('F1.10: an empty reservation list beside an allowance on a block group and a reserved node group is explained', async ({ page }) => {
  await page.goto('/capacity');
  const reservations = page.locator('#reservations');
  await expect(reservations).toContainText('Reservation in use, not listed');
  await expect(reservations).toContainText(
    'capacity allowance h100-reserved-eu-north1 names reservation capacityblockgroup-e00mockh100 and node group nip-staging-training-gpu runs as reserved',
  );
  await expect(reservations).toContainText('An allowance names it; the list does not show it, and the API does not say why.');
  await expect(page.getByText('No reservations in this tenant')).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Capacity allowances' })).toContainText('not in the reservation list');
  // The availability matrix keeps its Reserved column: a reservation is in use.
  await page.getByRole('link', { name: 'Availability' }).click();
  await expect(page.getByRole('table', { name: 'Capacity availability matrix' }).getByRole('columnheader', { name: /Reserved/ })).toBeVisible();
  await expect(page.getByText(/The Reserved column is hidden/)).toHaveCount(0);
});

test('F1.10 under a region filter: the reservation text says the list was filtered and no region lists it', async ({ page }) => {
  await page.goto('/capacity?region=uk-south1');
  const reservations = page.locator('#reservations');
  // The node group in eu-north1 is filtered out; the allowance (which has no region) stays. The stub lists no block
  // group in any region, so the gap is the API's, and the words say the filter is on.
  await expect(reservations).toContainText('The reservation list shows none in uk-south1, yet capacity allowance h100-reserved-eu-north1 names reservation capacityblockgroup-e00mockh100.');
  await expect(reservations).toContainText('the list shows it in no region');
  await expect(reservations).not.toContainText('nip-staging-training-gpu');
});

test('F1.11: the tenant non-GPU vCPU quota shows the 48 in use against its limit of 0, flagged without opening anything', async ({ page }) => {
  await page.goto('/capacity');
  const flag = page.getByRole('list', { name: 'Quotas in use above their limit' });
  await expect(flag).toBeVisible();
  await expect(flag).toContainText('vCPUs for non-GPU VMs · eu-north1: 48 in use against a limit of 0: the projects report 48, the tenant 0.');
  await page.getByText('All tenant quotas (10)').click();
  const row = page.getByRole('table', { name: 'All quota allowances' }).getByRole('row', { name: /vCPUs for non-GPU VMs/ });
  await expect(row).toContainText('48 / 0 vCPUs');
  await expect(row).toContainText('above limit');
  // The Quotas header leads with it, in the danger tone.
  await expect(page.locator('#quotas .ne-badge', { hasText: /^1 in use above its limit · 0 at ≥ 80 % · 10 tenant quotas with a limit/ })).toHaveClass(/ne-tone-danger/);
  // The Overview counts it as an attention item of its own (danger), on a wide screen and in the phone summary.
  await page.goto('/');
  const attention = page.getByRole('region', { name: 'Needs attention' });
  const aboveRow = attention.getByRole('link', { name: 'Quotas in use above the limit' }).locator('xpath=ancestor::li');
  await expect(aboveRow.locator('.ne-badge').first()).toHaveText('1');
  await expect(aboveRow.locator('.ne-badge').first()).toHaveClass(/ne-tone-danger/);
  await expect(attention.getByText(/in use above its limit/)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(attention.locator('summary.ne-attn-summary')).toContainText('1 Quotas in use above the limit');
});

for (const width of [1440, 390]) {
  test(`F1.12: node-group quota checks are one-line badges with the sentence on hover; a scaled-to-zero or oversized group is not "all nodes up" (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/capacity');
    const table = page.getByRole('table', { name: 'Node groups' });
    const zero = table.getByRole('row', { name: /nip-staging-training-gpu/ });
    await expect(zero).toContainText('0 nodes (min 0)');
    await expect(zero).not.toContainText('all nodes up');
    const above = table.getByRole('row', { name: /nip-sandbox-inference-system/ });
    await expect(above.locator('.ne-badge', { hasText: '1 above fixed 2' })).toHaveAttribute('title', '3 nodes observed; the spec fixes 2; the API does not say why.');
    const badges = table.locator('td .ne-badge[title]');
    expect(await badges.count()).toBeGreaterThan(4);
    for (const b of await badges.all()) {
      const box = (await b.boundingBox())!;
      expect(box.height).toBeLessThan(30); // one line (the audit saw nine)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    // At 1440 px every column is in view: the short badges leave no column scrolled off to the right.
    if (width === 1440) expect(await page.getByRole('region', { name: 'Node groups' }).evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  });
}

test.describe('at 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('F1.13: Capacity leads with what to act on; reference sections are folded and open from "On this page"', async ({ page }) => {
    await page.goto('/capacity');
    await expect(page.locator('#node-groups')).toBeVisible();
    const order = await page.evaluate(() =>
      ['quotas', 'planned-quota', 'maintenance', 'node-groups', 'reservations', 'availability', 'platforms', 'gpu-telemetry', 'stage-policy', 'calculator'].map(id => Math.round(document.getElementById(id)!.getBoundingClientRect().top + window.scrollY)),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const id of ['availability', 'platforms', 'gpu-telemetry', 'stage-policy', 'calculator']) {
      await expect(page.locator(`details#${id}`)).not.toHaveAttribute('open', '');
    }
    // The audit measured ~24,700 px; folded, the page is under half of that.
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(12_000);
    await page.getByRole('navigation', { name: 'On this page' }).getByRole('link', { name: 'Calculator' }).click();
    await expect(page.locator('details#calculator')).toHaveAttribute('open', '');
    await expect(page.locator('#calculator').getByLabel('expected GPU nodes')).toBeVisible();
    await openAll(page);
    expect((await axeBuilder(page).include('#main').withTags(AXE_TAGS).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test('F1.15: the Overview folds its attention list to one line, so the first numbers are above the fold', async ({ page }) => {
    await page.goto('/');
    const attention = page.getByRole('region', { name: 'Needs attention' });
    await expect(attention.locator('summary.ne-attn-summary')).toContainText('TTL expired');
    await expect(attention.locator('details.ne-attn-fold')).not.toHaveAttribute('open', '');
    const projects = page.getByRole('region', { name: 'Projects · regions' });
    await expect(projects).toContainText('4 projects');
    expect((await projects.boundingBox())!.y + (await projects.boundingBox())!.height).toBeLessThanOrEqual(844);
    const gpus = page.getByRole('region', { name: 'GPUs on running VMs' }).locator('.ne-tile-label');
    expect((await gpus.boundingBox())!.y).toBeLessThan(844);
    await attention.locator('summary.ne-attn-summary').click();
    await expect(attention.getByRole('link', { name: 'Scheduled maintenance' })).toBeVisible();
    expect((await axeBuilder(page).include('#main').withTags(AXE_TAGS).analyze()).violations).toEqual([]);
  });
});

test('F1.14: a sync with refused calls reads "partial (N calls refused)" with a summary, no raw JSON and no link to its own page', async ({ page }) => {
  await page.goto('/integrations');
  const card = page.locator('section.ne-card').filter({ has: page.getByRole('heading', { name: 'Nebius inventory (REST API)', exact: true }) });
  await expect(card.getByText(/^partial \(3 calls refused/)).toBeVisible();
  await expect(card).toContainText('legacy-research refused Networks, Subnets and Object Storage buckets.');
  await expect(card.getByText('Permission denied', { exact: true })).toHaveCount(0);
  const summary = page.getByRole('table', { name: 'Connector health' });
  await expect(summary.getByRole('row', { name: /Nebius inventory/ })).toContainText('partial (3 calls refused');
  await expect(summary).toContainText('— in its card below');
  await expect(page.getByRole('link', { name: 'see Integrations' })).toHaveCount(0);
  await expect(page.locator('#main')).toContainText('Failing in legacy-research: permission denied (GET /vpc/v1/networks → 403 PermissionDenied)');
  const text = await page.locator('#main').innerText();
  expect(text).not.toContain('{"code"');
  expect(text).not.toContain('127.0.0.1');
});

test('F1.15: the Overview has one line of connector health and a link, not a second copy of the table', async ({ page }) => {
  await page.goto('/');
  const health = page.getByRole('region', { name: 'Connector health' });
  await expect(health).toContainText(/Connector health\s*\d+ connectors: \d+ ok · 1 partial \(3 calls refused, \d+ failing or rejected, \d+ waiting for data\)/);
  // Only the part that needs a look is a badge.
  await expect(health.locator('.ne-badge')).toHaveCount(1);
  await expect(health.locator('.ne-badge')).toContainText('1 partial (3 calls refused');
  await expect(page.getByRole('table', { name: 'Connector health' })).toHaveCount(0);
  await health.getByRole('link', { name: 'All integrations →' }).click();
  await expect(page).toHaveURL(/\/integrations$/);
  await expect(page.getByRole('table', { name: 'Connector health' })).toBeVisible();
});

test('F1.43: the connector table (on Integrations only) wraps its Issue column at 1440 px: nothing clipped, no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/integrations');
  const table = page.getByRole('table', { name: 'Connector health' });
  await expect(table).toBeVisible();
  const box = page.getByRole('region', { name: 'Connector health' }).filter({ has: table });
  expect(await box.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  const clipped = await table.locator('.ne-ov-issue').evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > (e.closest('.ne-card')?.getBoundingClientRect().right ?? Infinity) + 1).map(e => e.textContent));
  expect(clipped).toEqual([]);
});

for (const q of ['?project=project-e00mocksandbox', '?project=project-e00mockstaging', '?region=eu-north1', '?region=eu-north2']) {
  test(`F1.38 review: ${q} never raises the planned-roots-blocked count on Overview or Capacity`, async ({ page }) => {
    const overviewCount = async (query: string) => {
      await page.goto(`/${query}`);
      const row = page.getByRole('region', { name: 'Needs attention' }).locator('li', { has: page.getByRole('link', { name: 'Planned resources blocked by quota' }) });
      await expect(row).toBeAttached();
      await expect(row).not.toContainText('Unavailable');
      const text = (await row.locator('.ne-attn-row').textContent()) ?? '';
      return Number(text.replace('Planned resources blocked by quota', '').replace(/[^\d]/g, '') || '0');
    };
    const capacityCount = async (query: string) => {
      await page.goto(`/capacity${query}`);
      await expect(page.getByRole('heading', { name: 'Quotas' }).first()).toBeAttached();
      // count() does not wait: under a loaded run it read the Quotas card before its badge rendered (0 for 2). The
      // planned-roots card renders with the capacity reply, its title carrying the count; the badge must then agree.
      const card = page.getByRole('heading', { name: /^Planned resources against quota/ }).first();
      await expect(card).toBeVisible();
      await expect(card).toHaveText(/^Planned resources against quota · \d+ planned roots? blocked$/);
      const link = page.getByRole('link', { name: /^\d+ planned roots? blocked$/ });
      const titleCount = async () => Number(/· (\d+) planned roots? blocked/.exec((await card.textContent()) ?? '')?.[1] ?? '0');
      // The title and the badge are read until they agree: a full run once read the title before its count rendered.
      await expect.poll(async () => ((await titleCount()) ? 1 : 0) === (await link.count()), { timeout: 30_000 }).toBe(true);
      const n = await titleCount();
      return n ? Number(((await link.textContent()) ?? '').replace(/[^\d]/g, '')) : 0;
    };
    const base = { overview: await overviewCount(''), capacity: await capacityCount('') };
    expect(base.capacity).toBe(base.overview);
    // Each filter gets its own browser context and the unchanged 60 s budget. Combining all four
    // cases required ten full page loads and exhausted that budget on the shared CI runner.
    const o = await overviewCount(q);
    const c = await capacityCount(q);
    expect(o, `Overview ${q}`).toBeLessThanOrEqual(base.overview);
    expect(c, `Capacity ${q}`).toBeLessThanOrEqual(base.capacity);
    expect(c, `one number ${q}`).toBe(o);
  });
}
