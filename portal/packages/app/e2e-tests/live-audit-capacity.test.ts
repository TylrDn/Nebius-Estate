import { expect, Page, test } from '@playwright/test';
import { axeBuilder } from './axe';

/**
 * Live audit 2026-10-12, sections GPU & Capacity and Fleet (G2.x), against the e2e stub. The live conditions
 * (a preemptible L40S run profile, a deleted GPU VM under a region filter) are reproduced with the repository's
 * run profiles and the stub's e00mock estate.
 */

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function openAll(page: Page) {
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => (d.open = true)));
}

test('G2.3: the calculator models a run profile: no CPU node, one preemptible L40S, priced preemptible', async ({ page }) => {
  await page.goto('/capacity#calculator');
  await openAll(page);
  const calc = page.locator('#calculator');
  await calc.getByLabel('Stack').selectOption('inference');
  await calc.getByLabel('Stage').selectOption('sandbox');
  // The expected footprint's price call (min, expected and max are priced apart): the profile sets 1 GPU node.
  const priced = page.waitForRequest(r => {
    if (!r.url().endsWith('/pricing/footprint') || r.method() !== 'POST') return false;
    const groups = (JSON.parse(r.postData() ?? '{}').footprint?.nodeGroups ?? []) as { platform: string; count: number }[];
    return groups.some(g => g.platform === 'gpu-l40s-a' && g.count === 1);
  });
  await calc.getByLabel('Run profile').selectOption('l40s-gpu-only');
  const body = JSON.parse((await priced).postData() ?? '{}');
  expect(body.capacityType).toBe('preemptible');
  expect(body.region).toBe('eu-north1');
  expect(body.footprint.nodeGroups.map((g: { platform: string; preset: string; count: number }) => [g.platform, g.preset, g.count])).toEqual([
    ['cpu-d3', '8vcpu-32gb', 0],
    ['gpu-l40s-a', '1gpu-8vcpu-32gb', 1],
  ]);
  await expect(calc.getByLabel('Region')).toHaveValue('eu-north1');
  await expect(calc).toContainText('platform/profiles/inference/l40s-gpu-only.json');
  await expect(calc).toContainText(/gpu-l40s-a, preemptible/);
  // The expected footprint needs no non-GPU vCPU.
  await expect(calc.getByRole('table', { name: 'Footprint quota needs' }).getByRole('row', { name: /^expected/ })).toContainText(/^expected\s*1\s*1\s*0/);
});

test('G2.4: under Preemptible the best-region summary speaks of preemptible capacity only', async ({ page }) => {
  await page.goto('/capacity#availability');
  await openAll(page);
  const card = page.locator('#availability');
  await card.getByLabel('Advice capacity type').selectOption('preemptible');
  const best = card.getByRole('list', { name: 'Best region per platform' });
  await expect(best).toBeVisible();
  await expect(best).not.toContainText('on-demand');
  await expect(best).toContainText(/preemptible/);
});

test('G2.11: the stage policy shows the gpu-vm and nvl caps and every STRICT requirement', async ({ page }) => {
  await page.goto('/capacity#stage-policy');
  await openAll(page);
  const table = page.getByRole('table', { name: 'Stage policy' });
  await expect(table.getByRole('columnheader', { name: 'GPU VMs (R10)' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'NVL rack nodes (R15)' })).toBeVisible();
  await expect(table.getByRole('row', { name: /^prod/ })).toContainText('0: refused');
  await expect(table.getByRole('row', { name: /^sandbox/ })).toContainText('nvl');
});

test('G2.13: the planned-roots badge is a link in the danger colour, like the other danger badges', async ({ page }) => {
  await page.goto('/capacity');
  const link = page.getByRole('link', { name: /^\d+ planned roots? blocked$/ });
  await expect(link).toBeVisible();
  const [linkColour, dangerColour] = await page.evaluate(() => {
    const a = document.querySelector('a.ne-badge.ne-tone-danger') as HTMLElement;
    const probe = document.createElement('span');
    probe.className = 'ne-badge ne-tone-danger';
    a.parentElement!.appendChild(probe);
    const out = [getComputedStyle(a).color, getComputedStyle(probe).color];
    probe.remove();
    return out;
  });
  expect(linkColour).toBe(dangerColour);
});

test('G2.10: a project and a region it is not in say the filter selects nothing', async ({ page }) => {
  // nip-lab runs in uk-south1.
  await page.goto('/capacity?project=project-e00mocklab&region=eu-north1');
  await expect(page.getByText('The filter selects nothing: nip-lab is not in eu-north1 (its region: uk-south1).').first()).toBeVisible();
  await expect(page.getByText(/listed no Compute GPU allowance/)).toHaveCount(0);
  await expect(page.getByText(/cannot be compared: ok/)).toHaveCount(0);
  expect((await axeBuilder(page).include('#main').withTags(AXE_TAGS).analyze()).violations).toEqual([]);
});

test('G2.1: under a region filter Fleet keeps the GPU of a VM deleted since', async ({ page }) => {
  await page.goto('/fleet?region=eu-west1');
  await expect(page.getByRole('button', { name: /nip-legacy-teardown-gpu-0/ })).toBeVisible();
});
