// Test-only: locates the shared test data next to the stub.
// eslint-disable-next-line no-restricted-imports
import { resolve } from 'path';
import { expect, Locator, Page, test } from '@playwright/test';

/**
 * One number, one name (UI audit 2026-10-12, W1a): a figure shown on two pages reads the same on both, or
 * each says what it covers. Against the e2e stub (e2e-stub/estate.json, focus.csv).
 */

// eslint-disable-next-line no-restricted-syntax
const TEST_DATA = resolve(__dirname, '../../../e2e-stub');

const numberIn = async (l: Locator) => Number(((await l.locator('.ne-tile-value').first().textContent()) ?? '').replace(/[^\d.]/g, ''));

async function importFocus(page: Page) {
  await page.goto('/costs');
  await page.locator('input[type=file]').setInputFiles(resolve(TEST_DATA, 'focus.csv'));
  await expect(page.getByText(/^Imported \d+ rows/)).toBeVisible();
}

test('F1.1: GPU utilisation has one name with its window, and the same window gives the same value', async ({ page }) => {
  await page.goto('/');
  const overview = page.getByRole('region', { name: 'GPU utilisation · latest sample' });
  await expect(overview).toContainText('at their latest sample');
  const o = await numberIn(overview);
  await page.goto('/capacity');
  const capacity = page.getByRole('region', { name: 'GPU utilisation · latest sample' });
  await expect(capacity).toContainText('at their latest sample');
  expect(await numberIn(capacity)).toBe(o);
  await page.goto('/fleet');
  await expect(page.getByRole('region', { name: 'GPU utilisation · mean, last 24 h' })).toContainText('Overview and Capacity show the latest sample');
  await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '7 d' }).click();
  await expect(page.getByRole('region', { name: 'GPU utilisation · mean, last 7 d' })).toBeVisible();
  for (const path of ['/', '/capacity', '/fleet']) {
    await page.goto(path);
    await expect(page.getByText(/Measured (GPU )?utilisation|Mean GPU utilisation/)).toHaveCount(0);
  }
});

test('F1.1: every utilisation column on Capacity and Fleet names its window', async ({ page }) => {
  const WINDOW = /^GPU utilisation · (latest sample|daily mean|mean, last \d+ (h|d))$/;
  await page.goto('/capacity#gpu-telemetry'); // a folded reference section (F1.13): the link opens it
  await expect(page.getByRole('table', { name: 'Node groups' }).getByRole('columnheader', { name: 'GPU utilisation · latest sample' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'GPU telemetry per GPU' }).getByRole('columnheader', { name: 'GPU utilisation · latest sample' })).toBeVisible();
  for (const path of ['/capacity', '/fleet']) {
    await page.goto(path);
    await expect(page.getByRole('columnheader').first()).toBeVisible();
    const headers = (await page.getByRole('columnheader').allTextContents()).map(t => t.trim()).filter(t => /util/i.test(t));
    expect(headers.length).toBeGreaterThan(0);
    for (const h of headers) expect(h).toMatch(WINDOW);
  }
});

test('F1.2: the reported total and the spend budgets count are named apart; Costs rows round as every page', async ({ page }) => {
  await importFocus(page);
  // The fixture holds a tax row (12.40) and a credit (−5.00): reported 571.32 XTS, spend excl. both 563.92 XTS.
  await page.goto('/');
  const cost = page.getByRole('region', { name: 'Reported cost (BilledCost)' });
  await expect(cost).toContainText('571.32 XTS');
  await expect(cost).toContainText('563.92 XTS excl. tax and credits (the Budgets rule)');
  await page.goto('/budgets');
  await expect(page.getByText('FOCUS export, excl. tax and credits (actual)').first()).toBeVisible();
  await expect(page.getByRole('table', { name: 'Budgets from the configuration' }).getByRole('columnheader', { name: /Spend excl\. tax and credits \/ budget/ })).toBeVisible();
  await page.goto('/costs');
  await expect(page.getByText(/Each row is rounded on its own, as on every page, so the rows can differ from the total by a few cents/)).toBeVisible();
  await expect(page.locator('section.ne-card').filter({ has: page.getByRole('heading', { name: 'Total in period' }) })).toContainText('563.92 XTS excl. tax and credits (the Budgets rule)');
});

test('F1.3: maintenance reads "in N d" on Alerts as on Capacity', async ({ page }) => {
  await page.goto('/capacity');
  const when = (await page.getByRole('table', { name: 'Scheduled maintenance' }).getByText(/^in \d+ (min|h|d)$/).first().textContent())!.trim();
  await page.goto('/alerts');
  const row = page.getByRole('row', { name: /Maintenance mk8s control plane update/ });
  await expect(row).toContainText(`Maintenance mk8s control plane update ${when}`);
  await expect(page.getByText(/in \d+\.\d h/)).toHaveCount(0);
});

test('F1.4/F1.39: Overview and Capacity count quotas near their limit the same way, in the same words, with the same N', async ({ page }) => {
  await page.goto('/capacity');
  const header = page.locator('section.ne-card').filter({ has: page.getByRole('heading', { name: 'Quotas', exact: true }) }).getByText(/ at ≥ 80 % · /).first();
  const text = (await header.textContent())!.trim();
  // The worst state leads when there is one (F1.11): "1 in use above its limit · 0 at ≥ 80 % · 10 tenant quotas with a limit".
  expect(text).toMatch(/^(\d+ in use above (its|their) limit · )?\d+ at ≥ 80 % · \d+ (tenant|project) quotas? with a limit/);
  const near = text.replace(/^\d+ in use above (its|their) limit · /, '');
  const judged = Number(/· (\d+) /.exec(near)![1]);
  // The list below counts the same N (and says so apart when some allowances have no limit).
  await expect(page.getByText(new RegExp(`^All tenant quotas \\((${judged}|\\d+ · ${judged} with a limit)\\)$`))).toBeVisible();
  await page.goto('/');
  const attention = page.getByRole('region', { name: 'Needs attention' });
  // The Overview gives the above-limit count a row of its own; the near-limit row has the rest of the words, the same N.
  await expect(attention.getByText(near, { exact: true })).toBeVisible();
  await expect(attention).not.toContainText('with a known limit');
});

test('F1.5: AI services and Budgets show project names, with the id on hover', async ({ page }) => {
  await page.goto('/ai-services');
  const serverless = page.getByRole('table', { name: 'Serverless endpoints and jobs' });
  const name = serverless.getByText('nip-sandbox', { exact: true });
  await expect(name).toHaveAttribute('title', 'project-e00mocksandbox');
  await expect(serverless).not.toContainText('project-e00mock');
  await page.goto('/budgets');
  const config = page.getByRole('table', { name: 'Budgets from the configuration' });
  await expect(config.getByText('nip-sandbox', { exact: true })).toHaveAttribute('title', 'project-e00mocksandbox');
  await expect(config).not.toContainText('project-e00mock');
  await page.goto('/alerts');
  const inbox = page.getByRole('table', { name: 'firing alerts' });
  await expect(inbox.getByRole('row').nth(1)).toBeVisible();
  await expect(inbox).not.toContainText(/project-e00mock|computeinstance-e00/);
});
