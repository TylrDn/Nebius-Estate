import { expect, test } from '@playwright/test';
import { axeBuilder } from './axe';

/**
 * Live audit 2026-10-12, sections Alerts, Logs and AI services (G3.x), against the e2e stub. The live conditions
 * (a uk-south1 project under a region filter, a `| json` stage Nebius answers with 500, systemd OK lines matching the
 * errors preset) are reproduced with the stub's e00mock estate.
 */

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test('G3.3: Logs follow the global region filter', async ({ page }) => {
  await page.goto('/logs?region=uk-south1');
  await expect(page.getByText(/^Project nip-lab/)).toBeVisible();
  await page.goto('/logs?region=eu-north1');
  await expect(page.getByText(/^Project nip-(sandbox|staging)/)).toBeVisible();
});

test('G3.5: a parser stage Nebius cannot run reads in plain words, without the upstream URL', async ({ page }) => {
  // Sandbox has a serial-console bucket; with no project chosen the page opens on staging, which wrote last (#31).
  await page.goto(`/logs?project=project-e00mocksandbox&q=${encodeURIComponent('{__bucket__="sp_serial"} | json')}`);
  await expect(page.getByText(/Nebius Logs could not run this query \(HTTP 500\)/)).toBeVisible();
  await expect(page.locator('body')).not.toContainText('loki/api');
});

test('G3.15: the serial-console errors preset leaves out systemd OK lines', async ({ page }) => {
  await page.goto('/logs?project=project-e00mocksandbox');
  const lines = page.getByRole('region', { name: /Log lines/ });
  await expect(lines).toContainText('FAILED Failed to start nvidia-fabricmanager.service');
  await expect(lines).not.toContainText('Stopped update-notifier-download');
  await page.getByRole('group', { name: 'Buckets' }).getByRole('button', { name: /Compute VMs|serial/i }).first().click();
  await expect(lines).toContainText('Stopped update-notifier-download');
});

test('G3.9, G3.11: Rules open on firing rules, and a zero hold reads "at once"', async ({ page }) => {
  await page.goto('/alerts?tab=rules');
  const table = page.getByRole('table', { name: 'Alert rules' });
  await expect(table.getByRole('row').nth(1)).toBeVisible();
  const counts = await table.locator('tbody tr').evaluateAll(rows => rows.map(r => Number((r.lastElementChild?.textContent ?? '0').split('/')[0].trim()) || 0));
  expect(counts[0]).toBe(Math.max(...counts));
  await expect(table).not.toContainText(/\b0 min\b/);
  await expect(table).toContainText('at once');
  expect((await axeBuilder(page).withTags(AXE_TAGS).analyze()).violations).toEqual([]);
});
