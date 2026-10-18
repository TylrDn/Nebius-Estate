import { expect, Page, Route, test } from '@playwright/test';
import { axeBuilder } from './axe';

/**
 * Inventory, Fleet, Workloads and AI services, Wave 1 group G4 (backlog 2026-10-13): a failed Job reads red (#16),
 * requests and limits summed in Kubernetes units (#17), namespaces and node state with the Soperator card only where a
 * Soperator cluster exists (#18), registries and MLflow on AI services (#20), the Fleet drawer and a deleted node
 * group (#34), as-of times on empty and status-only states (#53), the tile source line (#60), service cards at their
 * own height (#61) and the roll-up header (#62). Against the e2e stub: nip-staging-training runs a Job that failed
 * (BackoffLimitExceeded) and has a NotReady node; nip-sandbox-inference has a cordoned node; nip-sandbox-soperator
 * (lab) is provisioning. Where the stub has no such case, the reply is changed in the test (route).
 */

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const THEMES = ['nebius-dark', 'nebius-light'];

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

for (const theme of THEMES) {
  for (const width of [1440, 390]) {
    test(`G4: Workloads shows a failed Job in red, summed requests, namespaces and node state; axe, no sideways scroll (${theme}, ${width} px)`, async ({ page }) => {
      await useTheme(page, theme);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/workloads');
      await expect(page.getByRole('heading', { level: 1, name: 'Workloads' })).toBeVisible({ timeout: 90_000 });
      const job = page.getByRole('row').filter({ hasText: 'data-prep' });
      // #16: the Job's Failed condition, not "not ready (0/1)".
      await expect(job).toContainText('failed (BackoffLimitExceeded)');
      await expect(job).toContainText('3 failed pods');
      await expect(job).not.toContainText('not ready');
      // #17: 250m + 100m, 512Mi + 128Mi; limits 1Gi + 256Mi.
      await expect(job).toContainText('cpu=350m');
      await expect(job).toContainText('memory=640Mi');
      await expect(job).toContainText('limits: memory=1280Mi');
      await expect(job).not.toContainText('+');
      // #18: node state and namespaces per cluster.
      const trn = page.getByRole('region', { name: 'Cluster nip-staging-training' });
      await expect(trn.getByTestId('node-summary')).toHaveText('2 nodes · 1 NotReady');
      await expect(trn.getByRole('list', { name: 'Namespaces in nip-staging-training' }).getByRole('listitem')).toHaveText(['default', 'kube-system', 'training']);
      await expect(page.getByRole('region', { name: 'Cluster nip-sandbox-inference' }).getByTestId('node-summary')).toHaveText('3 nodes · 1 cordoned');
      const nodes = page.getByRole('table', { name: 'Nodes' });
      await expect(nodes.getByRole('row').filter({ hasText: 'nip-staging-training-system-1' })).toContainText('NotReady');
      await expect(nodes.getByRole('row').filter({ hasText: 'nip-sandbox-inference-system-1' })).toContainText('cordoned');
      await expect(nodes.getByRole('row').filter({ hasText: 'nip-sandbox-inference-gpu-0' })).toContainText('Ready');
      // A Soperator cluster (provisioning, lab) is in scope: its card stays.
      await expect(page.getByRole('heading', { name: 'Soperator (Slurm on Kubernetes)' })).toBeVisible();
      await expect(page.getByText(/Soperator cluster in scope: nip-sandbox-soperator\./)).toBeVisible();
      await axe(page);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }
}

test('G4 #18: no Soperator cluster in scope, no Soperator card', async ({ page }) => {
  await page.goto('/workloads?project=project-e00mocksandbox');
  await expect(page.getByRole('region', { name: 'Cluster nip-sandbox-inference' })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Soperator (Slurm on Kubernetes)' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Recent warning events' })).toBeVisible();
});

test('G4 #53, #18: "No Kubernetes cluster in scope" says as of when, and a provisioning Soperator cluster keeps its card', async ({ page }) => {
  await page.goto('/workloads?project=project-e00mocklab');
  await expect(page.getByText('No Kubernetes cluster in scope')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/^Inventory as of \d{4}-\d\d-\d\d \d\d:\d\d UTC · /)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Soperator (Slurm on Kubernetes)' })).toBeVisible();
});

test('G4 #53: Fleet service cards with nothing in scope say as of when', async ({ page }) => {
  await page.goto('/fleet?project=project-e00mocklegacy');
  await expect(page.getByRole('heading', { level: 1, name: 'Fleet' })).toBeVisible({ timeout: 90_000 });
  const card = (title: string) => page.locator('section.ne-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  for (const title of ['Object Storage', 'Managed PostgreSQL', 'Managed MLflow']) {
    await expect(card(title)).toContainText('none in scope');
    await expect(card(title).locator('.ne-card-foot')).toContainText(/· (just now|\d+ (s|min|h) ago)/);
  }
});

test('G4 #53: Capacity\'s empty node-group table says when the node groups were read', async ({ page }) => {
  // Every stub project with a cluster has node groups: the reply's list is emptied, its read time kept.
  await page.route('**/api/nebius-estate/capacity*', async (route: Route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.nodeGroups = [];
    await route.fulfill({ response: res, json: body });
  });
  await page.goto('/capacity');
  const table = page.locator('section.ne-card').filter({ has: page.getByRole('heading', { level: 2, name: 'Node groups', exact: true }) });
  await expect(table.getByText('No node groups in scope')).toBeVisible({ timeout: 90_000 });
  await expect(table.getByText(/^Node groups read \d{4}-\d\d-\d\d \d\d:\d\d UTC · /)).toBeVisible();
});

test('G4 #34: the Fleet drawer of a GPU whose node group was deleted names it instead of linking to it', async ({ page }) => {
  // Stub: nip-legacy-teardown-gpu-0's series carries mk8snodegroup-e00mockgoneold, which the node-group list no longer has.
  await page.goto('/fleet');
  await expect(page.getByRole('heading', { level: 1, name: 'Fleet' })).toBeVisible({ timeout: 90_000 });
  await page.locator('.ne-heat-label', { hasText: 'nip-legacy-teardown-gpu-0' }).first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Node group deleted; not in the Explorer.');
  await expect(drawer.getByRole('link', { name: 'Node group in the Explorer' })).toHaveCount(0);
  // The VM left the inventory too: nothing to open for it either.
  await expect(drawer).toContainText('The VM is not in the current inventory, so the Explorer has nothing to open.');
});

test('G4 #34: a node group still in the inventory keeps its Explorer link', async ({ page }) => {
  await page.goto('/fleet');
  await page.locator('.ne-heat-label', { hasText: 'nip-sandbox-inference-gpu-0' }).first().click();
  await expect(page.getByRole('dialog').getByRole('link', { name: 'Node group in the Explorer' })).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`G4 #60, #61, #62: Fleet tile ages never break, service cards keep their own height, the roll-up header is balanced (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/fleet');
    await expect(page.getByRole('heading', { level: 1, name: 'Fleet' })).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('.ne-tile-age').first()).toBeVisible();
    // #60: the age is one unit ("3 h ago" on one line); a wrapped age starts at the line's left edge, so its dot,
    // drawn 1em before it, falls in the clipped margin and no line starts with "·".
    const ages = await page.locator('.ne-tile-source-parts').evaluateAll(lines =>
      lines.flatMap(line => {
        const age = line.querySelector('.ne-tile-age');
        const first = line.querySelector(':scope > span > span');
        if (!age || !first) return [];
        const r = age.getBoundingClientRect();
        const lh = parseFloat(getComputedStyle(age).lineHeight) || 16;
        const wrapped = r.top > first.getBoundingClientRect().top + 1;
        const em = parseFloat(getComputedStyle(age).fontSize);
        // The age's text starts 1em into its box (the dot's slot); at a line start the box begins 1em left of the line.
        return [{ text: line.textContent, oneLine: Math.round(r.height / lh) === 1, startsLine: !wrapped || Math.abs(r.left + em - line.getBoundingClientRect().left) < 2 }];
      }),
    );
    expect(ages.length).toBeGreaterThan(0);
    for (const a of ages) expect(a).toMatchObject({ oneLine: true, startsLine: true });
    // #61: a card ends where its content ends: no empty space below its last part (a stretched card had 300+ px).
    const slack = await page.locator('.ne-svc-grid > section').evaluateAll(cards => cards.map(c => c.getBoundingClientRect().bottom - c.lastElementChild!.getBoundingClientRect().bottom));
    expect(slack.length).toBe(4);
    for (const px of slack) expect(px).toBeLessThan(3);
    // #62: the utilisation header wraps on balanced lines: no line is a lone short word.
    const header = page.getByRole('table', { name: 'Node groups and standalone VMs' }).getByRole('columnheader', { name: 'GPU utilisation · mean, last 24 h' });
    await expect(header).toBeVisible();
    const lines = await header.evaluate(th => {
      const range = document.createRange();
      const walker = document.createTreeWalker(th, NodeFilter.SHOW_TEXT);
      const words: { word: string; top: number }[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent ?? '';
        let i = 0;
        for (const w of text.split(/(\s+)/)) {
          if (w.trim()) {
            range.setStart(n, i);
            range.setEnd(n, i + w.length);
            words.push({ word: w, top: Math.round(range.getBoundingClientRect().top) });
          }
          i += w.length;
        }
      }
      const byLine = new Map<number, string[]>();
      for (const w of words) byLine.set(w.top, [...(byLine.get(w.top) ?? []), w.word]);
      return [...byLine.values()].map(ws => ws.join(' '));
    });
    expect(lines.join(' ')).toBe('GPU utilisation · mean, last 24 h');
    for (const l of lines) expect(l.length).toBeGreaterThan(2);
  });
}

for (const theme of THEMES) {
  for (const width of [1440, 390]) {
    test(`G4 #20: AI services lists the container registry and the MLflow cluster with Explorer links; axe, no sideways scroll (${theme}, ${width} px)`, async ({ page }) => {
      await useTheme(page, theme);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/ai-services');
      const table = page.getByRole('table', { name: 'Container registries and MLflow clusters' });
      await expect(table).toBeVisible({ timeout: 90_000 });
      await expect(table.getByRole('row').filter({ hasText: 'nip-sandbox-images' })).toContainText('Container registry');
      await expect(table.getByRole('row').filter({ hasText: 'nip-sandbox-images' })).toContainText('12 images');
      await expect(table.getByRole('row').filter({ hasText: 'nip-lab-tracking' })).toContainText('Managed MLflow');
      await expect(table.getByRole('link', { name: 'nip-lab-tracking' })).toHaveAttribute('href', `/estate?uid=${encodeURIComponent('nebius:mlflowcluster-e00mocklab')}`);
      await expect(page.locator('section.ne-card').filter({ has: page.getByRole('heading', { name: 'Container registries and MLflow' }) }).locator('.ne-card-foot')).toContainText(/Inventory as of \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
      await expect(page.locator('body')).not.toContainText('never-copied-stub-value');
      await axe(page);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }
}

test('G4 #20: opening the MLflow cluster from AI services lands on its Explorer drawer', async ({ page }) => {
  await page.goto('/ai-services');
  await page.getByRole('link', { name: 'nip-lab-tracking' }).click();
  await expect(page).toHaveURL(/\/estate\?uid=/);
  await expect(page.getByRole('dialog')).toContainText('nip-lab-tracking');
});

test('G4 #15: a CSI disk sized in bytes is priced; a disk with no size is named unpriced in the live run-rate, never dropped', async ({ page }) => {
  // Stub: pvc-3f1c0e5a-tsdb has spec.sizeBytes only; pvc-5d0b7e21-scratch has no size at all.
  await page.goto('/');
  const live = page.getByRole('region', { name: 'Run-rate (live)' });
  await expect(live.getByTestId('live-runrate-count')).toHaveText(/^\d+ resources? priced, [1-9]\d* without a price$/, { timeout: 90_000 });
  await live.locator('summary', { hasText: 'without a price (not in the total)' }).click();
  await expect(live).toContainText('Disk pvc-5d0b7e21-scratch: the API answer has no size to price');
  await expect(live).not.toContainText('pvc-3f1c0e5a-tsdb');
});
