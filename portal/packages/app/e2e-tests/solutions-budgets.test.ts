import { expect, test } from '@playwright/test';
import { axeBuilder } from './axe';

/**
 * Solutions (its own page, F1.23), "Price this footprint" through the stub's billing
 * calculator (e2e-stub/stubApi.js, XTS prices), the recipes without a provisioning form, and budgets
 * from one place (Budgets & credits). Solutions are read from this repository's own solutions/ folder.
 */

const axe = async (page: import('@playwright/test').Page) =>
  (await axeBuilder(page).include('#main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations.map(v => v.id);

test('solutions: S1–S9 with scenario, composed recipes, status and Read', async ({ page }) => {
  await page.goto('/evidence');
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Solutions' }).click();
  await expect(page).toHaveURL(/\/solutions$/);
  for (const id of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']) await expect(page.getByRole('button', { name: `Price this footprint: ${id}` })).toBeVisible();
  const s1 = page.locator('.ne-card', { hasText: 'S1 · Private LLM serving with VPN to on-prem' });
  await expect(s1).toContainText('designed; not deployed; VPN Gateway not built here');
  await expect(s1.getByRole('button', { name: 'Read recipe R12: terraform/stacks/ml-services/README.md' })).toBeVisible();
  expect(await axe(page)).toEqual([]);

  // Read opens the README in the document viewer; its Mermaid diagram is captioned and linked to GitHub.
  await s1.getByRole('button', { name: 'Read solutions/S1-private-llm-serving-vpn/README.md' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText(/Diagram \(Mermaid\)/).first()).toBeVisible();
  await expect(drawer.getByRole('link', { name: 'view it drawn on GitHub' }).first()).toHaveAttribute('href', 'https://github.com/TylrDn/Nebius-Estate/blob/main/solutions/S1-private-llm-serving-vpn/README.md');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // A composed recipe opens in the same viewer.
  await s1.getByRole('button', { name: 'Read recipe R7: terraform/stacks/network/README.md' }).click();
  await expect(page).toHaveURL(/\/solutions\?doc=terraform%2Fstacks%2Fnetwork%2FREADME\.md/);
  await expect(page.getByRole('dialog').locator('.ne-markdown')).toBeVisible();
});

test('solutions: Price this footprint loads the footprint into the live-price calculator flow', async ({ page }) => {
  await page.goto('/solutions');
  await page.getByRole('button', { name: 'Price this footprint: S4' }).click();
  await expect(page).toHaveURL(/price=S4/);
  const panel = page.locator('.ne-card', { hasText: 'Price this footprint · S4' });
  await expect(panel).toContainText('footprint.json · eu-north1 · 72 h');
  // On-demand and the spot comparison, each priced by the calculator (the stub's invented XTS prices).
  await expect(panel.getByText(/^On-demand · (list price|contract price)/).first()).toBeVisible();
  await expect(panel.getByText('Preemptible (spot now)').first()).toBeVisible();
  await expect(panel.getByText(/run \(72 h\): .*XTS/).first()).toBeVisible();
  await expect(panel.getByText(/XTS/).first()).toBeVisible();
  expect(await axe(page)).toEqual([]);

  // A solution with two footprint files offers both; the link restores the panel.
  await page.goto('/solutions?price=S2');
  const s2 = page.locator('.ne-card', { hasText: 'Price this footprint · S2' });
  await expect(s2.getByLabel('Footprint file')).toBeVisible();
  await s2.getByLabel('Footprint file').selectOption({ label: 'footprint-b300.json · eu-west2 · 336 h' });
  // The calculator prices in a project's region: the stub lists none in eu-west2, and the panel says so.
  await expect(s2.getByText(/No listed project is in eu-west2/).first()).toBeVisible();
  await s2.getByRole('button', { name: 'Close the price panel' }).click();
  await expect(page).not.toHaveURL(/price=/);
});

test('provisioning: recipes without a form are listed read-only, live roots or documentation and runbook', async ({ page }) => {
  await page.goto('/provisioning');
  const table = page.getByRole('table', { name: 'Recipes without a provisioning form' });
  await expect(table.getByRole('row', { name: /R10/ })).toContainText('read-only live roots');
  await expect(table.getByRole('row', { name: /R10/ })).toContainText('terraform/live/sandbox/gpu-vm/sandbox.auto.tfvars');
  await expect(table.getByRole('row', { name: /R15/ })).toContainText('documentation and runbook');
  await expect(table.getByRole('row', { name: /R15/ })).toContainText('cap sandbox 0');
  await expect(table.getByRole('row', { name: /R1 / })).toHaveCount(0);
});

test('budgets: one place — Costs links to Budgets & credits, which shows config budgets read-only', async ({ page }) => {
  await page.goto('/costs');
  await expect(page.getByRole('link', { name: 'Budgets & credits →' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Budgets' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Budgets & credits →' }).click();
  await expect(page).toHaveURL(/\/budgets$/);
  const config = page.getByRole('table', { name: 'Budgets from the configuration' });
  await expect(config.getByRole('row', { name: /sandbox-run-481/ })).toContainText('from config');
  await expect(page.getByText(/nebiusEstate\.budgets is deprecated/)).toBeVisible();
  expect(await axe(page)).toEqual([]);
});
