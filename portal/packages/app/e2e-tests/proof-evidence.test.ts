import { expect, Page, test } from '@playwright/test';
import { axeBuilder } from './axe';

/**
 * Evidence and Solutions proof claims (Wave 1, G5) against the e2e stub. Evidence, runbooks and solutions are read from
 * this checkout, as live; drift and fallback states are injected by rewriting the portal's own replies.
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
const solution = (page: Page, id: string) => page.locator('.ne-sol-card', { has: page.getByRole('heading', { name: new RegExp(`^${id} · `) }) });
const recipe = (page: Page, id: string) => page.locator('.ne-card', { has: page.getByRole('heading', { name: new RegExp(`^${id} · `) }) });

for (const theme of THEMES) {
  test(`W1-P11, W1-P13: a solution's proof is derived from the evidence, one chip per recipe (${theme}, 1440 and 390 px)`, async ({ page }) => {
    await useTheme(page, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/solutions');
      const s9 = solution(page, 'S9');
      await expect(s9).toContainText('3 of 6 recipes run live · 1 planned or read only');
      const chips = s9.locator('.ne-proof-chips li');
      await expect(chips.filter({ hasText: /^R12 / })).toHaveText('R12 Live run last live 2026-10-12');
      await expect(chips.filter({ hasText: /^R3 / })).toHaveText('R3 Live read / plan last live 2026-10-11');
      await expect(chips.filter({ hasText: /^R5 / })).toHaveText('R5 Mocked only Not measured');
      await expect(s9).toContainText('Solution status (README)');
      // The rows are reconciled: no card says its README disagrees with the evidence.
      await expect(page.getByText('README proof rows disagree with the evidence index')).toHaveCount(0);
      expect(await overflow(page), `${width} px`).toBeLessThanOrEqual(0);
      await axe(page);
    }
    // A chip opens the newest evidence file of its recipe.
    await solution(page, 'S9').getByRole('button', { name: /^last live 2026-10-12, read docs\/evidence\/2026-10-12-sandbox-ml-services-acceptance\.md$/ }).click();
    await expect(page).toHaveURL(/doc=docs%2Fevidence%2F2026-10-12-sandbox-ml-services-acceptance\.md/);
  });

  test(`W1-P12: a README proof row that the evidence contradicts gets a banner on its card (${theme})`, async ({ page }) => {
    await useTheme(page, theme);
    await page.route('**/api/nebius-estate/solutions', async r => {
      const body = await (await r.fetch()).json();
      const s9 = body.items.find((s: { id: string }) => s.id === 'S9');
      const r12 = s9.proof.find((p: { recipe: string }) => p.recipe === 'R12');
      s9.proofDrift = [{ recipe: 'R12', says: 'not run', claim: { path: 'solutions/README.md', where: 'solutions/README.md, S9 Status', text: 'designed; R12 not run' }, proof: r12 }];
      await r.fulfill({ json: body });
    });
    await page.goto('/solutions');
    const banner = solution(page, 'S9').getByRole('note').filter({ hasText: 'README proof rows disagree with the evidence index' });
    await expect(banner).toContainText('solutions/README.md, S9 Status says R12 not run; the evidence index has Live run 2026-10-12 (2026-10-12-sandbox-ml-services-acceptance.md).');
    await expect(solution(page, 'S1').getByText('README proof rows disagree with the evidence index')).toHaveCount(0);
    await axe(page);
  });

  test(`#10: evidence titles keep their date on one line (${theme}, 1440 and 390 px)`, async ({ page }) => {
    await useTheme(page, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/evidence');
      const dates = page.locator('.ne-card-title .ne-nowrap');
      await expect(dates.first()).toBeVisible();
      expect(await dates.count()).toBeGreaterThan(3);
      // Every date is one line box: "— 2026-10-" / "11" never happens.
      const lines = await dates.evaluateAll(es => es.filter(e => (e as HTMLElement).offsetParent).map(e => [e.textContent, e.getClientRects().length]));
      expect(lines.filter(([, n]) => n !== 1), `${width} px`).toEqual([]);
      // ... and runs on from the title's text, not as a column of its own beside it (a flex item would be one).
      const columns = await dates.evaluateAll(es => es.filter(e => /flex|grid/.test(getComputedStyle(e.parentElement!).display)).map(e => e.textContent));
      expect(columns, `${width} px`).toEqual([]);
      expect(await overflow(page), `${width} px`).toBeLessThanOrEqual(0);
      await axe(page);
    }
  });

  test(`#48, W1-P13: recipe cards lead with their own runs and say the last live run or "Not measured" (${theme}, 1440 and 390 px)`, async ({ page }) => {
    await useTheme(page, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/evidence?tab=recipes');
      const r1 = recipe(page, 'R1');
      // R1's own runs lead (the 2026-10-13 R1 session, then the 2026-10-12 validation run); the R8 and R14 runs that
      // also cover R1 are among the folded rows. The 2026-10-13 retry measured R1 (v0.3.1).
      await expect(r1.locator('.ne-ev-rows').first().getByRole('button', { name: /^sandbox\/inference validation run \(R1\) — 2026-10-12, read / })).toBeVisible();
      await expect(r1.locator('.ne-card-head')).toContainText('Measured last live 2026-10-13');
      await expect(recipe(page, 'R5').locator('.ne-card-head')).toContainText('Mocked only Not measured');
      await expect(recipe(page, 'R7').locator('.ne-card-head')).toContainText('Live read / plan last live 2026-10-11');
      expect(await overflow(page), `${width} px`).toBeLessThanOrEqual(0);
      await axe(page);
    }
  });
}

test('#9, #73: runbook cards summarise in prose, never a command or the note under a code block', async ({ page }) => {
  await page.goto('/evidence?tab=runbooks');
  const card = (name: RegExp) => page.locator('.ne-card', { has: page.getByRole('heading', { name }) }).locator('p');
  await expect(card(/^Drift runbook$/)).toHaveText('Identify the source: manual console change, another reconciler, or provider upgrade.');
  await expect(card(/^Rollback and recovery$/)).toHaveText(/^Roll back one component at a time \(P5\)/);
});

const down = { status: 503, json: { error: { name: 'ServiceUnavailableError', message: 'The repository checkout is unavailable (e2e).' } } };

test('#74: Evidence and Solutions say a failed read with a Retry that recovers', async ({ page }) => {
  for (const [url, route] of [
    ['/evidence', '**/api/nebius-estate/evidence'],
    ['/solutions', '**/api/nebius-estate/solutions'],
  ] as const) {
    await page.route(route, r => r.fulfill(down));
    await page.goto(url);
    const state = page.getByRole('alert').filter({ hasText: 'This view could not be loaded' });
    await expect(state, url).toContainText('The repository checkout is unavailable (e2e).');
    await page.unroute(route);
    await state.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByText('This view could not be loaded'), url).toHaveCount(0);
  }
});

test('#74: Solutions without solutions/README.md say so instead of an empty page', async ({ page }) => {
  await page.route('**/api/nebius-estate/solutions', r => r.fulfill({ json: { items: [], unavailableReason: 'solutions/README.md is not in this checkout.' } }));
  await page.goto('/solutions');
  await expect(page.getByText('No solutions in this checkout')).toBeVisible();
  await expect(page.getByText('solutions/README.md is not in this checkout.')).toBeVisible();
});

test('#74: an unreadable footprint file is named in the price panel; the readable one is still priced', async ({ page }) => {
  await page.route('**/api/nebius-estate/solutions', async r => {
    const body = await (await r.fetch()).json();
    const s4 = body.items.find((s: { id: string }) => s.id === 'S4');
    s4.footprints.push({ path: `${s4.dir}/footprint-broken.json`, capacityTypes: [], notes: [], error: 'not JSON: Unexpected token (e2e)' });
    await r.fulfill({ json: body });
  });
  // The readable file still goes to the calculator. Answered here, not by the backend: the backend's per-user
  // live-price budget is shared by the whole run, and later price tests need it.
  const priced: string[] = [];
  await page.route('**/api/nebius-estate/pricing/footprint', r => {
    priced.push(JSON.parse(r.request().postData() ?? '{}').capacityType);
    return r.fulfill({ status: 503, json: { error: { name: 'ServiceUnavailableError', message: 'Calculator not asked (e2e).' } } });
  });
  await page.goto('/solutions?price=S4');
  const panel = page.locator('.ne-card', { hasText: 'Price this footprint · S4' });
  await expect(panel.getByRole('note').filter({ hasText: 'footprint-broken.json could not be read' })).toContainText('not JSON: Unexpected token (e2e)');
  await expect(panel).toContainText('footprint.json · eu-north1 · 72 h');
  await expect.poll(() => priced.sort()).toEqual(['on-demand', 'preemptible']);
});

test('#74: without the commercial read permissions the price panel says which are needed, and asks the calculator nothing', async ({ page }) => {
  await page.route('**/api/nebius-estate/meta', async r => {
    const body = await (await r.fetch()).json();
    body.permissions['nebius.commercial.rate.read'] = false;
    await r.fulfill({ json: body });
  });
  let priced = 0;
  await page.route('**/api/nebius-estate/pricing/footprint', r => {
    priced++;
    return r.abort();
  });
  await page.goto('/solutions?price=S4');
  const panel = page.locator('.ne-card', { hasText: 'Price this footprint · S4' });
  await expect(panel.getByText(/Live prices need nebius\.commercial\.scenario\.read and nebius\.commercial\.rate\.read/).first()).toBeVisible();
  await expect(panel.getByText(/XTS/)).toHaveCount(0);
  expect(priced).toBe(0);
});
