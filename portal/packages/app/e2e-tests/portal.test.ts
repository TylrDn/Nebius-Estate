import { expect, Page, test } from '@playwright/test';
import { axeBuilder } from './axe';
// Test-only: locates the shared test data next to the stub.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'fs';
// eslint-disable-next-line no-restricted-imports
import { resolve } from 'path';

/**
 * Smoke tests for the primary workflows: the real app and backend against a
 * loopback stub of the documented Nebius REST endpoints (portal/e2e-stub/,
 * test data with e00mock ids). Nothing is pre-loaded: tests import the rate
 * book and the FOCUS file through the UI, as an operator would. Each page is
 * also checked with axe for WCAG 2.1 A/AA violations.
 */

// eslint-disable-next-line no-restricted-syntax
const TEST_DATA = resolve(__dirname, '../../../e2e-stub');

async function importRateBook(page: Page) {
  await page.goto('/commercial');
  await page.getByRole('tab', { name: 'Rate books' }).click();
  await page.locator('input[type=file]').setInputFiles(resolve(TEST_DATA, 'ratebook.json'));
  await expect(page.getByText(/Imported rate book Test rate book/)).toBeVisible();
}

async function importFocus(page: Page) {
  await page.goto('/costs');
  await page.locator('input[type=file]').setInputFiles(resolve(TEST_DATA, 'focus.csv'));
  await expect(page.getByText(/^Imported \d+ rows/)).toBeVisible();
}

const PAGES: [string, string][] = [
  ['/', 'Overview'],
  ['/estate', 'Estate Explorer'],
  ['/capacity', 'GPU & Capacity'],
  ['/fleet', 'Fleet'],
  ['/alerts', 'Alerts'],
  ['/logs', 'Logs'],
  ['/workloads', 'Workloads'],
  ['/ai-services', 'AI services'],
  ['/provisioning', 'Provisioning'],
  ['/costs', 'Costs'],
  ['/commercial', 'Commercial Scenarios'],
  ['/budgets', 'Budgets & credits'],
  ['/evidence', 'Evidence & Runbooks'],
  ['/solutions', 'Solutions'],
  ['/nebius-docs', 'Nebius docs'],
  ['/integrations', 'Integrations & Coverage'],
];

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });
    for (const [path, title] of PAGES) {
      test(`${title}: renders, shows the read-only indicator, has no axe violations`, async ({
        page,
      }) => {
        await page.goto(path);
        await expect(
          page.getByRole('heading', { level: 1, name: title }),
        ).toBeVisible();
        // Read-only toward Nebius (F1.22): the portal itself saves budgets, scenarios and imports.
        await expect(
          page.locator('.ne-header').getByText('Read-only to Nebius', { exact: true }),
        ).toBeVisible();
        await expect(page.locator('.ne-header').getByText('Read-only', { exact: true })).toHaveCount(0);
        // F1.29: the stub run says so on every page, never passing for the tenant.
        await expect(page.locator('.ne-header').getByRole('note', { name: 'Test data' })).toContainText('Test data — not your tenant');
        await expect(page.getByRole('navigation', { name: 'Primary' }).getByText('Test data', { exact: true })).toBeVisible();
        await page.waitForLoadState('networkidle');
        // axe checks the loaded page, not its loading skeleton.
        await expect(page.locator('#main .ne-skel')).toHaveCount(0);
        const results = await axeBuilder(page)
          .include('#main')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(
          results.violations.map(
            v =>
              `${v.id}: ${v.nodes
                .map(n => n.target.join(' '))
                .slice(0, 3)
                .join(', ')}`,
          ),
        ).toEqual([]);
      });
    }
  });
}

test('primary navigation is ordered and keyboard reachable', async ({
  page,
}) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.locator('.ne-nav-link')).toHaveText(PAGES.map(([, t]) => t));
  await nav.getByRole('link', { name: 'Costs' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/costs$/);
});

test('capacity: tenant reads answer; an empty reservation list beside a reservation in use says so, and quotas are listed', async ({ page }) => {
  await page.goto('/capacity');
  // The list is empty, but an allowance and a node group use a reservation: reconciled in words (F1.10).
  await expect(page.getByText('Reservation in use, not listed', { exact: true })).toBeVisible();
  await expect(page.getByText(/compute\.instance\.gpu\.h100/).first()).toBeVisible();
});

test('estate explorer: graph node opens the detail drawer; Escape closes it', async ({
  page,
}) => {
  await page.goto('/estate');
  const node = page.getByRole('button', {
    name: /pvc-9a77d2c4-old-model-cache Disk/,
  });
  await node.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog');
  await expect(
    drawer.getByText('Orphan candidate — review before any action'),
  ).toBeVisible();
  await expect(drawer.getByText(/never inferred from the name/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('global filter narrows the explorer table to one project', async ({
  page,
}) => {
  await page.goto('/estate?mode=table');
  await page.getByLabel('Project', { exact: true }).selectOption('project-e00mocklab');
  await expect(page.getByText(/Resources \(\d+\)/)).toBeVisible();
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toContainText('nip-lab'); // the project's name; its id is in the tooltip
  await page.getByRole('button', { name: 'Clear filters' }).click();
});

test('estate explorer: a resource the latest inventory sync did not read says "last seen", in its row and drawer', async ({
  page,
}) => {
  // The stub answers every list on every sync: inject lastSeen into the real responses for one disk.
  const lastSeen = new Date(Date.now() - 2 * 3600_000).toISOString();
  const mark = (r: { name?: string }) => (r.name === 'pvc-9a77d2c4-old-model-cache' ? { ...r, lastSeen } : r);
  await page.route(/\/api\/nebius-estate\/resources(\/|\?|$)/, async route => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: Array.isArray(body.items) ? { ...body, items: body.items.map(mark) } : mark(body) });
  });
  await page.goto('/estate?mode=table');
  const row = page.locator('tbody tr').filter({ hasText: 'pvc-9a77d2c4-old-model-cache' });
  await expect(row).toContainText(/last seen 2 h\w* ago/);
  await row.getByText('pvc-9a77d2c4-old-model-cache').first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Last seen', { exact: true })).toBeVisible();
  await expect(drawer.getByText(/may have changed or gone since; never priced in the run-rate/)).toBeVisible();
});

test('provisioning: policy error, preview diff, prepare a reviewed change', async ({
  page,
}) => {
  await importRateBook(page);
  await page.goto('/provisioning');
  // One open request per sizing file: withdraw what earlier runs left open.
  // The wizard and request list load independently; an early count can miss requests.
  await expect(page.locator('#pv-ref')).toBeVisible();
  await expect(page.locator('#main .ne-skel')).toHaveCount(0);
  const requests = page.getByRole('region', { name: 'Provisioning requests' });
  while (
    (await requests.getByRole('button', { name: 'Withdraw' }).count()) > 0
  ) {
    await requests.getByRole('button', { name: 'Withdraw' }).first().click();
    await page.waitForTimeout(400);
  }
  // No reference is pre-filled: validation starts once the request names its ticket or run.
  await page.locator('#pv-ref').fill(`e2e-${Date.now()}`);
  await page.locator('#pv-gpus').fill('3');
  await expect(
    page
      .getByText('3 GPU nodes exceeds the sandbox cap of 2 for inference')
      .first(),
  ).toBeVisible();
  await page.locator('#pv-gpus').fill('2');
  await expect(
    page.getByLabel(
      'Diff of terraform/live/sandbox/inference/sandbox.auto.tfvars',
    ),
  ).toContainText('+gpu_node_count  = 2');
  await expect(
    page
      .getByText('Draft estimate — not a provider offer or capacity guarantee.')
      .first(),
  ).toBeVisible();
  // F1.41: the live price says which capacity type it priced, in its header and on each VM line.
  const live = page.locator('#pv-live-price');
  const capacity = await page.locator('#pv-cap').inputValue();
  await expect(live.getByTestId('live-capacity')).toContainText(`Capacity: ${capacity}`);
  const vmLines = live.getByRole('table', { name: /Live price lines/ }).getByRole('row').filter({ hasText: /gpu-|cpu-/ }).filter({ hasNotText: /boot disk/ });
  expect(await vmLines.count()).toBeGreaterThan(0);
  for (const row of await vmLines.all()) await expect(row).toContainText(/ · (preemptible|on-demand)/);
  // W1-P3: the stub's vCPU limit 0 stops the committed CPU nodes: Prepare waits for "quota request pending".
  await expect(page.getByRole('button', { name: 'Prepare reviewed change' })).toBeDisabled();
  await page.getByLabel('Prepare anyway: quota request pending').check();
  // G5.6: Estimate is done once priced (rate book here, or the live price).
  await expect(page.getByRole('list', { name: 'Provisioning steps' }).getByText('Estimate', { exact: true })).toHaveAttribute('data-state', 'done');
  // G5.5: the quota table is full width; its status badges are inside the card at 1440 px.
  const quota = page.locator('.ne-card', { has: page.getByRole('table', { name: 'Quota needs vs limits' }) });
  const card = (await quota.boundingBox())!;
  expect(card.width).toBeGreaterThan(800);
  for (const b of await quota.locator('td .ne-badge').all()) {
    const box = (await b.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width);
  }
  await expect(quota.getByRole('row', { name: /mk8s\.cluster\.count/ })).toContainText('fits'); // G5.3
  await page.getByRole('button', { name: 'Prepare reviewed change' }).click();
  await expect(page.getByText(/Request [0-9a-f]{8} prepared/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Download patch' }),
  ).toBeVisible();
  // G5.4: a second click would only be refused: Prepare waits for the next input change.
  await expect(page.getByRole('button', { name: 'Prepare reviewed change' })).toBeDisabled();
  // G5.1: approved → deployed with its evidence file, through the UI.
  const ref = await page.locator('#pv-ref').inputValue();
  const row = page.getByRole('region', { name: 'Provisioning requests' }).getByRole('row', { name: new RegExp(ref) });
  await row.getByRole('button', { name: 'Mark approved' }).click();
  await expect(row).toContainText('approved');
  await expect(row.getByRole('button', { name: 'Withdraw' })).toBeVisible();
  await row.getByRole('button', { name: 'Mark deployed' }).click();
  const evidence = row.getByLabel(`Evidence file for ${ref}`);
  await evidence.fill('notes.md');
  await row.getByRole('button', { name: 'Save deployed' }).click();
  await expect(evidence).toHaveAttribute('aria-invalid', 'true');
  await evidence.fill('docs/evidence/2026-10-12-e2e-run.md');
  await row.getByRole('button', { name: 'Save deployed' }).click();
  await expect(row).toContainText('deployed');
  await expect(row).toContainText('docs/evidence/2026-10-12-e2e-run.md');
  await expect(row.getByRole('button', { name: /Withdraw|Mark/ })).toHaveCount(0);
});

test('costs: a FOCUS import, then metrics are switched, never summed; CSV export is offered', async ({
  page,
}) => {
  await importFocus(page);
  await page.goto('/costs');
  await expect(page.getByRole('region', { name: 'Export lag' })).toContainText(
    'delayed export',
  );
  await page.getByRole('button', { name: 'Effective cost' }).click();
  await expect(page.getByText(/^Effective cost: Amortised cost .*\(FOCUS EffectiveCost\)/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();
});

test('commercial: nothing is pre-loaded; an imported rate book is listed with its source', async ({
  page,
}) => {
  await importRateBook(page);
  await expect(page.getByRole('region', { name: 'Rates' })).toContainText('test data');
  await page.getByRole('tab', { name: /Scenarios/ }).click();
  await expect(page.getByText('No scenarios yet')).toBeVisible();
});

// After "nothing is pre-loaded" in this file (tests in a file run in order): it creates the first scenario.
test('commercial F1.17/F1.18: scenarios are made from pickers; an empty minimum prices at 0.00', async ({ page }) => {
  await importRateBook(page);
  await page.getByRole('tab', { name: /Scenarios/ }).click();
  // The form is open while no scenario exists (a fresh run); against a reused server, open it.
  const open = page.getByRole('button', { name: 'New scenario' });
  await expect(open.or(page.getByText('No scenarios yet'))).toBeVisible();
  if (await open.isVisible()) await open.click();
  const form = page.locator('.ne-card', { has: page.getByRole('button', { name: 'Create scenario' }) });
  // Region, platform and preset are picked from the rate book (and platform/regions.yaml), not typed.
  await expect(form.getByLabel('Region')).toHaveJSProperty('tagName', 'SELECT');
  await expect(form.getByLabel('Region').locator('option')).toHaveText(['eu-north1', 'eu-west1', 'uk-south1']);
  await expect(form.getByLabel('Platform').locator('option')).toHaveText(['cpu-d3', 'gpu-h100-sxm', 'gpu-h200-sxm']);
  // The form opens on a GPU platform with a preset picker, not on cpu-d3's free-text preset (review of F1.17).
  await expect(form.getByLabel('Platform')).toHaveValue('gpu-h100-sxm');
  await expect(form.getByLabel('Preset')).toHaveJSProperty('tagName', 'SELECT');
  await form.getByLabel('Platform').selectOption('gpu-h100-sxm');
  await expect(form.getByLabel('Preset').locator('option')).toHaveText(['1gpu-16vcpu-200gb', '8gpu-128vcpu-1600gb']);
  await form.getByLabel('Name').fill('W1d pickers');
  await form.getByRole('button', { name: 'Create scenario' }).click();

  // The new scenario's minimum footprint has no node: the live price is 0.00, not "Unavailable".
  const live = page.locator('.u5-live');
  const minimum = live.getByRole('region', { name: 'Nebius live price (billing calculator) · minimum' });
  await expect(minimum).toContainText('0.00 XTS');
  await expect(minimum).toContainText('empty footprint: nothing to price');
  await expect(minimum).not.toContainText('Unavailable');
  await expect(live.getByRole('table', { name: 'Rate book compared with the live price' }).getByRole('row', { name: /minimum/ })).toContainText('0.00 XTS');
  await expect(live.getByRole('region', { name: 'Nebius live price (billing calculator) · expected' })).toContainText(/\d XTS/);

  // The scenario's region is a picker too (the rate book's regions): no typed region can fail the calculator's check.
  const region = page.locator('#s-region');
  await expect(region).toHaveJSProperty('tagName', 'SELECT');
  await expect(region.locator('option')).toHaveText(['eu-north1', 'eu-west1 · no rate for gpu-h100-sxm', 'uk-south1 · no rate for gpu-h100-sxm']);
  await region.selectOption('uk-south1');
  await expect(live.getByText(/pattern|Invalid string/)).toHaveCount(0);
  // The field says why the scenario now has pricing gaps.
  await expect(page.getByText('No rate for gpu-h100-sxm in uk-south1: those node groups show as pricing gaps')).toBeVisible();
  // The rate-book select is never blank.
  await expect(page.locator('#s-book option:checked')).toHaveText('Test rate book (XTS, invented prices)');
  expect(await axeBuilder(page).include('#main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze().then(r => r.violations.map(v => v.id))).toEqual([]);
});

// After F1.17 above, which creates the first scenario: its draft quote at 390 px.
test('commercial F1.49: the draft-estimate badge wraps at 390 px instead of being cut off', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/commercial');
  await page.getByRole('tab', { name: /Scenarios/ }).click();
  const badge = page.locator('.ne-badge', { hasText: 'Draft estimate — not a provider offer or capacity guarantee.' });
  await expect(badge).toBeVisible();
  expect(await badge.evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
  const box = await badge.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

// After F1.17: a scenario priced with no rate book, at the built-in live list price (W1-P6). Deleted at the end.
test('commercial W1-P6: a scenario can be created and priced at the Nebius list price without any rate book', async ({ page }) => {
  await page.goto('/commercial');
  await page.getByRole('tab', { name: /Scenarios/ }).click();
  await page.getByRole('button', { name: 'New scenario' }).click();
  const form = page.locator('.ne-card', { has: page.getByRole('button', { name: 'Create scenario' }) });
  await form.getByLabel('Rate book').selectOption({ label: 'Nebius list price (live calculator)' });
  await expect(form.getByLabel('Region')).toHaveValue('eu-north1');
  // The hints name the region file, not a rate book; the list price has no reserved rate, so it is not offered.
  await expect(form).toContainText('Platforms of platform/regions.yaml in eu-north1');
  await expect(form).not.toContainText('With a GPU or vCPU rate');
  await expect(form).not.toContainText('From the rate book');
  await expect(form.getByLabel('Capacity type').locator('option', { hasText: 'reserved' })).toBeDisabled();
  await form.getByLabel('Name').fill('W1-P6 list price');
  await form.getByRole('button', { name: 'Create scenario' }).click();
  await expect(page.locator('#s-name')).toHaveValue('W1-P6 list price');
  const quote = page.locator('#draft-quote');
  await expect(quote).toContainText('Nebius list price (live calculator)');
  const headline = page.getByRole('region', { name: 'Public list-rate estimate' });
  await expect(headline).toContainText(/\d XTS/);
  await expect(headline).not.toContainText('Incomplete');
  // The built-in list price is named as such: not a user rate book, nothing "entered by you", no comparison with itself.
  await expect(quote).toContainText('built-in Nebius list price (live calculator)');
  await expect(page.locator('#live-list-price')).toBeVisible();
  for (const text of ['user rate book', 'entered by you', 'rates you entered']) await expect(page.locator('#main')).not.toContainText(text);
  await expect(page.getByRole('table', { name: 'Rate book compared with the live price' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Delete scenario W1-P6 list price' }).click();
  await page.getByRole('button', { name: 'Confirm: delete scenario W1-P6 list price' }).click();
  await expect(page.getByText('Deleted scenario W1-P6 list price.')).toBeVisible();
});

// After F1.17 (a scenario exists): no total is built on an unpriced line (W1-P9, #50). Edits are not saved.
test('commercial W1-P9, #50: a total names the lines it leaves out; an unpriced GPU line leaves no total and no selling price', async ({ page }) => {
  await page.goto('/commercial');
  await page.getByRole('tab', { name: /Scenarios/ }).click();
  await expect(page.locator('#s-region')).toBeVisible();
  await page.locator('#s-region').selectOption('eu-north1');
  // Network SSD in eu-north1 has only an expired rate: the total stands and says it leaves that line out.
  await page.getByLabel('extraSsdGib max', { exact: true }).fill('50');
  await page.getByLabel('extraSsdGib expected', { exact: true }).fill('50');
  const headline = page.getByRole('region', { name: /^(Negotiated-rate scenario|Public list-rate estimate)$/ });
  await expect(headline).toContainText('excludes 1 unpriced line');
  await expect(headline).toContainText(/\d XTS/);
  await expect(page.getByRole('table', { name: 'Footprint comparison' }).getByRole('row', { name: /expected/ })).toContainText('1');
  // #70: unit rates keep their digits and say their unit; four columns, so a phone card is short.
  const lines = page.getByRole('table', { name: 'Cost lines' });
  await expect(lines.getByRole('row', { name: /boot disk/ }).first()).toContainText('0.0002 / GiB');
  await expect(lines.getByRole('columnheader')).toHaveCount(4);
  // No H100 rate in uk-south1: the GPU, vCPU and RAM lines are unpriced, so there is no total and no selling price.
  await page.locator('#s-margin').fill('10');
  await page.locator('#s-region').selectOption('uk-south1');
  await expect(headline).toContainText('Incomplete: 3 lines unpriced');
  await expect(headline).not.toContainText('XTS');
  await expect(page.getByRole('region', { name: 'Monthly scenario' })).toContainText('—');
  const selling = page.getByRole('region', { name: 'Customer-facing draft selling price' });
  await expect(selling).toContainText('Not priced: 3 lines unpriced');
  await expect(selling).not.toContainText('XTS');
  await expect(page.getByRole('table', { name: 'Footprint comparison' }).getByRole('row', { name: /expected/ })).toContainText('incomplete');
  expect(await axeBuilder(page).include('#main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze().then(r => r.violations.map(v => v.id))).toEqual([]);
});

// After F1.17 (a scenario exists): the live audit's scenario fixes (G4.6–G4.8, G4.14). Ends with the list as it was.
test('commercial G4.6–G4.8, G4.14: Save as copy opens the copy; footprints out of order are named; Delete in two steps', async ({ page }) => {
  await page.goto('/commercial');
  await page.getByRole('tab', { name: /Scenarios/ }).click();
  const list = page.getByRole('list', { name: 'Scenarios' });
  await expect(list.getByRole('button').first()).toBeVisible();
  const original = (await page.locator('#s-name').inputValue()).trim();
  // G4.14: the live price names the project, as Provisioning does.
  const livePrice = page.locator('.ne-card', { has: page.locator('#live-list-price') });
  await expect(livePrice).toContainText(/priced in project nip-/);
  await expect(livePrice).not.toContainText(/priced in project project-/);
  // G4.8: the copy is open after Save as copy, so edits change the copy.
  await page.getByRole('button', { name: 'Save as copy' }).click();
  await expect(page.locator('#s-name')).toHaveValue(`${original} (copy)`);
  await expect(list.getByRole('button', { pressed: true })).toContainText(`${original} (copy)`);
  await expect(page.getByText(`Saved ${original} (copy); it is open below.`)).toBeVisible();
  // G4.7: expected above maximum is named on the maximum, and nothing is saved.
  const firstGroup = page.locator('table.ne-table-compact tbody tr').first();
  const max = firstGroup.getByLabel(/ max count$/);
  const maxCount = Number(await max.inputValue());
  await firstGroup.getByLabel(/ expected count$/).fill(String(maxCount + 2));
  await expect(max).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Footprints out of order: not saved')).toBeVisible();
  await expect(page.getByText(new RegExp(`expected ${maxCount + 2} is above the maximum ${maxCount}`))).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save as copy' })).toBeDisabled();
  expect(await axeBuilder(page).include('#main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze().then(r => r.violations.map(v => v.id))).toEqual([]);
  // G4.6: Delete in two steps; the next scenario opens.
  await page.getByRole('button', { name: `Delete scenario ${original} (copy)` }).click();
  await page.getByRole('button', { name: `Confirm: delete scenario ${original} (copy)` }).click();
  await expect(page.getByText(`Deleted scenario ${original} (copy).`)).toBeVisible();
  await expect(list.getByRole('button', { name: new RegExp(`${original.replace(/[()]/g, '\\$&')} \\(copy\\)`) })).toHaveCount(0);
  await expect(page.locator('#s-name')).toHaveValue(original);
});

test('commercial G4.5: the run-rate book is named with its reason; a rate book can be deleted unless a scenario uses it', async ({ page }) => {
  await importRateBook(page);
  await expect(page.getByText(/^Run-rate book: Test rate book/)).toBeVisible();
  await expect(page.locator('.ne-badge', { hasText: 'run-rate book' })).toBeVisible();
  // A what-if book sorted after it (so the run-rate of tests running alongside keeps its book), then deleted.
  const book = JSON.parse(readFileSync(resolve(TEST_DATA, 'ratebook.json'), 'utf8'));
  const whatIf = { ...book, id: 'zzz-g4-whatif', name: 'G4 what-if book', kind: 'public-list', classification: 'public' };
  await page.locator('input[type=file]').setInputFiles({ name: 'whatif.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(whatIf)) });
  await expect(page.getByText(/Imported rate book G4 what-if book/)).toBeVisible();
  // Two books and no default: the choice is said to depend on ids.
  await expect(page.getByText(/the first of 2 active rate books by id/)).toBeVisible();
  // W1-P8: archived, it is no longer a default candidate; restored; the test book set as the portal default (stored).
  await page.getByRole('button', { name: 'Archive rate book G4 what-if book' }).click();
  await expect(page.getByText(/Archived rate book G4 what-if book/)).toBeVisible();
  await expect(page.locator('.ne-badge', { hasText: 'archived' })).toBeVisible();
  await expect(page.getByText(/^Run-rate book: Test rate book/)).toBeVisible();
  await page.getByRole('button', { name: 'Restore rate book G4 what-if book' }).click();
  await expect(page.getByText('Restored rate book G4 what-if book.')).toBeVisible();
  await page.getByLabel('Rate book', { exact: true }).selectOption('test-xts');
  await page.getByRole('button', { name: 'Set as portal default' }).click();
  await expect(page.getByText(/Set as the portal default on Commercial → Rate books/)).toBeVisible();
  await expect(page.locator('.ne-badge', { hasText: 'portal default' })).toBeVisible();
  await page.getByLabel('Rate book', { exact: true }).selectOption('zzz-g4-whatif');
  await page.getByRole('button', { name: 'Delete rate book G4 what-if book' }).click();
  await page.getByRole('button', { name: 'Confirm: delete rate book G4 what-if book from the portal' }).click();
  await expect(page.getByText('Deleted rate book G4 what-if book.')).toBeVisible();
  await expect(page.getByLabel('Rate book', { exact: true }).locator('option', { hasText: 'G4 what-if book' })).toHaveCount(0);
  // The test book is the portal default: refused until unset; then it prices the scenarios: refused, with the reason.
  await page.getByLabel('Rate book', { exact: true }).selectOption('test-xts');
  await page.getByRole('button', { name: /^Delete rate book Test rate book/ }).click();
  await page.getByRole('button', { name: /^Confirm: delete rate book Test rate book/ }).click();
  await expect(page.getByText(/is the portal default: unset it first/)).toBeVisible();
  await page.getByRole('button', { name: 'Unset portal default' }).click();
  await expect(page.getByText(/is no longer the portal default/)).toBeVisible();
  await page.getByRole('button', { name: /^Delete rate book Test rate book/ }).click();
  await page.getByRole('button', { name: /^Confirm: delete rate book Test rate book/ }).click();
  await expect(page.getByText(/prices \d+ scenarios?/)).toBeVisible();
});

test('the global filter lives in the URL and follows the nav', async ({ page }) => {
  await page.goto('/capacity?project=project-e00mocklab');
  await expect(page.getByLabel('Project', { exact: true })).toHaveValue('project-e00mocklab');
  await expect(page.getByRole('region', { name: 'Node groups' })).not.toContainText('nip-sandbox-inference');
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Workloads' }).click();
  await expect(page).toHaveURL(/\/workloads\?project=project-e00mocklab$/);
  await expect(page.getByText('No Kubernetes cluster in scope')).toBeVisible();
  // Clusters are discovered: the empty state says so, and no longer asks for app-config.
  await expect(page.getByText(/found and connected automatically once they exist/)).toBeVisible();
  await expect(page.getByText('nebiusEstate.kubernetes.clusters')).toHaveCount(0);
});

test('explorer graph opens one level expanded (every project on screen) and expands on demand (F1.44)', async ({ page }) => {
  await page.goto('/estate');
  await expect(page.getByText(/\d+ of \d+ nodes shown/)).toBeVisible();
  for (const name of ['nip-sandbox', 'nip-staging', 'nip-lab', 'legacy-research']) await expect(page.getByRole('button', { name: new RegExp(`^${name} Project`) })).toBeVisible();
  await expect(page.getByRole('button', { name: /× Project/ })).toHaveCount(0);
  const cluster = page.getByRole('button', { name: /Expand nip-sandbox-inference \(/ });
  await cluster.click();
  await expect(page.getByRole('button', { name: /nip-sandbox-inference-gpu Node group/ })).toBeVisible();
  await page.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(page.getByRole('button', { name: /nip-sandbox-inference-gpu Node group/ })).toHaveCount(0);
  // The type select keeps the proper nouns (G1.13); a search counts its matches apart from their parents (G1.14).
  const types = await page.getByLabel('Resource type').locator('option').allInnerTexts();
  expect(types.filter(t => t.startsWith('All '))).toEqual(expect.arrayContaining([expect.stringMatching(/^All Serverless AI \(\d+\)$/), expect.stringMatching(/^All Managed Kubernetes \(\d+\)$/)]));
  await page.goto('/estate?q=nip-sandbox-inference-gpu');
  await expect(page.getByText(/^\d+ matching · \d+ parents? shown/)).toBeVisible();
});

test('overview: inventory from the API, honest gaps, and a page-wide refresh', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'GPUs on running VMs' })).toContainText('gpu-h100-sxm');
  // One day recorded so far: no trend is drawn from a single point.
  await expect(page.getByText(/Not enough history yet/)).toBeVisible();
  // GPU telemetry from Nebius Monitoring, no cluster needed; the figure names its source.
  await expect(page.getByRole('region', { name: 'GPU utilisation · latest sample' })).toContainText('Nebius Monitoring');
  await page.getByRole('button', { name: 'Refresh all data on this page' }).click();
  await expect(page.getByText('Refreshed just now')).toBeVisible();
});

test('evidence: the recipe list shows R1–R16, with forms only for R1, R3 and R4', async ({ page }) => {
  await page.goto('/evidence');
  await page.getByRole('tab', { name: /Recipes/ }).click();
  await expect(page.getByText('R8 · Dataset and checkpoint data plane')).toBeVisible();
  await expect(page.getByText('R16 · Team queues on one GPU cluster (Kueue, topology-aware)')).toBeVisible();
  await expect(page.getByText('Form on the Provisioning page')).toHaveCount(3);
  const r10 = page.locator('.ne-card', { hasText: 'R10 · One GPU VM serving a model' });
  // Provisioning and runbooks fold under each recipe (W1F.N5).
  await r10.locator('summary', { hasText: 'Provisioning' }).click();
  await expect(r10).toContainText('Read-only live roots: sandbox, staging (no form)');
  await expect(r10).toContainText('sandbox 1 · staging 1 · prod 0');
  await expect(r10.getByRole('button', { name: 'Read runbooks/gpu-vm.md' })).toBeVisible();
  await expect(page.locator('.ne-card', { hasText: 'R15 · Rack-scale GB300 NVL72' })).toContainText('sandbox 0 · staging 0 · prod 0');
  const results = await axeBuilder(page).include('#main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map(v => v.id)).toEqual([]);
});

test.describe('390 px viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  for (const [path, title] of PAGES) {
    test(`${title}: no horizontal page overflow`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      // F1.51: every tab label is readable: no tab strip scrolls a tab out of sight ("Rul…", "Orpha…").
      const cutTabs = await page.locator('#main [role=tablist]').evaluateAll(lists =>
        lists.flatMap(l => {
          const box = l.getBoundingClientRect();
          return [...l.querySelectorAll('[role=tab]')].filter(t => { const r = t.getBoundingClientRect(); return r.right > box.right + 1 || r.left < box.left - 1 || t.scrollWidth > t.clientWidth + 1; }).map(t => t.textContent);
        }),
      );
      expect(cutTabs).toEqual([]);
      // F1.49: no badge is cut off ("Draft estimate — not a provider offer or ca…"): long ones wrap. On every tab, folded
      // sections open (W1F.F1.49b: Evidence → Recipes "Live run of th…" passed while only the default tab was checked).
      const tabs = await page.locator('#main [role=tab]').count();
      for (let t = 0; t <= tabs; t++) {
        if (t > 0) await page.locator('#main [role=tab]').nth(t - 1).click();
        await page.evaluate(() => document.querySelectorAll('#main details').forEach(d => (d.open = true)));
        const clipped = await page.locator('#main .ne-badge:visible').evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent));
        expect(clipped, `tab ${t}`).toEqual([]);
      }
      // F1.29: the banner heads the page, and the nav mark is still on screen after scrolling to the end.
      await expect(page.getByRole('note', { name: 'Test data' })).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(page.getByRole('navigation', { name: 'Primary' }).getByText('Test data', { exact: true })).toBeInViewport();
    });
  }
});

test('evidence: a document missing from the checkout is explained, not an error', async ({ page }) => {
  await page.goto('/evidence?doc=docs/evidence/1999-01-01-none.md');
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Not in this checkout')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await page.getByRole('tab', { name: /Recipes/ }).click();
  // R7 and R8 READMEs may not be committed yet: either Read works or the card says so.
  const r7 = page.locator('.ne-card', { hasText: 'R7 · Private network perimeter' });
  // Router transitions can commit after click returns. The card and its Read/
  // pending state render together, so wait for that view before inspecting count.
  await expect(r7).toBeVisible();
  const read = r7.getByRole('button', { name: 'Read terraform/stacks/network/README.md' });
  if (await read.count()) {
    await read.click();
    await expect(page.getByRole('dialog').locator('.ne-markdown')).toBeVisible();
  } else {
    await expect(r7.getByText('README pending')).toBeVisible();
  }
});

test('commercial: the rate book import is a keyboard-reachable button', async ({ page }) => {
  await page.goto('/commercial');
  await page.getByRole('tab', { name: 'Rate books' }).click();
  const importButton = page.getByRole('button', { name: 'Import rate book JSON' });
  await importButton.focus();
  await expect(importButton).toBeFocused();
});

test('integrations: a refused list call is reported per project, not hidden', async ({ page }) => {
  await page.goto('/integrations');
  // Per project, in plain words: no raw API error (F1.14).
  await expect(page.getByText('legacy-research refused Networks, Subnets and Object Storage buckets.').first()).toBeVisible();
  await expect(page.getByText('permission denied', { exact: false }).first()).toBeVisible();
});

test('projects carry API names and regions; coverage collapses identical projects without key warnings', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', m => {
    if (m.type() === 'error' || m.type() === 'warning') warnings.push(m.text());
  });
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Projects · regions' })).toContainText('4 projects · 3 regions'); // was "4 · 3": the tile names what it counts (readability review)
  // Coverage is a folded reference section (W1F.N5): its link opens it.
  await page.goto('/integrations#coverage');
  const coverage = page.getByRole('region', { name: 'Coverage' });
  await expect(coverage).toContainText('3 projects');
  await expect(coverage).toContainText('legacy-research');
  await expect(page.getByText(/4 projects: nip-sandbox, nip-staging, nip-lab \+1 more/).first()).toBeVisible();
  expect(warnings.filter(w => /same key/.test(w))).toEqual([]);
});

test('Nebius-created default networks and subnets are not flagged as unattributed', async ({ page }) => {
  await page.goto('/estate?mode=table&view=unattributed');
  await expect(page.getByText(/Resources \(\d+\)/)).toBeVisible();
  await expect(page.locator('tbody')).not.toContainText('default-network');
  await page.goto('/estate?mode=table');
  await page.getByLabel('Search').fill('default-subnet-e00mocksbx');
  const row = page.locator('tbody tr').first();
  await expect(row).toContainText('default-subnet-e00mocksbx');
  await expect(row.locator('.ne-chip')).toHaveText('default');
  await expect(row).toContainText('nip-sandbox · eu-north1'); // project name and the project's region
});

test.describe('full capabilities against the documented API shapes', () => {
  test('integrations: every API call with its state, the role to grant, drift and per-project outcomes', async ({ page }) => {
    await page.goto('/integrations#capabilities');
    await expect(page.getByText('This identity, at the last sync')).toBeVisible();
    await expect(page.getByText(/access permit on the project/).first()).toBeVisible(); // permission-denied with what to grant
    await expect(page.getByText(/undocumented value "CONNECTION_STATE_RELAYED"/).first()).toBeAttached(); // schema drift, reported not hidden
    await expect(page.getByText(/Spot pricing policies/).first()).toBeVisible(); // rejected (400): nothing to grant
    await expect(page.getByText(/DNS zones/).first()).toBeVisible(); // not found for one project
  });

  test('capacity: tenant quotas lead, limit 0 is blocked with where to ask, project allocations beneath; GPU telemetry per GPU', async ({ page }) => {
    await page.goto('/capacity');
    await expect(page.getByText(/Compute GPU and preemptible VM quotas by region \(tenant\)/)).toBeVisible();
    // Project placeholders use the tenant quota: never read as limit 0.
    await page.getByText(/^Project allocations \(\d+\)$/).click(); // folded under its title (F1.13)
    await expect(page.getByRole('table', { name: 'Project quota allocations' })).toContainText('uses tenant quota');
    await expect(page.getByRole('link', { name: /^\d+ planned roots? blocked$/ })).toBeVisible();
    await expect(page.getByText(/Administration → Limits → Quotas/).first()).toBeAttached();
    await expect(page.getByRole('table', { name: 'Project quota allocations' })).toBeVisible();
    const groups = page.locator('.ne-card', { hasText: 'nip-sandbox-inference-gpu' }).first();
    await expect(groups).toContainText('63.5 %'); // per-node-group GPU utilisation from Nebius Monitoring
    await page.getByRole('navigation', { name: 'On this page' }).getByRole('link', { name: 'GPU telemetry' }).click();
    const telemetry = page.locator('.ne-card', { hasText: 'GPU telemetry per GPU' });
    await expect(telemetry).toContainText('nip-sandbox-inference-gpu-0');
    await expect(telemetry).toContainText('Nebius Monitoring');
  });

  test('allowance check: project caps against the tenant quota on Capacity, and the Overview row for caps that cut', async ({ page }) => {
    await page.goto('/');
    const attention = page.getByRole('region', { name: 'Needs attention' });
    const row = attention.locator('li', { has: page.getByRole('link', { name: 'Project quota caps below the tenant limit' }) });
    await expect(row.locator('.ne-badge').first()).toHaveText('2'); // a cap below and a cap of 0; the cap above has no effect
    await expect(row).toContainText('vpc.allocation.count');
    await row.getByRole('link', { name: 'Project quota caps below the tenant limit' }).click();
    await expect(page).toHaveURL(/\/capacity(\?[^#]*)?#allowance-check$/);
    const check = page.getByRole('region', { name: 'Allowance check' });
    await expect(check).toBeInViewport();
    const caps = check.getByRole('list', { name: 'Project caps that differ from the tenant limit' }).locator('li');
    await expect(caps).toHaveCount(3);
    await expect(caps.nth(0)).toContainText('nip-staging · eu-north1: project cap 0, tenant limit 5. Blocks this project');
    await expect(caps.nth(1)).toContainText('nip-sandbox · eu-north1: project cap 13, tenant limit 1,000. Caps this project below the tenant limit. Intended?');
    await expect(caps.nth(2)).toContainText('project cap 22, tenant limit 12. No effect');
    await expect(await axeBuilder(page).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).include('#allowance-check').analyze().then(r => r.violations)).toEqual([]);
  });

  test('overview: run-rate at the live contract price names the calculator and says it equals list', async ({ page }) => {
    await page.goto('/');
    // One label whatever the basis; the basis is the badge (priceBasisText).
    const tile = page.getByRole('region', { name: 'Run-rate (live)' });
    await expect(tile).toContainText(/XTS/);
    await expect(tile).toContainText(/calculator/i);
    await expect(tile).toContainText('contract price (= list)');
  });

  test('quota pre-checks: a planned resource with a 0 limit is flagged on Overview and in the provisioning preview', async ({ page }) => {
    await page.goto('/');
    const attention = page.getByRole('region', { name: 'Needs attention' });
    await expect(attention).toContainText('Planned resources blocked by quota');
    await expect(attention).toContainText('sandbox/inference');
    await page.goto('/provisioning');
    await page.locator('#pv-ref').fill(`e2e-quota-${Date.now()}`);
    await page.locator('#pv-gpus').fill('1');
    const check = page.locator('.ne-card', { hasText: 'Quota needs vs limits · eu-north1' });
    await expect(check).toContainText('would stop this plan');
    const table = check.getByRole('table', { name: 'Quota needs vs limits' });
    await expect(table).toContainText('compute.instance.non-gpu.vcpu');
    await expect(table).toContainText('blocked (limit 0)');
    // The live check is an error in Validate that disables Prepare (W1-P3), as make preflight fails it.
    await expect(page.getByText(/compute\.instance\.non-gpu\.vcpu\): limit 0, needs/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Prepare reviewed change' })).toBeDisabled();
  });

  test('provisioning: the preview is priced by the live calculator, labelled as contract price (= list)', async ({ page }) => {
    await page.goto('/provisioning');
    await page.locator('#pv-ref').fill(`e2e-live-${Date.now()}`);
    await page.locator('#pv-gpus').fill('1');
    await expect(page.getByText(/Nebius billing calculator \(contract price\)/).first()).toBeVisible();
    await expect(page.getByText('contract price (= list)').first()).toBeVisible();
    // The live price panel says contract price; only the estimate card may name the built-in list-price source (no rate book).
    await expect(page.locator('#pv-live-price').getByText(/Nebius list price/)).toHaveCount(0);
  });

  test('capacity: availability matrix by region, platform and capacity type, with the best region and stale advice', async ({ page }) => {
    await page.goto('/capacity#availability');
    const card = page.locator('.ne-card', { hasText: 'Capacity availability' });
    const matrix = card.getByRole('table', { name: 'Capacity availability matrix' });
    await expect(matrix).toContainText('available /');
    await expect(matrix).toContainText('limit reached');
    await expect(matrix).toContainText('stale');
    await expect(card.getByRole('list', { name: 'Best region per platform' })).toContainText(/Best region for gpu-h100-sxm · \S+: \S+/);
    await card.getByLabel('Advice capacity type').selectOption('reserved');
    await expect(card.getByRole('columnheader', { name: /On-demand/ })).toHaveCount(0);
  });

  test('overview: only stages in use are offered; a filter that matches no project gives one banner', async ({ page }) => {
    await page.goto('/?stage=prod');
    await expect(page.getByLabel('Stage', { exact: true }).locator('option')).toHaveText(['All stages', 'sandbox', 'staging']);
    await expect(page).not.toHaveURL(/stage=prod/);
    await page.goto('/?project=project-e00mocklab&stage=staging');
    await expect(page.getByText('No project in scope has stage=staging and project=nip-lab.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'GPUs on running VMs' })).toHaveCount(0);
  });

  test('provisioning: a training request is checked against the capacity advisor', async ({ page }) => {
    await page.goto('/provisioning');
    await page.getByRole('radio', { name: /training/i }).first().click();
    await page.locator('#pv-ref').fill(`e2e-advice-${Date.now()}`);
    // The form starts from the committed sizing, which plans 0 GPU nodes (W1-P1): ask for two.
    await page.locator('#pv-gpus').fill('2');
    const card = page.locator('.ne-card', { hasText: 'Availability (capacity advisor)' });
    await expect(card).toContainText(/available vs \d+ requested/);
  });

  test('integrations: the Kubernetes matrix row joins discovered clusters', async ({ page }) => {
    await page.goto('/integrations#matrix');
    const row = page.getByRole('row', { name: /Kubernetes workloads \(MK8s clusters, discovered\)/ });
    await expect(row).not.toContainText('no call at the last sync');
    await expect(row).toContainText('live-verified');
  });

  test('integrations: tenant projects outside NEBIUS_PROJECT_IDS are a hint, not part of the scope', async ({ page }) => {
    await page.goto('/integrations');
    const hint = page.getByRole('note').filter({ hasText: 'not in NEBIUS_PROJECT_IDS' });
    await expect(hint).toContainText('research-unlisted');
    await expect(hint).toContainText('project-e00mockdiscovered');
    await page.goto('/estate?mode=table');
    await expect(page.locator('tbody')).not.toContainText('research-unlisted');
  });

  test('billing export pull: the FOCUS file in the bucket is imported by the system and reported per call', async ({ page }) => {
    await page.goto('/costs');
    await expect(page.getByText('focus/focus-export-2026-10-06.csv.gz').first()).toBeVisible();
    await expect(page.getByText('system:billing-export').first()).toBeVisible();
    await page.goto('/integrations');
    await expect(page.getByText(/Billing export pull/).first()).toBeVisible();
  });

  test('integrations: an unset external Prometheus is "not needed" (complete), not counted as a problem', async ({ page }) => {
    await page.goto('/integrations'); // the Overview has one line of connector health (F1.15); the table is here
    const table = page.getByRole('table', { name: /connector/i }).first();
    const row = table.locator('tr', { hasText: 'External Prometheus' });
    await expect(row).toContainText('not needed');
    await expect(row).toContainText('GPU telemetry already comes from Nebius Monitoring (official endpoint, all listed projects)');
    await expect(row.locator('[style*="--ne-danger"]')).toHaveCount(0);
  });

  test('orphans: managed and provisioning node disks are not flagged; node VMs are attributed via their cluster', async ({ page }) => {
    await page.goto('/estate?mode=table&view=orphans');
    await expect(page.getByText(/scripts\/leftovers\.sh/)).toBeVisible();
    const body = page.locator('tbody');
    await expect(body).toContainText('pvc-9a77d2c4-old-model-cache'); // a long-standing loose disk stays a candidate
    await expect(body).not.toContainText('mk8snodegroup-e00mockinfsys-pmvxp-kqlq2');
    await expect(body).not.toContainText('mk8snodegroup-e00mockinfgpu-x7k2q-provisioning');
    await page.goto('/estate?mode=table&view=unattributed');
    await expect(page.getByText(/Resources \(\d+\)/)).toBeVisible();
    await expect(page.locator('tbody')).not.toContainText('mk8snodegroup-e00mockinfsys-pmvxp-kqlq2');
    await page.goto('/estate?mode=table');
    await page.getByLabel('Search').fill('computeinstance-e00mockngnode0');
    const row = page.locator('tbody tr').first();
    await expect(row).toContainText(/attributed via (node group|cluster) nip-sandbox-inference/);
    await expect(row).toContainText('sandbox / inference');
  });

  test('MK8s clusters are discovered and connected by themselves; a provisioning one waits', async ({ page }) => {
    // A healthy connector's card is folded with the others (W1F.N5); its section's link opens it.
    await page.goto('/integrations#connectors-healthy');
    // The connector's own card (its heading): the summary table above the cards names every connector too.
    const inf = page.locator('section.ne-card').filter({ has: page.getByRole('heading', { name: 'Kubernetes — nip-sandbox-inference (MK8s, discovered)' }) });
    await expect(inf).toContainText('cluster nip-sandbox-inference · eu-north1');
    await expect(inf.getByText('ok', { exact: true }).first()).toBeVisible();
    const sop = page.locator('section.ne-card').filter({ has: page.getByRole('heading', { name: 'Kubernetes — nip-sandbox-soperator (MK8s, discovered)' }) });
    await expect(sop).toContainText('PROVISIONING; it is connected automatically once RUNNING');
    await expect(page.getByText(/Waiting for the observability agent/).first()).toBeAttached();
    await page.goto('/workloads');
    await expect(page.getByText('vllm-qwen').first()).toBeVisible();
  });

  test('estate: new resource kinds with their relations', async ({ page }) => {
    await page.goto('/estate?mode=table');
    await page.getByLabel('Search').fill('nip-sandbox-vllm-endpoint');
    const row = page.locator('tbody tr').first();
    await expect(row).toContainText('Serverless endpoint');
    await row.click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('nip-sandbox-inference-gpu-0').first()).toBeVisible(); // backed-by
    await page.keyboard.press('Escape');
    await page.getByLabel('Search').fill('nip-staging-db-password');
    await expect(page.locator('tbody tr').first()).toContainText('Secret (metadata only)');
    await expect(page.locator('body')).not.toContainText('never-copied-stub-value');
  });

  test('estate: an MLflow cluster is unattributed and says its service keeps no labels', async ({ page }) => {
    await page.goto('/estate?mode=table&view=unattributed');
    await page.getByLabel('Search').fill('nip-lab-tracking');
    const row = page.locator('tbody tr').first();
    await expect(row).toContainText('unattributed');
    await expect(row).toContainText('the service keeps no labels');
    await row.click();
    await expect(page.getByRole('dialog')).toContainText('Managed MLflow keeps no labels');
  });
});

test.describe('layout at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('integrations: the connector table fits its card, with names for every connector scope', async ({ page }) => {
    await page.goto('/integrations'); // the Overview has one line of connector health (F1.15); the table is here
    const table = page.getByRole('region', { name: 'Connector health' });
    await expect(table).toBeVisible();
    const clipped = await table.evaluate(el => el.scrollWidth - el.clientWidth);
    expect(clipped).toBeLessThanOrEqual(1);
    await expect(table).toContainText(/calls? refused.* — in its card below/); // no link to its own page (F1.14)
    await expect(table.locator('tr', { hasText: 'GPU telemetry (Nebius Monitoring)' })).toContainText('nip-sandbox');
  });

  test('capacity: a platform offered live but not in regions.yaml links to the explanation', async ({ page }) => {
    await page.goto('/capacity#platforms');
    const link = page.getByRole('link', { name: /not in regions\.yaml: what this means/ }).first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.locator('#platform-check-legend')).toContainText('the stacks cannot select it');
  });
});

test.describe('walkthrough fixes (2026-10-11)', () => {
  test('overview tiles link to their Capacity sections, and "blocked by quota" counts the same roots on both pages', async ({ page }) => {
    await page.goto('/');
    const attention = page.getByRole('region', { name: 'Needs attention' });
    const planned = attention.locator('li', { has: page.getByRole('link', { name: 'Planned resources blocked by quota' }) });
    const count = (await planned.locator('.ne-badge').first().innerText()).trim();
    expect(Number(count)).toBeGreaterThan(0);
    await planned.getByRole('link', { name: 'Planned resources blocked by quota' }).click();
    await expect(page).toHaveURL(/\/capacity(\?[^#]*)?#planned-quota$/);
    await expect(page.locator('#planned-quota')).toBeInViewport();
    await expect(page.getByRole('link', { name: new RegExp(`^${count} planned roots? blocked$`) })).toBeVisible();
    await expect(page.locator('#planned-quota')).toContainText(`${count} planned root`);
    await page.goto('/');
    await page.getByRole('link', { name: 'Scheduled maintenance' }).click();
    await expect(page).toHaveURL(/#maintenance$/);
    await expect(page.locator('#maintenance')).toContainText('Scheduled maintenance');
  });

  test('a set-up hint is one Fix link to the page where the fix happens (W1-P24; was the guide in the document viewer)', async ({ page }) => {
    await page.goto('/?project=project-e00mocklab');
    const hint = page.locator('.ne-ov-setup a').first();
    await expect(hint).toHaveText(/^Fix: .+ →$/);
    await expect(hint).toHaveAttribute('href', /^\/(integrations|commercial|costs|alerts|evidence)\b/);
  });

  test('explorer: "Expand all" opens folded groups too', async ({ page }) => {
    await page.goto('/estate');
    await page.getByRole('button', { name: 'Expand all' }).click();
    await expect(page.getByText(/folded group/)).toHaveCount(0);
    const shown = await page.getByText(/\d+ of \d+ nodes shown/).innerText();
    const [a, b] = shown.match(/\d+/g)!.map(Number);
    expect(a).toBe(b);
  });

  test('explorer: node VMs take the TTL of their node group, so the TTL-expired view lists them', async ({ page }) => {
    await page.goto('/estate?mode=table&view=ttl');
    await expect(page.locator('tbody')).toContainText('mk8snodegroup-e00mockinfsys-pmvxp-kqlq2');
    await page.locator('tbody tr', { hasText: 'computeinstance-e00mockngnode0' }).first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('ticket-481'); // run, inherited
    await expect(drawer).toContainText(/TTL expired/);
  });

  test('explorer: view, type and search live in the URL; Back undoes; an unknown view says so', async ({ page }) => {
    await page.goto('/estate?mode=table');
    await page.getByRole('tab', { name: /Orphan candidates/ }).click();
    await expect(page).toHaveURL(/view=orphans/);
    await page.goBack();
    await expect(page).not.toHaveURL(/view=orphans/);
    await page.getByLabel('Search').fill('nip-sandbox');
    await expect(page).toHaveURL(/q=nip-sandbox/);
    await page.goto('/estate?view=bogus');
    await expect(page.getByText(/Unknown view "bogus"/)).toBeVisible();
  });

  test('global filter: a value from the link that matches nothing is named, not dropped silently; Back undoes a filter', async ({ page }) => {
    await page.goto('/?region=xx-bogus1');
    await expect(page.getByText('Filter from the link not applied')).toBeVisible();
    await expect(page.getByText(/region "xx-bogus1"/)).toBeVisible();
    await page.goto('/capacity');
    await page.getByLabel('Region', { exact: true }).first().selectOption('eu-north1');
    await expect(page).toHaveURL(/region=eu-north1/);
    await page.goBack();
    await expect(page).not.toHaveURL(/region=eu-north1/);
  });

  test('calculator: whole numbers in order, a clamped value is named, prices never belong to another footprint, and the vCPU limit 0 is flagged', async ({ page }) => {
    await page.goto('/capacity#calculator');
    const calc = page.locator('#calculator');
    await calc.getByLabel('expected GPU nodes').fill('1.5');
    await expect(calc.getByText('Enter a whole number of nodes (no decimals).')).toBeVisible();
    await calc.getByLabel('expected GPU nodes').fill('1');
    await calc.getByLabel('min GPU nodes').fill('5');
    await expect(calc.getByText('Minimum (5) is above expected (1).')).toBeVisible();
    await calc.getByLabel('min GPU nodes').fill('0');
    await calc.getByLabel('max GPU nodes').fill('100000');
    await expect(calc.getByText(/Clamped to 64/)).toBeVisible();
    await expect(calc).not.toContainText(/Invalid input|expected int/);
    const table = calc.getByRole('table', { name: 'Footprint quota needs' });
    // #43: the line says what each figure is, in its unit.
    await expect(table).toContainText(/compute\.instance\.non-gpu\.vcpu needs \d+ vCPU, limit 0 in eu-north1/);
    await expect(table.locator('tbody tr').first()).not.toContainText('pricing…', { timeout: 30_000 });
    await calc.getByLabel('Stack').selectOption('soperator');
    // The previous stack's prices are not shown for the new one.
    await expect(table.locator('tbody tr').first()).toContainText('pricing…');
  });

  test('provisioning: budget, owner and reference are checked on their fields; arrow keys move the recipe', async ({ page }) => {
    await page.goto('/provisioning');
    await page.locator('#pv-ref').fill('bad ref!');
    await expect(page.getByText(/Enter a ticket, date or run id/)).toBeVisible();
    await page.locator('#pv-ref').fill(`e2e-fields-${Date.now()}`);
    await page.locator('#pv-budget').fill('12.3.4');
    await expect(page.getByText(/Enter an amount such as 500 or 499\.50/)).toBeVisible();
    await page.locator('#pv-owner').fill('');
    await expect(page.getByText(/Enter the owning team/)).toBeVisible();
    await expect(page.locator('#main')).not.toContainText('budget.amount');
    await expect(page.locator('#main')).not.toContainText('non-negative decimal');
    await page.locator('#pv-budget').fill('500');
    await page.locator('#pv-owner').fill('platform');
    await expect(page.getByText(/Fix the highlighted field/)).toHaveCount(0);
    await expect(page.getByText(/^7 · Approval and deployment evidence/)).toBeVisible();
    const radio = page.getByRole('radio', { checked: true });
    await radio.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: /Training capacity request/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: /Training capacity request/ })).toBeFocused();
  });

  test('evidence: an in-document anchor keeps the document open and scrolls to its heading; focus returns to Read', async ({ page }) => {
    await page.goto('/evidence?doc=docs%2Fevidence%2F2026-10-11-portal-live-read-only.md');
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('link', { name: 'Method' }).first().click();
    await expect(page).toHaveURL(/doc=docs%2Fevidence%2F2026-10-11-portal-live-read-only\.md#method$/);
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('heading', { name: 'Method' })).toBeInViewport();
    await page.goto('/evidence?tab=runbooks');
    await expect(page.getByRole('tab', { name: /Runbooks/ })).toHaveAttribute('aria-selected', 'true');
    const read = page.getByRole('button', { name: 'Read' }).first();
    await read.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(read).toBeFocused();
  });

  test('evidence: the live-run section says which roots were applied, from the evidence files', async ({ page }) => {
    await page.goto('/evidence');
    await expect(page.getByText(/Terraform roots applied so far, per the evidence files: .*sandbox\/inference/)).toBeVisible();
    await expect(page.getByText(/No Terraform root of this repository has been applied yet/)).toHaveCount(0);
  });

  test('integrations: on-demand pricing says so, never "stale after 0 min"', async ({ page }) => {
    await page.goto('/integrations#connectors-healthy');
    await expect(page.getByText(/stale after 0 min/)).toHaveCount(0);
    // The connector's own card (its heading), not the summary table above the cards.
    await expect(page.locator('section.ne-card').filter({ has: page.getByRole('heading', { name: /^Live list prices/ }) })).toContainText(/on demand/);
  });

  test('workloads, capacity, evidence, integrations: no duplicate-key or Link warnings', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', m => {
      if (m.type() === 'error' || m.type() === 'warning') warnings.push(m.text());
    });
    await page.goto('/workloads');
    await expect(page.getByText('vllm-qwen').first()).toBeVisible();
    await page.goto('/capacity#availability');
    await expect(page.getByRole('list', { name: 'Best region per platform' })).toBeVisible();
    await page.goto('/evidence');
    await page.goto('/solutions');
    await expect(page.getByText('S9 · Notebooks for a data-science team')).toBeVisible();
    await page.goto('/integrations#capabilities');
    await expect(page.getByText('This identity, at the last sync')).toBeVisible();
    expect(warnings.filter(w => /same key|Link.*children/i.test(w))).toEqual([]);
  });
});

