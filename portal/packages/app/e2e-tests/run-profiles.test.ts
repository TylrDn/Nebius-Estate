import { expect, Page, test } from '@playwright/test';
import { axeBuilder } from './axe';

/**
 * Wave 1, group G1: run profiles and Provisioning data safety (#27, W1-P1…W1-P5, #13, #43, #74 Calculator 503),
 * against the e2e stub. The stub tenant's eu-north1 non-GPU vCPU limit is 0, as in the live account, so the committed
 * sandbox/inference sizing (2 CPU nodes) is blocked while the l40s-gpu-only run profile (no CPU node) fits.
 */

async function openAll(page: Page) {
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => (d.open = true)));
}

async function calculator(page: Page) {
  await page.goto('/capacity#calculator');
  await openAll(page);
  return page.locator('#calculator');
}

test('#27: a run profile in the calculator fixes the node count; max never stays above it or warns above the cap', async ({ page }) => {
  const calc = await calculator(page);
  await calc.getByLabel('Stack').selectOption('inference');
  await calc.getByLabel('Stage').selectOption('sandbox');
  await calc.getByLabel('max GPU nodes').fill('4');
  await expect(calc.getByText(/Above the sandbox cap of 2 inference GPU nodes/)).toBeVisible();
  await calc.getByLabel('Run profile').selectOption('l40s-gpu-only');
  await expect(calc.getByLabel('expected GPU nodes')).toHaveValue('1');
  await expect(calc.getByLabel('max GPU nodes')).toHaveValue('1');
  await expect(calc.getByText(/Above the sandbox cap/)).toHaveCount(0);
});

test('#43: a calculator quota line says its units and what each number is', async ({ page }) => {
  const calc = await calculator(page);
  await calc.getByLabel('Stack').selectOption('inference');
  await calc.getByLabel('Stage').selectOption('sandbox');
  const expected = calc.getByRole('table', { name: 'Footprint quota needs' }).getByRole('row', { name: /^expected/ });
  await expect(expected).toContainText('compute.instance.non-gpu.vcpu needs 16 vCPU, limit 0 in eu-north1');
});

test('#74: the calculator says why there is no live price when the pricing route answers 503', async ({ page }) => {
  await page.route('**/api/nebius-estate/pricing/footprint', route =>
    route.fulfill({ status: 503, json: { error: { name: 'ServiceUnavailableError', message: 'The Nebius billing calculator is unavailable.' } } }),
  );
  const calc = await calculator(page);
  await calc.getByLabel('Stack').selectOption('inference');
  await expect(calc.getByText('No live price: The pricing request failed: The Nebius billing calculator is unavailable.')).toBeVisible();
  const table = calc.getByRole('table', { name: 'Footprint quota needs' });
  for (const k of ['min', 'expected', 'max']) {
    await expect(table.getByRole('row', { name: new RegExp(`^${k}`) }).getByRole('cell').last()).toHaveText('none');
  }
  await expect(calc).not.toContainText(/\d XTS/);
});

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const prepare = (page: Page) => page.getByRole('button', { name: 'Prepare reviewed change' });

async function provisioning(page: Page, recipe?: RegExp) {
  await page.goto('/provisioning');
  if (recipe) await page.getByRole('radio', { name: recipe }).click();
  await page.locator('#pv-ref').fill(`e2e-g1-${Date.now()}`);
}

test('Rate book, one model: with no rate book Provisioning still estimates, at the Nebius list price, and does not compare the list price with itself', async ({ page }) => {
  // No rate book imported (other tests import one into the shared database, so both replies are the no-book ones).
  await page.route('**/api/nebius-estate/ratebooks', route => route.fulfill({ json: { items: [], builtIn: { id: 'nebius-list-price', name: 'Nebius list price (live calculator)', currency: 'XTS', available: true } } }));
  await page.route('**/api/nebius-estate/provisioning/estimate', async route => {
    const res = await route.fetch();
    const body = await res.json();
    body.rateBook = { ...body.rateBook, id: 'nebius-list-price', name: 'Nebius list price (live calculator)', kind: 'public-list' };
    await route.fulfill({ response: res, json: body });
  });
  await provisioning(page);
  const card = page.locator('.ne-card', { hasText: '4 · Estimate and pricing coverage' });
  await expect(card).toContainText('Nebius list price (live calculator)');
  await expect(card).toContainText(/no rate book is in use \(optional/);
  await expect(card).not.toContainText('estimate unavailable');
  await expect(page.locator('#pv-live-price')).not.toContainText('Compared with your user rate book');
});

test('W1-P5: the diff and the estimate show before a request reference is typed; the run sheet and Prepare wait for it', async ({ page }) => {
  await page.goto('/provisioning');
  await page.locator('#pv-gpus').fill('2');
  await expect(page.getByLabel('Diff of terraform/live/sandbox/inference/sandbox.auto.tfvars')).toContainText('+gpu_node_count');
  await expect(page.locator('.ne-card', { hasText: '4 · Estimate and pricing coverage' })).toContainText('Hourly (requested)');
  await expect(page.getByText('Shown once the request passes validation (step 2).')).toHaveCount(0);
  await expect(page.locator('#pv-ref')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Run sheet')).toHaveCount(0);
  await expect(page.getByText('The run sheet is shown once a request reference is entered').first()).toBeVisible();
  await expect(prepare(page)).toBeDisabled();
  await page.locator('#pv-ref').fill('e2e-w1p5');
  await expect(page.getByLabel('Run sheet')).toContainText('"nip-run":"e2e-w1p5"');
  await expect(page.locator('#pv-ref')).not.toHaveAttribute('aria-invalid', 'true');
});

test('W1-P1: switching to prod keeps its 4096 GiB filesystem; changing GPU nodes patches gpu_node_count alone', async ({ page }) => {
  await provisioning(page, /Training capacity request/);
  await expect(page.locator('#pv-fs')).toHaveValue('256');
  await page.locator('#pv-stage').selectOption('prod');
  await expect(page.locator('#pv-fs')).toHaveValue('4096');
  await expect(page.locator('label[for=pv-fs]')).toContainText('from sizing file');
  await page.locator('#pv-gpus').fill('2');
  await expect(page.locator('label[for=pv-gpus]')).toContainText('changed by you');
  const diff = page.getByLabel('Diff of terraform/live/prod/training/prod.auto.tfvars');
  await expect(diff).toContainText('+gpu_node_count = 2');
  await expect(diff).not.toContainText('filestore_size_gib');
  // Staging has its own 1024 GiB.
  await page.locator('#pv-stage').selectOption('staging');
  await expect(page.locator('#pv-fs')).toHaveValue('1024');
  await expect(page.locator('#pv-gpus')).toHaveValue('0');
});

test('W1-P2: a smaller filesystem is an error until reset or confirmed; W1-P5: its diff still shows', async ({ page }) => {
  await provisioning(page, /Training capacity request/);
  await page.locator('#pv-stage').selectOption('prod');
  await page.locator('#pv-fs').fill('256');
  await expect(page.getByText(/Shared filesystem would shrink from 4,096 GiB to 256 GiB/).first()).toBeVisible();
  await expect(page.locator('#pv-fs')).toHaveAttribute('aria-invalid', 'true');
  await expect(prepare(page)).toBeDisabled();
  await expect(page.getByText(/Prepare is blocked by \d+ errors?/)).toBeVisible();
  await expect(page.getByLabel('Diff of terraform/live/prod/training/prod.auto.tfvars')).toContainText('+filestore_size_gib = 256');
  await page.getByLabel(/I intend to shrink\/replace/).check();
  await expect(page.locator('#pv-fs')).not.toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: 'Reset to 4,096 GiB' }).click();
  await expect(page.locator('#pv-fs')).toHaveValue('4096');
  await expect(page.getByText(/would shrink/)).toHaveCount(0);
});

test('#27, W1-P3, #13: the committed sizing is blocked by quota; the l40s-gpu-only profile fits and is planned with PROFILE=', async ({ page }) => {
  await provisioning(page);
  const quota = page.locator('.ne-card', { hasText: 'Quota needs vs limits · eu-north1' });
  await expect(quota).toContainText('would stop this plan');
  await expect(quota.getByRole('table', { name: 'Quota needs vs limits' })).toContainText('16 vCPU');
  await expect(quota.getByTestId('quota-read-at')).toContainText('Tenant allowances read');
  // The stub lists tenant allowances in eu-north1 only: no other region is claimed to fit.
  await expect(quota.getByTestId('fits-in')).toContainText('no other region confirmed by the quota API');
  await expect(prepare(page)).toBeDisabled();
  await page.locator('#pv-profile').selectOption('l40s-gpu-only');
  await expect(page.locator('#pv-region')).toBeDisabled();
  await expect(page.locator('#pv-gpus')).toBeDisabled();
  await expect(page.locator('label[for=pv-platform]')).toContainText('from run profile l40s-gpu-only');
  await expect(page.locator('#pv-platform')).toHaveValue('gpu-l40s-a');
  await expect(quota).toContainText('Within the tenant allowances');
  await expect(page.getByLabel('Run sheet')).toContainText('PROFILE=l40s-gpu-only');
  await expect(page.getByLabel('Diff of terraform/live/sandbox/inference/sandbox.auto.tfvars')).toContainText('no change');
  await expect(prepare(page)).toBeEnabled();
  // Back to the sizing file: blocked again, until a quota request is pending.
  await page.locator('#pv-profile').selectOption('');
  await expect(prepare(page)).toBeDisabled();
  await page.getByLabel('Prepare anyway: quota request pending').check();
  await expect(prepare(page)).toBeEnabled();
});

test('W1-P3: "Fits in" switches the region in one click', async ({ page }) => {
  // The stub tenant has no allowances outside eu-north1, so the backend's answer is extended for this UI check.
  await page.route('**/api/nebius-estate/provisioning/preview', async route => {
    const res = await route.fetch();
    const body = await res.json();
    if (body.quotaCheck?.region === 'eu-north1') body.fitsIn = [{ region: 'eu-west1', platform: 'gpu-h200-sxm', checked: 4, unchecked: [] }];
    await route.fulfill({ response: res, json: body });
  });
  await provisioning(page);
  await page.getByRole('button', { name: 'Use eu-west1' }).click();
  await expect(page.locator('#pv-region')).toHaveValue('eu-west1');
  await expect(page.locator('.ne-card', { hasText: 'Quota needs vs limits · eu-west1' })).toBeVisible();
});

test('W1-P4: STRICT is checked against the tenant\'s capacity block groups; the fabric is a picker', async ({ page }) => {
  await provisioning(page, /Training capacity request/);
  await expect(page.locator('#pv-fabric option')).toHaveText(['Platform default (fabric-3)', 'fabric-2', 'fabric-3', 'fabric-4', 'fabric-6']);
  await page.locator('#pv-gpus').fill('2');
  await page.locator('#pv-cap').selectOption('reserved');
  await page.locator('#pv-res').selectOption('STRICT');
  const card = page.locator('.ne-card', { hasText: 'Reservations · STRICT' });
  await expect(card).toContainText('none matching');
  await expect(card).toContainText('no capacity block group for gpu-h100-sxm in eu-north1');
  await expect(prepare(page)).toBeDisabled();
  await page.locator('#pv-fabric').selectOption('fabric-4');
  await expect(page.getByLabel('Diff of terraform/live/sandbox/training/sandbox.auto.tfvars')).toContainText('infiniband_fabric = "fabric-4"');
});

for (const scheme of ['dark', 'light'] as const) {
  test(`a live price that is updating stays readable: the figure is marked, not faded below contrast (${scheme})`, async ({ page }) => {
    // A full e2e run caught the figure mid-update: opacity 0.6 put its unit at 3.67:1 in the dark theme.
    await page.emulateMedia({ colorScheme: scheme });
    await provisioning(page);
    const figure = page.locator('#pv-live-price .u5-figure').first();
    await expect(figure).toContainText(/\/ h/);
    await figure.evaluate(e => e.setAttribute('data-updating', 'true'));
    const r = await axeBuilder(page).include('#pv-live-price .u5-figure').withRules(['color-contrast']).analyze();
    expect(r.violations.flatMap(v => v.nodes.map(n => `${n.target.join(' ')}: ${n.any.map(a => a.message).join(' ')}`))).toEqual([]);
  });
}

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });
    test('Provisioning with a profile, a shrink and the quota switch: no axe violations; nothing overflows at 390 px', async ({ page }) => {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await provisioning(page, /Training capacity request/);
        await page.locator('#pv-stage').selectOption('prod');
        await page.locator('#pv-fs').fill('256');
        await expect(page.getByRole('button', { name: 'Reset to 4,096 GiB' })).toBeVisible();
        await expect(page.locator('.ne-card', { hasText: 'Quota needs vs limits' })).toBeVisible();
        await page.waitForLoadState('networkidle');
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
        expect(await axeBuilder(page).include('#main').withTags(AXE_TAGS).analyze().then(r => r.violations.flatMap(v => v.nodes.map(n => `${v.id}: ${n.target.join(' ')} ${n.any.map(a => a.message).join(' ')}`)))).toEqual([]);
      }
      await page.getByRole('radio', { name: /Sandbox inference/ }).click();
      await page.locator('#pv-ref').fill(`e2e-g1-${Date.now()}`);
      await page.locator('#pv-profile').selectOption('l40s-gpu-only');
      await expect(page.locator('label[for=pv-gpus]')).toContainText('from run profile');
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      expect(await axeBuilder(page).include('#main').withTags(AXE_TAGS).analyze().then(r => r.violations.map(v => v.id))).toEqual([]);
    });
  });
}
