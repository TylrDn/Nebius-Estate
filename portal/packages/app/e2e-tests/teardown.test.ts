import { expect, test } from '@playwright/test';

/**
 * Teardown coherence against the e2e stub (e2e-stub/estate.json, project-e00mocklegacy "legacy-research"):
 * - cluster nip-legacy-teardown is DELETING, its node group past its TTL;
 * - its preemptible node VM is stopped (a planned teardown, not a preemption);
 * - Nebius Monitoring still answers for GPU VM computeinstance-e00mockgonegpu, which the instance list no longer has.
 * Mirrors the 2026-10-11 walkthrough (TTL 10:44, cluster deleting 10:56).
 */

test('alerts: no PreemptibleNodeLost, GpuIdle or ConnectorFailing for a planned teardown', async ({ page }) => {
  await page.goto('/alerts');
  await expect(page.getByRole('heading', { level: 1, name: 'Alerts' })).toBeVisible();
  await expect(page.getByText(/Evaluated after each sync; last evaluation/)).toBeVisible();
  for (const tab of ['Firing', 'Pending']) {
    await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
    await expect(page.getByRole('row', { name: /mk8snodegroup-e00mockgonegpu-7vfm8-qg7rz/ })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /nip-legacy-teardown-gpu-0|computeinstance-e00mockgonegpu/ })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Connector .*nip-legacy-teardown/ })).toHaveCount(0);
  }
  // The column says which time it is.
  await page.getByRole('tab', { name: /^Firing/ }).click();
  await expect(page.getByRole('columnheader', { name: 'Firing since' })).toBeVisible();
});

test('alerts: opening an alert is a history entry, so Back closes the drawer', async ({ page }) => {
  await page.goto('/alerts');
  await page.getByRole('row', { name: /Maintenance mk8s control plane update/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(/alert=/);
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).not.toHaveURL(/alert=/);
  await expect(page.getByRole('heading', { level: 1, name: 'Alerts' })).toBeVisible();
});

test('fleet: a deleted VM\'s GPU is in the range but not running now, and the tile says so', async ({ page }) => {
  await page.goto('/fleet');
  await expect(page.getByRole('heading', { level: 1, name: 'Fleet' })).toBeVisible({ timeout: 90_000 });
  const gone = page.getByRole('button', { name: /nip-legacy-teardown-gpu-0 · GPU 0/ });
  // F1.40: one state per row, said the same way for every VM: its name, then "· deleted"; never "Deleted VM (…)".
  await expect(gone).toContainText('nip-legacy-teardown-gpu-0 · GPU 0 · deleted');
  await expect(page.locator('.ne-heat-label', { hasText: /^Deleted / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /nip-sandbox-inference-gpu-0 · GPU 0/ })).not.toContainText(/not running|deleted/);
  const tile = page.getByRole('region', { name: 'GPUs in the selected range' });
  await expect(tile).toContainText('3');
  await expect(tile).toContainText('2 running now');
  await gone.click();
  await expect(page.getByRole('dialog')).toContainText('VM no longer in the inventory (deleted)');
});

test('overview: utilisation counts only GPUs of running VMs; billing is dated by the last exported hour', async ({ page }) => {
  await page.goto('/');
  const util = page.getByRole('region', { name: 'GPU utilisation · latest sample' });
  await expect(util).toContainText('Mean of 2 reporting GPU series');
  // The source is printed once in the tile.
  await expect(util.getByText(/^Nebius Monitoring \(service-provider GPU metrics\)/)).toHaveCount(1);
  const cost = page.getByRole('region', { name: 'Reported cost (BilledCost)' });
  await expect(cost).toContainText(/exported through \d{4}-\d\d-\d\d \d\d:\d\d UTC · export lag (\d+ (h|d)|under 1 h)/);
  await expect(cost).not.toContainText(/· in \d+ d/);
  await expect(page.getByRole('region', { name: 'Run-rate (live)' })).toBeVisible();
});

test('estate: the deleting cluster shows its state, and its TTL reads like every other time', async ({ page }) => {
  await page.goto('/estate?q=nip-legacy-teardown');
  await page.getByText('nip-legacy-teardown', { exact: true }).first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText(/deleting/i);
  await expect(drawer).toContainText('2026-10-09 18:00 UTC (expired)');
  await expect(drawer).not.toContainText('2026-10-09T18:00:00Z (expired)');
});

test('integrations: while clusters change state, the inventory card runs the fast re-sync and says why', async ({ page }) => {
  // nip-sandbox-soperator is PROVISIONING and nip-legacy-teardown (with its node group) DELETING in the stub:
  // the next run is the fast re-sync (nebius.fastSyncSeconds, 2 min), not the 15-minute cadence.
  await page.goto('/integrations');
  const inventory = page.locator('section.ne-card').filter({ has: page.getByRole('heading', { name: 'Nebius inventory (REST API)' }) });
  await expect(inventory.getByText(/^(in [12] min|just now) \(a cluster is provisioning, a cluster is being deleted and 1 more\)$/)).toBeVisible();
});
