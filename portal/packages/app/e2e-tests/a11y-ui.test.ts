import { expect, Page, test } from '@playwright/test';
import { axeBuilder } from './axe';

/**
 * Accessibility and page UI (walkthrough 2026-10-11): every page at 390 px in both themes with no axe
 * violations on the whole page (navigation included, WCAG 2.2 AA), and with the root text size at 200 %
 * without sideways scrolling; keyboard focus on "Sync now" and the Provisioning field errors; and the page fixes
 * that depend on data the stub does not hold (a crash-looping workload), checked against a replayed response.
 */

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

async function axeAll(page: Page) {
  const r = await axeBuilder(page).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(', ')}`);
}

const overflow = async (page: Page) => {
  const result = await page.evaluate(() => ({
    pixels: document.documentElement.scrollWidth - window.innerWidth,
    elements: [...document.querySelectorAll('body *')].map(element => ({
      tag: element.tagName, class: element.className, right: element.getBoundingClientRect().right,
      width: element.getBoundingClientRect().width,
    })).filter(element => element.right > window.innerWidth && element.width > 0).slice(0, 35),
  }));
  return result;
};

test.describe('390 px, both themes', () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${scheme} theme`, () => {
      test.use({ colorScheme: scheme });
      for (const [path, title] of PAGES) {
        test(`${path}: no axe violations on the whole page; text at 200 % does not scroll sideways`, async ({ page }) => {
          await page.goto(path);
          await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
          await page.waitForLoadState('networkidle');
          expect(await axeAll(page)).toEqual([]);
          // Text-only zoom: the root font size, as a browser's text-size setting changes it.
          await page.evaluate(() => {
            document.documentElement.style.fontSize = '200%';
          });
          await expect(page.locator('.ne-title')).toHaveCSS('font-size', '44px');
          const layout = await overflow(page);
          expect(layout.pixels, `Horizontal overflow diagnostics: ${JSON.stringify(layout)}`).toBeLessThanOrEqual(0);
        });
      }
    });
  }
});

test.describe('mobile navigation', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('icon-only links are named and show their label on keyboard focus; the brand is not a second skip link', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.locator('a[href="#main"]')).toHaveCount(0);
    const costs = nav.getByRole('link', { name: 'Costs' });
    await expect(costs.locator('.ne-nav-link-label')).toBeHidden();
    await costs.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(costs).toBeFocused();
    await expect(costs.locator('.ne-nav-link-label')).toBeVisible();
  });
});

test('integrations: "Sync now" keeps keyboard focus while it syncs and after', async ({ page }) => {
  await page.route('**/api/nebius-estate/integrations/*/sync', route => setTimeout(() => route.fulfill({ json: { note: 'Sync finished (e2e).' } }), 800));
  // Hugging Face is healthy: its card is folded with the others (W1F.N5) and its section's link opens it.
  await page.goto('/integrations#connectors-healthy');
  const sync = page.getByRole('button', { name: /^Sync now \(Hugging Face/ });
  await sync.focus();
  await page.keyboard.press('Enter');
  const busy = page.getByRole('button', { name: /^Syncing… \(Hugging Face/ });
  await expect(busy).toBeFocused();
  await expect(busy).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText('Sync finished (e2e).')).toBeVisible();
  await expect(sync).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test('provisioning: each field error is the description of its input, and focus stays in the field', async ({ page }) => {
  await page.goto('/provisioning');
  const owner = page.locator('#pv-owner');
  await owner.fill('');
  await expect(owner).toHaveAttribute('aria-invalid', 'true');
  await expect(owner).toHaveAccessibleDescription(/Enter the owning team/);
  await expect(owner).toBeFocused();
  const budget = page.locator('#pv-budget');
  await budget.fill('12.3.4');
  await expect(budget).toHaveAccessibleDescription(/Enter an amount such as 500 or 499\.50/);
  await expect(budget).toBeFocused();
  const ref = page.locator('#pv-ref');
  await ref.fill('bad ref!');
  await expect(ref).toHaveAccessibleDescription(/Enter a ticket, date or run id/);
  // A field without an error is described by its hint.
  await expect(page.locator('#pv-rt')).toHaveAccessibleDescription(/Hours the resources exist/);
  await expect(page.getByRole('heading', { name: '6 · CI / plan status' })).toBeVisible();
});

test('workloads: a crash-looping workload says so in its row; a stale snapshot says why; tolerations listed once', async ({ page }) => {
  await page.route('**/api/nebius-estate/workloads*', route =>
    route.fulfill({
      json: {
        clusters: [{ name: 'nip-sandbox-inference', configured: true, observedAt: '2026-10-11T10:26:20Z', error: 'Showing the last successful snapshot (stale).', namespaces: ['inference', 'kube-system'], nodes: [] }],
        workloads: [
          { cluster: 'nip-sandbox-inference', namespace: 'inference', name: 'vllm', kind: 'Deployment', replicas: 1, readyReplicas: 0, gpuRequest: 1, requests: { cpu: '4' }, limits: {}, pendingPods: 0, schedulingMessages: [], nodeSelector: {}, tolerations: ['nvidia.com/gpu=present:NoSchedule'], uid: 'k8s:a' },
          { cluster: 'nip-sandbox-inference', namespace: 'kube-system', name: 'cilium-operator', kind: 'Deployment', replicas: 2, readyReplicas: 2, gpuRequest: 0, requests: {}, limits: {}, pendingPods: 0, schedulingMessages: [], nodeSelector: {}, tolerations: ['node.cilium.io/agent-not-ready:*', 'node.cilium.io/agent-not-ready:*'], uid: 'k8s:b' },
        ],
        events: [
          { cluster: 'nip-sandbox-inference', namespace: 'inference', involved: 'Pod/vllm-648655c887-8bxm4', reason: 'Unhealthy', type: 'Warning', message: 'Startup probe failed: connection refused', lastSeen: '2026-10-11T10:22:06Z' },
          { cluster: 'nip-sandbox-inference', namespace: 'inference', involved: 'Pod/vllm-648655c887-8bxm4', reason: 'BackOff', type: 'Warning', message: 'Back-off restarting failed container vllm in pod vllm-648655c887-8bxm4', lastSeen: '2026-10-11T10:17:18Z' },
        ],
        slurm: { available: false, reason: 'n/a' },
        soperatorClusters: [],
      },
    }),
  );
  await page.route('**/api/nebius-estate/resources*', route =>
    route.fulfill({ json: { items: [{ uid: 'c', providerId: 'mk8scluster-x', type: 'mk8s-cluster', name: 'nip-sandbox-inference', status: 'deleting', observedAt: '2026-10-11T10:56:17Z', labels: {}, refs: [], spec: {}, source: { connector: 'nebius-inventory', kind: 'api' }, coverageNotes: [], attribution: {}, ttl: {} }], total: 1, coverage: [] } }),
  );
  await page.goto('/workloads');
  const vllm = page.getByRole('row').filter({ hasText: 'nip-sandbox-inference/inference' });
  await expect(vllm).toContainText('CrashLoopBackOff');
  await expect(vllm).toContainText('not ready: startup probe failing');
  await expect(vllm).not.toContainText('scheduled');
  await expect(page.getByText('Cluster is being deleted (inventory 2026-10-11 10:56 UTC).')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'nip-sandbox-inference/kube-system' }).getByText('node.cilium.io/agent-not-ready:*')).toHaveCount(1);
});

test('capacity: a region in the link that no project is in says "not applied"', async ({ page }) => {
  await page.goto('/capacity?region=eu-north2');
  await expect(page.getByText('Filter from the link not applied')).toBeVisible();
});

test('costs: the range is a deep link; an inverted range freezes the results under a notice', async ({ page }) => {
  await page.goto('/costs?from=2026-10-01&to=2026-10-08');
  await expect(page.getByLabel('From (UTC)')).toHaveValue('2026-10-01');
  await expect(page.getByLabel('To (exclusive)')).toHaveValue('2026-10-08');
  await page.getByLabel('From (UTC)').fill('2026-10-20');
  await expect(page.getByText('“To” must be after “From”.')).toBeVisible();
  await expect(page.getByText('Range not applied')).toBeVisible();
  await expect(page.getByTestId('costs-results')).toHaveClass(/ne-frozen/);
  await expect(page).toHaveURL(/from=2026-10-01&to=2026-10-08/);
});

test('evidence: a raw <a id> anchor in a document scrolls to its place; no empty link is rendered', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', m => {
    if (m.type() === 'error' || m.type() === 'warning') warnings.push(m.text());
  });
  await page.goto(`/evidence?doc=${encodeURIComponent('docs/credentials.md')}#tenant-reads`);
  const target = page.getByRole('dialog').locator('#tenant-reads');
  await expect(target).toContainText('2b. Tenant reads');
  await expect(target).toBeInViewport();
  expect(warnings.filter(w => /Link.*children|children.*Link/i.test(w))).toEqual([]);
});

test('solutions: "Price this footprint" discloses the price panel (aria-expanded, aria-controls)', async ({ page }) => {
  await page.goto('/solutions');
  const b = page.getByRole('button', { name: 'Price this footprint: S1' });
  await expect(b).toHaveAttribute('aria-expanded', 'false');
  await b.click();
  await expect(b).toHaveAttribute('aria-expanded', 'true');
  await expect(b).toHaveAttribute('aria-controls', 'solution-price-panel');
  await expect(page.locator('#solution-price-panel')).toContainText('Price this footprint · S1');
  await expect(b).not.toHaveAttribute('aria-pressed');
});
