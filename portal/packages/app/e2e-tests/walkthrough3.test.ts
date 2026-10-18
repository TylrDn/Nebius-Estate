// Test-only: locates the shared test data next to the stub.
// eslint-disable-next-line no-restricted-imports
import { resolve } from 'path';
import { expect, Page, test } from '@playwright/test';

/**
 * Third walkthrough (2026-10-11): Evidence reflows at 1440, 720 and 390 px and with text at 200 %
 * (WCAG 1.4.10), its recipe evidence buttons are named starting with their visible text (WCAG 2.5.3),
 * runbook summaries are plain text; Costs says "No billed rows in this range" for an empty range while
 * imports exist, reports coverage instead of "missing hours", and names a malformed range in the link.
 */

// eslint-disable-next-line no-restricted-syntax
const TEST_DATA = resolve(__dirname, '../../../e2e-stub');

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function importFocus(page: Page) {
  await page.goto('/costs');
  await page.locator('input[type=file]').setInputFiles(resolve(TEST_DATA, 'focus.csv'));
  await expect(page.getByText(/^Imported \d+ rows/)).toBeVisible();
}

// Solutions moved to their own page (F1.23); it is checked the same way below.
const EVIDENCE_TABS = ['evidence', 'recipes', 'runbooks', 'decisions'];

for (const width of [1440, 720, 390]) {
  test.describe(`evidence at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    test(`every tab reflows without sideways scrolling, also with text at 200 % (${width} px)`, async ({ page }) => {
      for (const tab of EVIDENCE_TABS) {
        await page.goto(`/evidence?tab=${tab}`);
        await expect(page.getByRole('heading', { level: 1, name: 'Evidence & Runbooks' })).toBeVisible();
        await expect(page.getByRole('tab', { selected: true })).toBeVisible();
        await page.waitForLoadState('networkidle');
        expect([tab, '100 %', Math.max(0, await overflow(page))]).toEqual([tab, '100 %', 0]);
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '200%';
        });
        expect([tab, '200 %', Math.max(0, await overflow(page))]).toEqual([tab, '200 %', 0]);
      }
      await page.goto('/solutions');
      await expect(page.getByRole('heading', { level: 1, name: 'Solutions' })).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(['solutions', '100 %', Math.max(0, await overflow(page))]).toEqual(['solutions', '100 %', 0]);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
      expect(['solutions', '200 %', Math.max(0, await overflow(page))]).toEqual(['solutions', '200 %', 0]);
    });
  });
}

test('evidence: recipe evidence buttons are named starting with their visible text; runbook summaries are plain text', async ({ page }) => {
  await page.goto('/evidence?tab=recipes');
  const buttons = page.locator('.ne-card li button');
  await expect(buttons.first()).toBeVisible();
  const n = await buttons.count();
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    const text = ((await b.textContent()) ?? '').trim();
    const name = (await b.getAttribute('aria-label')) ?? text;
    expect(name.startsWith(text)).toBe(true);
  }
  await page.goto('/evidence?tab=runbooks');
  const alerting = page.locator('.ne-card', { hasText: 'runbooks/alerting.md' });
  await expect(alerting).toContainText('null receiver');
  await expect(alerting).not.toContainText('**');
  await expect(page.locator('.ne-card p').filter({ hasText: /\*\*|`/ })).toHaveCount(0);
});

test('costs: a valid range without rows says so and keeps the export health; completeness is coverage, not missing hours', async ({ page }) => {
  await importFocus(page);
  await page.goto('/costs');
  const completeness = page.getByRole('region', { name: 'Completeness' });
  // F1.42: one figure in plain words, "N of M h with usage", and why an hour without usage is not a gap.
  await expect(completeness.locator('.ne-tile-value')).toHaveText(/^\d+ of \d+ h with usage$/);
  await expect(completeness).toContainText('An hour without usage has no row in a FOCUS export, so it is not a gap.');
  await expect(completeness).not.toContainText(/missing|covered/);
  await page.goto('/costs?from=2025-01-01&to=2025-01-02');
  await expect(page.getByText('No billed rows in this range')).toBeVisible();
  await expect(page.getByText('No billing data imported')).toHaveCount(0);
  await expect(page.getByText(/waiting for the first files/)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Export lag' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Completeness' })).toContainText('h with usage');
});

test('costs: a malformed date in the link says "not applied"', async ({ page }) => {
  await page.goto('/costs?from=bogus');
  await expect(page.getByText('Range from the link not applied')).toBeVisible();
  await expect(page.getByText(/from "bogus"/)).toBeVisible();
});
