import { expect, Page, Route, test } from '@playwright/test';
import { axeBuilder } from './axe';

/**
 * GPU & Capacity, Wave 1 group G3 (backlog 2026-10-13): effective limits and dependency badges (W1-P14), the K8s
 * line per region (W1-P15), quota search over every row (W1-P16), live-API platforms as cards (W1-P17), the
 * Reservations empty state (W1-P18), history days recorded incompletely (#33), the history charts' ticks and empty
 * state (#52), the availability selects (#58) and the allowance-check rows at 390 px (#59). Against the e2e stub:
 * tenant non-GPU vCPU limit 0 in eu-north1, staging's GPU clusters cap 0 there, GB300 offered with no quota. Where
 * the stub has no such case, the reply is changed in the test (route), never the stub's shared data.
 */

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const THEMES = ['nebius-dark', 'nebius-light'];
const STAGING = 'project-e00mockstaging';
const LAB = 'project-e00mocklab';

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

/** Rewrites the /capacity reply (the real one from the stub, then `edit`). */
async function editCapacity(page: Page, edit: (c: any) => void) {
  await page.route('**/api/nebius-estate/capacity*', async (route: Route) => {
    const res = await route.fetch();
    const body = await res.json();
    edit(body);
    await route.fulfill({ response: res, json: body });
  });
}

const tile = (page: Page, model: string) => page.locator('#quotas .ne-cap-gpu').filter({ has: page.locator('.ne-cap-gpu-model', { hasText: new RegExp(`^${model}$`) }) });

const INCOMPLETE = 'Recorded incompletely: the day’s syncs missed GPUs that GPU telemetry saw.';
const history = (util: (number | null)[]) => ({
  days: 30,
  source: 'Daily snapshots recorded by this portal at each sync',
  note: 'One point per day.',
  points: util.map((u, i) => ({
    day: `2026-10-${String(9 + i).padStart(2, '0')}`, resources: 40, runningInstances: 1, gpus: 1, vcpus: i === 2 ? 0 : 24, ttlExpired: 0, orphanCandidates: 0, gpuUtilMean: u,
    ...(i === 2 ? { incomplete: INCOMPLETE } : {}),
  })),
});

for (const theme of THEMES) {
  for (const width of [1440, 390]) {
    test(`G3: quota cards with dependency badges, the K8s line and a GB300 card; Capacity passes axe without sideways scroll (${theme}, ${width} px)`, async ({ page }) => {
      await useTheme(page, theme);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/capacity');
      const north = page.getByRole('region', { name: 'Quotas in eu-north1' });
      // W1-P15: the tenant non-GPU vCPU limit 0 in eu-north1.
      await expect(north.locator('.ne-cap-k8s')).toContainText('Usable by K8s recipes: no CPU nodes');
      await expect(north.locator('.ne-cap-k8s')).toContainText('Non-GPU vCPU limit 0 (tenant)');
      // W1-P14: staging's GPU clusters cap 0 on the H100 card (an 8-GPU preset is offered), not on L40S.
      await expect(tile(page, 'H100')).toContainText('GPU clusters cap 0 (nip-staging): 8-GPU presets cannot join an InfiniBand GPU cluster');
      await expect(tile(page, 'L40S')).not.toContainText('GPU clusters');
      await expect(tile(page, 'H100')).toContainText('Tenant');
      // W1-P17: GB300 is offered by the live API in eu-north1 and no quota names it.
      await expect(tile(page, 'GB300')).toContainText('offered by the live API');
      await expect(tile(page, 'GB300')).toContainText('No GPU quota listed for GB300 in eu-north1');
      await page.evaluate(() => document.querySelectorAll('details').forEach(d => (d.open = true)));
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await axe(page);
    });
  }
}

test('W1-P14: with a project selected, a card leads with the limit its cap sets, "capped by project"; one without a cap says the tenant limit applies', async ({ page }) => {
  // The stub has no project cap on a GPU quota: lab gets a cap of 1 B300 under a tenant limit of 32 in uk-south1.
  await editCapacity(page, c => {
    c.quotas.value.push(
      { scope: 'tenant', allocation: 'set', projectId: '', name: 'compute.instance.gpu.b300', region: 'uk-south1', limit: 32, usage: 1, usagePercent: 3.125, unit: 'gpu', service: 'compute' },
      { scope: 'project', allocation: 'set', projectId: LAB, name: 'compute.instance.gpu.b300', region: 'uk-south1', limit: 1, usage: 1, usagePercent: 100, unit: 'gpu', service: 'compute' },
    );
    c.quotas.value = c.quotas.value.filter((q: any) => !(q.projectId === LAB && q.allocation === 'inherits-tenant' && q.name === 'compute.instance.gpu.b300'));
  });
  await page.goto(`/capacity?project=${LAB}`);
  const b300 = tile(page, 'B300');
  await expect(b300).toContainText('Effective limit for nip-lab: 1 / 1 GPUs');
  await expect(b300).toContainText('capped by project');
  await expect(b300).toHaveAttribute('data-level', 'over');
  await page.goto('/capacity');
  await expect(tile(page, 'B300')).toContainText('Capped by project: nip-lab 1');
  await page.goto(`/capacity?project=${STAGING}`);
  await expect(tile(page, 'H200')).toContainText('nip-staging: no project cap below the tenant limit, so the tenant limit applies.');
});

test('W1-P14: with no project allowance read, every card says the project cap is unknown', async ({ page }) => {
  await editCapacity(page, c => {
    c.quotas.value = c.quotas.value.filter((q: any) => q.scope === 'tenant');
  });
  await page.goto('/capacity');
  await expect(tile(page, 'H100')).toContainText('Project cap unknown: no project allowance was read');
});

test('W1-P16: a search in "All tenant quotas" covers every row while the near-limit filter is on', async ({ page }) => {
  await page.goto('/capacity');
  await page.getByText('All tenant quotas (10)').click();
  const fold = page.locator('details', { has: page.getByRole('table', { name: 'All quota allowances' }) });
  await fold.getByRole('checkbox', { name: /Near limit or blocked only/ }).check();
  const table = page.getByRole('table', { name: 'All quota allowances' });
  await expect(table).not.toContainText('compute.instance.gpu.h200');
  await page.getByLabel('Search all tenant quotas').fill('h200');
  await expect(table).toContainText('compute.instance.gpu.h200');
  await expect(fold).toContainText('1 of 10 shown (search covers every row)');
  await expect(fold.getByRole('checkbox', { name: /Near limit or blocked only/ })).toBeDisabled();
});

test('W1-P18: an empty reservation list links the capacity request runbook (at its reservation step) and the Nebius docs', async ({ page }) => {
  // The stub's allowance on an unlisted block group explains the empty list instead; without it the list is just empty.
  await editCapacity(page, c => {
    c.capacityAllowances.value = [];
    c.nodeGroups = c.nodeGroups.map((g: any) => ({ ...g, capacityType: g.capacityType === 'reserved' ? 'on-demand' : g.capacityType }));
  });
  await page.goto('/capacity#reservations');
  const card = page.locator('#reservations');
  await expect(card).toContainText('No reservations in this tenant');
  await expect(card.getByRole('link', { name: 'Reservations in the Nebius docs' })).toHaveAttribute('href', 'https://docs.nebius.com/compute/virtual-machines/reservations');
  await card.getByRole('link', { name: /How to request a reservation/ }).click();
  await expect(page).toHaveURL(/doc=runbooks%2Fcapacity-request\.md#3-reservation/);
  await expect(page.getByRole('heading', { name: /3\. Reservation/ })).toBeVisible();
});

test('#58: opening "more platform presets" leaves the Platform and Capacity type selects where they were', async ({ page }) => {
  // Ten platform presets advise on-demand capacity, so the best-region list folds.
  await editCapacity(page, c => {
    c.resourceAdvice.value = Array.from({ length: 10 }, (_, i) => ({ region: 'eu-north1', platform: `gpu-e00mock${i}`, preset: '1gpu-16vcpu-200gb', gpus: 1, onDemand: { level: 'high', available: 4, limit: 8 } }));
  });
  await page.goto('/capacity#availability');
  const select = page.getByRole('combobox', { name: 'Advice capacity type' });
  await expect(select).toBeVisible();
  const before = await select.boundingBox();
  await page.getByText('4 more platform presets').click();
  await expect(page.getByRole('list', { name: 'More best regions' })).toBeVisible();
  expect((await select.boundingBox())?.y).toBe(before?.y);
});

test('#59: at 390 px each allowance-check badge stays on its title row, above its sentence', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/capacity');
  const rows = page.getByRole('list', { name: 'Project caps that differ from the tenant limit' }).locator('li');
  await expect(rows).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    const badge = await rows.nth(i).locator('.ne-badge').boundingBox();
    const title = await rows.nth(i).locator('.ne-attn-row > span').first().boundingBox();
    const sentence = await rows.nth(i).locator(':scope > div').nth(1).boundingBox();
    expect(badge!.y).toBeLessThan(title!.y + title!.height);
    expect(badge!.y + badge!.height).toBeLessThanOrEqual(sentence!.y + 1);
  }
});

for (const theme of THEMES) {
  test(`#33, #52: a day recorded incompletely is a hollow point with its reason; whole-number GPU ticks; no empty axes (${theme}, 1440 and 390 px)`, async ({ page }) => {
    await useTheme(page, theme);
    let reply = history([40, 35, 70, 20, 30]);
    await page.route('**/api/nebius-estate/history*', route => route.fulfill({ json: reply }));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/capacity#gpu-telemetry');
      const card = page.locator('.ne-card', { hasText: 'GPUs present vs. GPU utilisation · 30 days' });
      await expect(card.locator('circle[data-incomplete="true"]')).toHaveCount(2);
      await expect(card.locator('figcaption').first()).toHaveText('Hollow point: a day recorded incompletely (10-11).');
      await expect(card).toContainText(`Hollow points: ${INCOMPLETE}`);
      const gpuTicks = await card.getByRole('img', { name: 'GPUs on running VMs, daily' }).locator('g[aria-hidden] > g > text').allTextContents();
      expect(gpuTicks).toEqual(['0', '1']);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await axe(page);
      // The Overview's trends mark the same day on the two backfilled figures (GPUs, utilisation), not on vCPUs or TTL.
      await page.goto('/');
      const trends = page.locator('.ne-card', { hasText: 'Trends · last 30 days' });
      await expect(trends.locator('circle[data-incomplete="true"]')).toHaveCount(2);
      await expect(trends.getByRole('img', { name: /vCPUs on running VMs/ }).locator('circle[data-incomplete="true"]')).toHaveCount(0);
    }
    reply = history([null, null, null, null, null]);
    await page.goto('/capacity#gpu-telemetry');
    const card = page.locator('.ne-card', { hasText: 'GPUs present vs. GPU utilisation · 30 days' });
    await expect(card).toContainText('No samples in these days.');
    await expect(card.getByRole('img', { name: 'GPUs on running VMs, daily' })).toBeVisible();
    await expect(card.locator('svg[role="img"]')).toHaveCount(1); // no empty utilisation axes
  });
}
