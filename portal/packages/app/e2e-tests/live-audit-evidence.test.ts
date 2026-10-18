import { expect, Page, test } from '@playwright/test';
import { axeBuilder } from './axe';

/**
 * Live audit 2026-10-12, sections Evidence & Runbooks and Solutions (G5.7–G5.14), against the e2e stub. Evidence,
 * runbooks, decisions and solution footprints are read from this checkout, as live; prices come from the stub
 * calculator (e00mock projects). The Provisioning findings (G5.1–G5.6) change shared request state and run in order
 * in portal.test.ts.
 */

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const axe = async (page: Page) => (await axeBuilder(page).include('#main').withTags(AXE_TAGS).analyze()).violations.map(v => v.id);

test('G5.7, G5.10: the foundation apply counts as applied and backs R2; the federated CI plan is on the R13 card', async ({ page }) => {
  await page.goto('/evidence');
  await expect(page.getByText(/Terraform roots applied so far, per the evidence files: foundation \(2026-10-11\), sandbox\/data/)).toBeVisible();
  await expect(page.getByText(/Applied so far \(docs\/evidence\): foundation, sandbox\/data/)).toHaveCount(1); // in a folded section
  await expect(page.getByText(/Token exchange: next row/)).toHaveCount(0);
  await page.goto('/evidence?tab=recipes');
  const card = (id: string) => page.locator('.ne-card', { has: page.getByRole('heading', { name: new RegExp(`^${id} · `) }) });
  await expect(card('R2')).toContainText('foundation + GitHub OIDC federation for sandbox (R13)');
  await expect(card('R13')).toContainText('First federated CI plan for sandbox (R13)');
  expect(await axe(page)).toEqual([]);
});

test('G5.8: decision and runbook summaries start a sentence, keep glob stars and never stop mid-word', async ({ page }) => {
  await page.goto('/evidence?tab=decisions');
  const adr = (n: string) => page.locator('.ne-card', { has: page.getByRole('heading', { name: new RegExp(`^ADR ${n}:`) }) }).locator('p');
  await expect(adr('0001')).toHaveText(/^Customers ask either/);
  await expect(adr('0009')).not.toHaveText(/(^|\s)- /); // no raw bullets
  await expect(adr('0009')).toHaveText(/[.…]$/);
  await page.goto('/evidence?tab=runbooks');
  await expect(page.locator('.ne-card', { has: page.getByRole('heading', { name: /^Alerting runbook/ }) })).toContainText('platform/alerts/*.yaml');
});

test('G5.9: a link inside an open document keeps the page behind it (tab, priced solution)', async ({ page }) => {
  await page.goto(`/evidence?tab=recipes&doc=${encodeURIComponent('terraform/stacks/inference/README.md')}`);
  const drawer = page.getByRole('dialog');
  await drawer.locator('a[href*="platform%2FREADME.md"]').first().click();
  await expect(page).toHaveURL(/tab=recipes/);
  await expect(page).toHaveURL(/doc=platform%2FREADME\.md#stage-policy/);
  await expect(page.getByRole('tab', { name: /Recipes/ })).toHaveAttribute('aria-selected', 'true');
  await page.goto(`/solutions?price=S1&doc=${encodeURIComponent('solutions/S1-private-llm-serving-vpn/README.md')}`);
  await page.getByRole('dialog').locator('a[href*="runbooks%2Fnetwork.md"]').first().click();
  await expect(page).toHaveURL(/price=S1/);
  await expect(page).toHaveURL(/doc=runbooks%2Fnetwork\.md/);
  await expect(page.locator('#solution-price-panel')).toBeVisible();
});

test.describe('dark theme', () => {
  test.use({ colorScheme: 'dark' });
  test('G5.11: a fenced code block in the document drawer is one box, its lines not painted again', async ({ page }) => {
    await page.goto(`/evidence?tab=runbooks&doc=${encodeURIComponent('runbooks/deploy.md')}`);
    const code = page.getByRole('dialog').locator('.ne-markdown pre code').first();
    await expect(code).toBeVisible();
    expect(await code.evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    const inner = page.getByRole('dialog').locator('.ne-markdown pre pre');
    for (const p of await inner.all()) {
      expect(await p.evaluate(e => [getComputedStyle(e).backgroundColor, getComputedStyle(e).borderTopWidth])).toEqual(['rgba(0, 0, 0, 0)', '0px']);
    }
  });
});

test('G5.12: a panel priced on-demand and preemptible names both capacity types', async ({ page }) => {
  await page.goto('/solutions?price=S4');
  const panel = page.locator('#solution-price-panel');
  await expect(panel.getByRole('region', { name: /Preemptible/ }).first()).toContainText('/ h');
  await expect(panel.getByTestId('live-capacity')).toContainText('Capacity: on-demand · preemptible');
});

test('G5.13: the price panel names the project and its footer carries no stale date', async ({ page }) => {
  await page.goto('/solutions?price=S1');
  const panel = page.locator('#solution-price-panel');
  await expect(panel).toContainText(/priced in project nip-/);
  await expect(panel).not.toContainText(/priced in project project-/);
  await expect(panel).toContainText('This footprint file, read from this checkout, is what recipes/finance/price.py prices.');
  await expect(panel).not.toContainText('dated 2026-10-11');
});

test('G5.14: items with different hours (S9) get a per-run total weighed per line', async ({ page }) => {
  await page.goto('/solutions?price=S9');
  const panel = page.locator('#solution-price-panel');
  await expect(panel.getByText(/per run \(mixed hours\): [\d,.]+ /).first()).toBeVisible();
  await expect(panel).toContainText('the per-run total weighs each line by its own hours');
  expect(await axe(page)).toEqual([]);
});
