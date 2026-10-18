import { expect, Page, test } from '@playwright/test';
import { axeBuilder } from './axe';

/**
 * Fleet, Alerts and Logs against the e2e stub (e2e-stub/stubApi.js: GPU history synthesised from the
 * stub's DCGM values, an Xid counter on the sandbox GPU, Object Storage figures and Loki lines from
 * e2e-stub/telemetry.json). The three pages are also in the themed axe and 390 px checks of
 * portal.test.ts (PAGES); here: the drawers in both themes and the drill-down paths.
 */

async function axe(page: Page) {
  // Drawers slide in; reduced motion (the portal honours it) makes axe see the final colours.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(250);
  const results = await axeBuilder(page).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(', ')}`);
}

test('fleet: GPU heat map with metric toggles, roll-ups, idle cost and service health', async ({ page }) => {
  // The first visit may wait for the dev server to compile the page's chunk.
  test.setTimeout(150_000);
  await page.goto('/fleet');
  await expect(page.getByRole('heading', { level: 1, name: 'Fleet' })).toBeVisible({ timeout: 90_000 });
  const gpu = page.getByRole('button', { name: 'nip-sandbox-inference-gpu-0 · GPU 0' });
  await expect(gpu).toBeVisible();
  await expect(page.getByRole('button', { name: 'bench-b300-1gpu · GPU 0' })).toBeVisible();
  await expect(page.getByText('mk8scluster-e00mockinf › nip-sandbox-inference-gpu').or(page.getByText(/› nip-sandbox-inference-gpu/)).first()).toBeVisible();
  await page.getByRole('group', { name: 'Colour by' }).getByRole('button', { name: 'Temperature' }).click();
  await expect(page).toHaveURL(/metric=temp/);
  await expect(page.getByRole('heading', { name: 'GPU temperature over time' })).toBeVisible();
  await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '7 d' }).click();
  await expect(page).toHaveURL(/range=7d/);
  await expect(page.getByRole('region', { name: 'Idle GPU time (below 5 %)' })).toContainText(/GPU-hours/);
  await expect(page.getByRole('region', { name: 'Idle GPU time (below 5 %)' })).toContainText(/XTS estimated at the live price/);
  await expect(page.getByRole('table', { name: 'Node groups and standalone VMs' })).toContainText('nip-sandbox-inference-gpu');
  await expect(page.getByRole('heading', { name: 'Object Storage' })).toBeVisible();
  await expect(page.getByText('Requests 2.5 req/s')).toBeVisible();
  await expect(page.getByText(/No bucket in scope|status only/).first()).toBeVisible();
});

test('fleet → GPU → VM in the Explorer, and → Logs pre-filtered to the VM', async ({ page }) => {
  await page.goto('/fleet');
  await page.getByRole('button', { name: 'nip-sandbox-inference-gpu-0 · GPU 0' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('nip-sandbox-inference-gpu');
  await expect(drawer.getByRole('link', { name: /VM in the Estate Explorer/ })).toHaveAttribute('href', /\/estate\?uid=nebius%3Acomputeinstance-e00mockinfgpu0/);
  // The Logs range reaches back to the GPU's last sample (G2.6): sampled within the hour here.
  await expect(drawer.getByRole('link', { name: /Serial-console logs of this VM/ })).toHaveAttribute('href', /&range=1h$/);
  await drawer.getByRole('link', { name: /Serial-console logs of this VM/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Logs' })).toBeVisible();
  await expect(page.getByText('narrowed to computeinstance-e00mockinfgpu0')).toBeVisible();
  await expect(page.getByRole('region', { name: /Log lines/ })).toContainText('FAILED Failed to start nvidia-fabricmanager.service');
  await expect(page.getByRole('region', { name: /Log lines/ })).not.toContainText('kubelet: error');
});

test('alerts: inbox, guided fix with the runbook section, acknowledge, and the logs drill-down', async ({ page }) => {
  await page.goto('/alerts');
  await expect(page.getByRole('heading', { level: 1, name: 'Alerts' })).toBeVisible();
  await expect(page.getByText(/Evaluated after each sync; last evaluation/)).toBeVisible();
  // Named by VM and GPU index; the ids are on hover (F1.5), and in full in the drawer.
  const xid = page.getByRole('row', { name: /Xid error on nip-sandbox-inference-gpu-0 GPU 0/ });
  await expect(xid).toBeVisible();
  await expect(xid.locator('[title*="computeinstance-e00mockinfgpu0"]')).toHaveCount(1);
  await expect(page.getByRole('row', { name: /Maintenance mk8s control plane update/ })).toBeVisible();
  await xid.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.locator('.ne-evidence-q')).toContainText('increase(DCGM_FI_DEV_XID_ERRORS[10m]) > 0');
  const fix = drawer.getByRole('region', { name: 'Guided fix' }).or(drawer.locator('section[aria-label="Guided fix"]'));
  await expect(fix).toContainText('What it means');
  await expect(fix).toContainText('Read-only checks');
  await expect(fix.getByRole('heading', { name: 'GPU Xid or ECC errors' })).toBeVisible();
  await expect(fix.getByRole('link', { name: /docs\.nebius\.com\/compute\/virtual-machines\/maintenance-reasons#gpu-errors/ })).toBeVisible();
  await expect(fix).toContainText('it never applies one');
  await expect(fix.getByRole('link', { name: /Open runbooks\/fleet-alerts\.md in the document viewer/ })).toHaveAttribute('href', '/evidence?doc=runbooks%2Ffleet-alerts.md');
  await expect(await axe(page)).toEqual([]);

  await drawer.getByLabel('Note (optional)').fill('draining the node');
  await drawer.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(drawer.getByText(/Acknowledged by user:development\/guest .*draining the node/)).toBeVisible();
  await expect(xid).toContainText('acknowledged by user:development/guest');

  await drawer.getByRole('link', { name: 'Serial-console logs of this VM' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Logs' })).toBeVisible();
  await expect(page.getByRole('region', { name: /Log lines/ })).toContainText('NVRM: loading NVIDIA UNIX');
});

test('alerts: rules needing in-cluster Prometheus are listed, not dropped', async ({ page }) => {
  await page.goto('/alerts?tab=rules');
  const rules = page.getByRole('table', { name: 'Alert rules' });
  await expect(rules.getByRole('row', { name: /VllmNoReplicasReady/ })).toContainText('Needs in-cluster Prometheus');
  await expect(rules.getByRole('row', { name: /GpuIdle/ })).toContainText('Nebius Monitoring');
  await expect(rules.getByRole('row', { name: /QuotaBlocksNodeGroup/ })).toContainText('Portal (inventory)');
  await expect(rules.getByRole('row', { name: /ProjectAllowanceBelowTenant/ })).toContainText('Portal (inventory)');
});

test('overview: an Alerts attention row links to the Alerts page', async ({ page }) => {
  await page.goto('/');
  const tile = page.getByRole('region', { name: 'Needs attention' });
  await expect(tile.getByRole('link', { name: 'Alerts firing' })).toBeVisible();
  await tile.getByRole('link', { name: 'Alerts firing' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Alerts' })).toBeVisible();
});

test('logs: tenant audit events show who changed what, refusals stand out, reads only on request, nothing sensitive', async ({ page }) => {
  await page.goto('/logs');
  const card = page.locator('.ne-card', { has: page.getByText('Audit events (tenant)') });
  await expect(card.getByRole('combobox', { name: 'Audit region' })).toHaveValue('eu-north1');
  await expect(card).toContainText('nip-ci (service account)');
  await expect(card).toContainText('instance nip-sandbox-gpu-vm');
  await expect(card).toContainText('refused');
  // #37: an operation with status ERROR and an empty error message is "failed" in amber, never a green "error".
  const failed = card.getByRole('row', { name: /subnet nip-sandbox-subnet/ });
  await expect(failed.locator('.ne-badge')).toHaveText('failed');
  await expect(failed.locator('.ne-badge')).toHaveClass(/ne-tone-warn/);
  await expect(failed).toContainText('FAILED_PRECONDITION');
  await expect(card.locator('.ne-badge', { hasText: /^error$/ })).toHaveCount(0);
  await expect(card).not.toContainText('nip-portal-viewer');
  await card.getByLabel('Include reads (GET, LIST)').check();
  await expect(card).toContainText('nip-portal-viewer (service account)');
  await expect(page.locator('body')).not.toContainText('never-copied-stub-value');
});

test('logs: presets, validation before sending, and "no logs yet" for a bucket Nebius has not created', async ({ page }) => {
  // Sandbox's lines; with no project chosen the page opens on staging, which wrote last (#31).
  await page.goto('/logs?project=project-e00mocksandbox');
  await expect(page.getByText(/^Project nip-sandbox/)).toBeVisible();
  await page.getByRole('group', { name: 'Presets' }).getByRole('button', { name: 'Control-plane errors' }).click();
  await expect(page.getByRole('region', { name: /Log lines/ })).toContainText('scale-up failed: quota compute.instance.gpu.h100 exceeded');
  await page.getByRole('group', { name: 'Presets' }).getByRole('button', { name: 'PostgreSQL errors' }).click();
  await expect(page.getByText(/No logs yet from Managed PostgreSQL/).first()).toBeVisible();
  const box = page.getByLabel('LogQL');
  await box.fill('{level="error"}');
  await expect(page.getByText(/must name a bucket/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run query' })).toBeDisabled();
  await box.fill('{__bucket__="sp_serial"} |= "kubelet"');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByRole('region', { name: /Log lines/ })).toContainText('kubelet: error: node not yet registered');
  await page.getByRole('region', { name: /Log lines/ }).getByRole('button').first().click();
  await expect(page.getByText('sp_resource_id')).toBeVisible();
});

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });
    test('fleet GPU drawer and logs results have no axe violations', async ({ page }) => {
      await page.goto('/fleet');
      await page.getByRole('button', { name: 'bench-b300-1gpu · GPU 0' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(await axe(page)).toEqual([]);
      await page.goto('/logs?project=project-e00mocksandbox&bucket=sp_serial');
      await expect(page.getByRole('region', { name: /Log lines/ })).toBeVisible();
      await expect(await axe(page)).toEqual([]);
    });
  });
}

test.describe('390 px viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  for (const path of ['/fleet?range=7d&metric=power', '/alerts?tab=rules', '/logs?preset=control-plane-errors']) {
    test(`${path}: no horizontal page overflow`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test('F1.37: a GPU or project known only by a long resource id wraps (heat map, tables, filter), never widening the page', async ({ page }) => {
    await page.goto('/fleet');
    await expect(page.locator('.ne-heat-label').first()).toBeVisible();
    // A failed project read leaves names unread: every name the page shows becomes a long resource id (the live
    // labels were "Deleted VM (computeinstance-…)", "Standalone VMs · project-…").
    await page.evaluate(() => {
      const long = (t: string) => t.replace(/[A-Za-z][\w-]{5,}/g, w => `computeinstance-e00mock${w.replace(/\W/g, '')}${'x'.repeat(20)}`);
      for (const el of document.querySelectorAll('#main .ne-heat-label, #main .ne-heat-group, #main td, #main .ne-callout, #main option, #main .ne-tile-reason')) {
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) n.textContent = long(n.textContent ?? '');
      }
    });
    // Wrapped, not cut off: no label hides part of an id.
    const cut = await page.locator('#main .ne-heat-label, #main .ne-heat-group, #main td').evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent));
    expect(cut).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
