import { expect, Page, test } from '@playwright/test';
import { axeBuilder } from './axe';
// Test-only: locates the shared test data next to the stub.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'fs';
// eslint-disable-next-line no-restricted-imports
import { resolve } from 'path';

/**
 * Live audit 2026-10-12, section Costs (G4.x), against the e2e stub. The live conditions (a project or region with no
 * billing rows while other projects have hundreds, a date range inside the export, a midpoint gridline at 2.5, the
 * chart on a phone, contract-level tax without a project or region) are reproduced with the stub's e00mock export.
 * Scenario and rate-book checks change shared state and run in order in portal.test.ts; budget checks in
 * budgets-ai.test.ts.
 */

// eslint-disable-next-line no-restricted-syntax
const TEST_DATA = resolve(__dirname, '../../../e2e-stub');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function importFocus(page: Page) {
  await page.goto('/costs');
  await page.locator('input[type=file]').setInputFiles(resolve(TEST_DATA, 'focus.csv'));
  await expect(page.getByText(/^Imported \d+ rows/)).toBeVisible();
}

test('G4.1: a project with no rows in a region says so and counts the other rows, never "waiting for the first files"', async ({ page }) => {
  await importFocus(page);
  // nip-staging is billed in eu-north1 only.
  await page.goto('/costs?project=project-e00mockstaging&region=uk-south1');
  await expect(page.getByText('No billed rows for nip-staging in uk-south1')).toBeVisible();
  await expect(page.getByText(/The imports hold [\d,]+ rows for other projects or regions/)).toBeVisible();
  await expect(page.getByText('No billing data imported')).toHaveCount(0);
  await expect(page.getByText(/waiting for the first files/)).toHaveCount(0);
});

test('G4.2: the reporting period ends inside the chosen range; an empty range says it has no rows', async ({ page }) => {
  await importFocus(page);
  await page.goto('/costs?from=2026-10-07&to=2026-10-08');
  const end = page.getByTestId('period-end').first();
  await expect(end).toHaveText(/^through 2026-10-0[78] \d\d:\d\d UTC \(last hour shown\)$/);
  const text = (await end.textContent()) ?? '';
  expect(text.match(/2026-10-0\d \d\d:\d\d/)![0] <= '2026-10-08 00:00').toBe(true);
  await page.goto('/costs?from=2025-01-01&to=2025-01-02');
  await expect(page.getByTestId('period-end').first()).toHaveText('no rows in this range');
});

test('G4.4, G4.11: exact gridline labels, the currency in the chart title, 11 px labels on a phone', async ({ page }) => {
  await importFocus(page);
  await page.goto('/costs');
  const card = page.locator('.ne-card', { has: page.getByRole('heading', { name: /^Billed cost by day, XTS$/ }) });
  await expect(card).toBeVisible();
  const grid = await card.locator('svg g[aria-hidden] > g > text').allTextContents();
  const [zero, mid, max] = grid.map(t => Number(t.replace(/,/g, '')));
  expect(zero).toBe(0);
  expect(mid * 2).toBe(max); // never "3" for 2.5
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const tick = card.locator('svg g[aria-hidden] > text').first();
  await expect(tick).toBeVisible();
  const box = await tick.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(10); // was about 5 px, the 600-unit drawing scaled down
  expect(await card.locator('svg g[aria-hidden] > text').count()).toBeLessThanOrEqual(4);
});

test('G4.13: contract-level tax is named on every tab and the label column sorts by the text shown', async ({ page }) => {
  await importFocus(page);
  await page.goto('/costs');
  const table = page.getByRole('table', { name: 'Cost breakdown' });
  for (const tab of ['Project', 'Region', 'Service']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(table.getByText(`Tax / contract-level (no ${tab.toLowerCase()})`)).toBeVisible();
  }
  await page.getByRole('tab', { name: 'Project', exact: true }).click();
  await table.getByRole('button', { name: /^Project/ }).click();
  const labels = (await table.locator('tbody tr td:first-child').allTextContents()).map(t => t.trim());
  expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  expect((await axeBuilder(page).include('#main').withTags(AXE_TAGS).analyze()).violations).toEqual([]);
});

test('G4.16: rate book prices sort', async ({ page }) => {
  await page.goto('/commercial?tab=ratebooks');
  await page.locator('input[type=file]').setInputFiles(resolve(TEST_DATA, 'ratebook.json'));
  const rates = page.getByRole('table', { name: 'Rates' });
  await rates.getByRole('button', { name: /^Price/ }).click();
  const prices = (await rates.locator('tbody tr td:nth-child(5)').allTextContents()).map(t => Number(t.split(' ')[0]));
  expect(prices).toEqual([...prices].sort((a, b) => a - b));
});

test('#47, #67, #68: resources told apart by type; the stacked breakdown scrolls with the page at 390 px; imports name the usage hours', async ({ page }) => {
  await importFocus(page);
  await page.goto('/costs');
  await page.getByRole('tab', { name: 'Resource' }).click();
  const table = page.getByRole('table', { name: 'Cost breakdown' });
  await expect(table).toContainText(' · VM');
  await expect(table).toContainText(' · disk');
  // No two rows read the same (a VM and its boot disk share a name).
  const labels = await table.locator('tbody tr td:first-child').allInnerTexts();
  expect(new Set(labels).size).toBe(labels.length);
  // #68: the imports table names the hours the file's usage covers, not the month of its tax row.
  const imports = page.getByRole('table', { name: 'Billing imports' });
  await expect(imports.getByRole('columnheader', { name: 'Usage hours' })).toBeVisible();
  await expect(imports.getByRole('row', { name: /focus\.csv/ }).first()).not.toContainText(/→ \d{4}-\d{2}-01 00:00 UTC/);
  // #67: on a phone a short stacked breakdown (projects) has no box of its own; long ones keep the page-wide 75vh box.
  await page.getByRole('tab', { name: 'Project' }).click();
  // The project breakdown has replaced the resource one (a few rows, no page-wide box). While it loads the resource
  // rows are not shown under the project heading (they were, and a tall box was measured: the G2 e2e flake).
  await expect(table).not.toContainText(' · VM');
  await expect(table.getByRole('columnheader', { name: 'Project' })).toBeVisible();
  await expect(table).toContainText('Tax / contract-level (no project)');
  await expect(page.getByRole('region', { name: 'Cost breakdown' })).not.toHaveClass(/ne-table-wrap-tall/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('combobox', { name: 'Sort Cost breakdown by' }).waitFor();
  const box = page.getByRole('region', { name: 'Cost breakdown' });
  expect(await box.evaluate(e => getComputedStyle(e).maxHeight)).toBe('none');
  expect(await box.evaluate(e => e.scrollHeight - e.clientHeight)).toBeLessThanOrEqual(1);
});

const down = { status: 503, json: { error: { name: 'ServiceUnavailableError', message: 'The portal database is unavailable (e2e).' } } };

test('#74: Costs, Budgets and Commercial say a failed read with a Retry that recovers', async ({ page }) => {
  for (const [path, url, route] of [
    ['/costs', '/costs', '**/api/nebius-estate/billing/summary*'],
    ['/budgets', '/budgets', '**/api/nebius-estate/budgets'],
    ['/commercial', '/commercial', '**/api/nebius-estate/scenarios'],
  ] as const) {
    await page.route(route, r => r.fulfill(down));
    await page.goto(url);
    const state = page.getByRole('alert').filter({ hasText: 'This view could not be loaded' });
    await expect(state, path).toContainText('The portal database is unavailable (e2e).');
    await page.unroute(route);
    await state.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByText('This view could not be loaded'), path).toHaveCount(0);
  }
});

test('#74: a scenario whose estimate fails says "Estimate unavailable" with the reason, never a figure', async ({ page }) => {
  const { scenarios } = JSON.parse(readFileSync(resolve(TEST_DATA, 'scenarios.json'), 'utf8'));
  await page.route('**/api/nebius-estate/scenarios', r => r.fulfill({ json: { items: [{ ...scenarios[0], createdBy: 'user:default/e2e', updatedAt: '2026-10-12T00:00:00Z' }] } }));
  await page.route('**/api/nebius-estate/estimate', r => r.fulfill({ status: 500, json: { error: { name: 'Error', message: 'Estimating failed (e2e).' } } }));
  await page.goto('/commercial');
  const callout = page.getByText('Estimate unavailable').locator('..');
  await expect(callout).toContainText('Estimating failed (e2e).');
  await expect(page.locator('#draft-quote')).toHaveCount(0);
});

test('W1-P10: the live and rate-book run-rate tiles count the same running resources, in the same words', async ({ page }) => {
  await page.goto('/commercial?tab=ratebooks');
  await page.locator('input[type=file]').setInputFiles(resolve(TEST_DATA, 'ratebook.json'));
  await expect(page.getByText(/Imported rate book Test rate book/)).toBeVisible();
  await page.goto('/');
  const live = page.getByRole('region', { name: 'Run-rate (live)' }).getByTestId('live-runrate-count');
  const book = page.getByRole('region', { name: 'Run-rate at user rate book' });
  await expect(live).toHaveText(/^\d+ resources? priced, \d+ without a price$/);
  await expect(book).toContainText(/\d+ resources? priced, \d+ without a price/);
  const total = (t: string) => {
    const m = /(\d+) resources? priced, (\d+) without a price/.exec(t)!;
    return Number(m[1]) + Number(m[2]);
  };
  expect(total((await book.textContent()) ?? '')).toBe(total((await live.textContent()) ?? ''));
  // One count per tile: the breakdown is not a second number in another unit ("19 priced line(s)").
  const liveTile = page.getByRole('region', { name: 'Run-rate (live)' });
  await expect(liveTile).not.toContainText(/priced line/);
  await expect(liveTile.getByText('Price breakdown by kind of resource')).toBeVisible();
});

test('#12: Costs and Budgets name the next pull beside the export freshness; one export file is no cadence, so no next-file estimate', async ({ page }) => {
  await importFocus(page);
  await page.goto('/costs');
  const costs = page.getByRole('region', { name: 'Export lag' }).getByTestId('export-freshness');
  await expect(costs).toHaveText(/^next pull (\d{4}-\d{2}-\d{2} )?\d{2}:\d{2} UTC$/);
  await page.goto('/budgets');
  await expect(page.getByRole('region', { name: 'Spend this month' }).getByTestId('export-freshness')).toHaveText(/^next pull (\d{4}-\d{2}-\d{2} )?\d{2}:\d{2} UTC$/);
  // The stub bucket holds one file: the cadence cannot be observed, so nothing is estimated.
  await expect(page.getByText(/next export file/)).toHaveCount(0);
});

test('W1-P7: a rate book built from current list prices or a CSV is previewed and validated before it is saved', async ({ page }) => {
  await page.goto('/commercial?tab=ratebooks');
  await page.getByRole('button', { name: 'Build a rate book: from current list prices, or a CSV' }).click();
  // From list prices: eu-north1, H100 only. Sorted after test-xts, so the run-rate book of other tests is unchanged.
  await page.getByRole('group', { name: 'Regions' }).getByRole('checkbox', { name: 'eu-north1' }).check();
  await page.getByRole('group', { name: /Platforms/ }).getByRole('checkbox', { name: 'gpu-h100-sxm' }).check();
  await page.getByLabel('Rate book id').first().fill('zzz-list-e2e');
  await page.getByLabel('Rate book name').first().fill('E2E list prices');
  await page.getByRole('button', { name: 'Price now and preview' }).click();
  const preview = page.locator('.ne-card', { has: page.getByTestId('book-preview') });
  await expect(preview).toContainText(/Preview: E2E list prices · \d+ rates · XTS/);
  await expect(preview.getByRole('table', { name: 'Rates in the preview' })).toContainText('1gpu-16vcpu-200gb');
  // Nothing stored yet.
  await expect(page.getByLabel('Rate book', { exact: true }).locator('option', { hasText: 'E2E list prices' })).toHaveCount(0);
  await preview.getByRole('button', { name: 'Save rate book' }).click();
  await expect(page.getByText(/^Saved rate book E2E list prices \(\d+ rates, public\)\.$/)).toBeVisible();
  await page.getByRole('button', { name: 'Delete rate book E2E list prices' }).click();
  await page.getByRole('button', { name: 'Confirm: delete rate book E2E list prices from the portal' }).click();
  await expect(page.getByText('Deleted rate book E2E list prices.')).toBeVisible();
  // A CSV with a wrong row is named row by row and has no Save (the builders stay open).
  await page.locator('#csv-name').fill('E2E CSV');
  await page.locator('#csv-id').fill('zzz-csv-e2e');
  await page.locator('#csv-currency').fill('XTS');
  const header = 'id,region,service,platform,preset,component,quantity,per,capacity_type,price,effective_from,effective_to,source,bundles,note';
  await page.getByLabel('Rate book CSV file').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(`${header}\ngpu,eu-north1,compute,gpu-h100-sxm,,gpu,gpu,week,on-demand,2,2026-10-01,,test data,,\n`) });
  await expect(preview).toContainText('row 2: per: must be one of second, hour, month730');
  await expect(preview.getByRole('button', { name: 'Save rate book' })).toHaveCount(0);
  await page.getByLabel('Rate book CSV file').setInputFiles({ name: 'good.csv', mimeType: 'text/csv', buffer: Buffer.from(`${header}\ngpu,eu-north1,compute,gpu-h100-sxm,,gpu,gpu,hour,on-demand,2,2026-10-01,,test data,vcpu;ram,\n`) });
  await expect(preview).toContainText('Preview: E2E CSV · 1 rates · XTS');
  await expect(preview.getByRole('button', { name: 'Save rate book' })).toBeVisible();
  await preview.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByTestId('book-preview')).toHaveCount(0);
  expect(await axeBuilder(page).include('#main').withTags(AXE_TAGS).analyze().then(r => r.violations.map(v => v.id))).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`New scenario: the rate-book select shows the whole name of the built-in list price (Wave 1 verification, ${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/commercial');
    await page.getByRole('tab', { name: /Scenarios/ }).click();
    const select = page.locator('#n-book');
    // The form is open when there is no scenario yet; else it opens from "New scenario".
    const button = page.getByRole('button', { name: 'New scenario' });
    await expect(select.or(button).first()).toBeVisible();
    if (!(await select.isVisible())) await button.click();
    await select.selectOption({ label: 'Nebius list price (live calculator)' });
    // The text's width in the select's own font, plus its padding and arrow, fits the select ("Nebius list price (live c…" at 1440 px).
    const fit = await select.evaluate((e: HTMLSelectElement) => {
      const s = getComputedStyle(e);
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      const text = ctx.measureText(e.options[e.selectedIndex].text).width;
      return { text: Math.ceil(text + parseFloat(s.paddingLeft) + parseFloat(s.paddingRight)), box: e.clientWidth };
    });
    expect(fit.text).toBeLessThanOrEqual(fit.box);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
}
