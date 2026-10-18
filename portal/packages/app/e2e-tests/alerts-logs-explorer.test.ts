import { expect, Page, test } from '@playwright/test';
import { axeBuilder } from './axe';

/**
 * Alerts, Logs and the Estate Explorer (Wave 1, G7), against the e2e stub: accessibility of the drawers that show
 * repository Markdown and resources, the log rows, and the confusing or misleading lines the 2026-10-12 live
 * verification found on these pages.
 */

async function axe(page: Page) {
  const r = await axeBuilder(page).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(', ')}`);
}

/** Every element inside `scope` that scrolls and cannot take the keyboard focus, nor holds anything that can. */
const unfocusableScrollers = (page: Page, scope: string) =>
  page.evaluate(sel => {
    const root = document.querySelector(sel);
    if (!root) return [`no ${sel}`];
    return [...root.querySelectorAll<HTMLElement>('*')]
      .filter(el => {
        const s = getComputedStyle(el);
        const x = /auto|scroll/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
        const y = /auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
        return (x || y) && el.tabIndex < 0 && !el.querySelector('a, button, input, select, textarea, [tabindex]');
      })
      .map(el => `${el.tagName.toLowerCase()}.${el.className}`);
  }, scope);

test('#42: an alert value reads with its unit and what it is, in the evidence and the history', async ({ page }) => {
  await page.goto('/alerts');
  await page.getByRole('row', { name: /vpc\.allocation\.count in eu-north1 is capped/ }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText(/Value: 987 below the tenant limit\./)).toBeVisible();
  await expect(drawer.getByRole('listitem').filter({ hasText: /→ (pending|firing)/ }).first()).toContainText('(value 987 below the tenant limit)');
  // A Monitoring rule's value is its query's result, said as such.
  await page.goto('/alerts');
  await page.getByRole('row', { name: /Xid error on nip-sandbox-inference-gpu-0/ }).click();
  await expect(page.getByRole('dialog')).toContainText(/Value: [\d.,]+ \(the result of the query below\)\./);
});

test('#46, #29: the Explorer table and drawer say the same about who a subnet or pool belongs to', async ({ page }) => {
  const open = async (name: string) => {
    await page.goto('/estate?mode=table');
    await page.getByLabel('Search').fill(name);
    const row = page.locator('tbody tr').filter({ hasText: name }).first();
    await expect(row).toBeVisible();
    return row;
  };
  // A subnet a managed service created: "managed" in the table and in the drawer, never "unattributed" (#46).
  let row = await open('postgresql-leftover-subnet');
  await expect(row.locator('.ne-chip')).toHaveText('managed');
  await expect(row.locator('.ne-chip')).toHaveAttribute('title', /a Nebius managed service \(label managed=true\)/);
  await row.click();
  let drawer = page.getByRole('dialog');
  await expect(drawer.locator('.ne-drawer-head .ne-chip')).toHaveText('managed');
  await expect(drawer).toContainText('Managed by a Nebius managed service (label managed=true): not ours to attribute.');
  await expect(drawer.getByText('unattributed', { exact: true })).toHaveCount(0);
  // An unlabelled pool takes its subnet's attribution and says so (#29).
  row = await open('auto-subnet-pool');
  await expect(row).toContainText('staging / network');
  await expect(row).toContainText('attributed via subnet nip-staging-workload');
  await row.click();
  drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Attributed via subnet nip-staging-workload')).toBeVisible();
  await expect(drawer).toContainText('assigned to this subnet (status.assignment)');
  // A pool assigned to no subnet or network says that, instead of a bare "unattributed", and never that nothing uses
  // it: allocations and child pools can draw from it directly (pool_id / source_pool_id are not read).
  row = await open('auto-subnet-pool-unused');
  await expect(row).toContainText('assigned to no subnet or network');
  await row.click();
  drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('allocations or child pools may still use it directly');
  await expect(drawer).not.toContainText('nothing draws');
});

test('#56: a project drawer says its status once ("active"), not "active — ACTIVE"', async ({ page }) => {
  await page.goto(`/estate?uid=${encodeURIComponent('nebius:project-e00mocksandbox')}`);
  const status = page.getByRole('dialog').locator('dt', { hasText: /^Status$/ }).locator('xpath=following-sibling::dd[1]');
  await expect(status).toHaveText('active');
});

test('#30: an audit list cut at its limit says how far back it goes, and "Show more" reads further', async ({ page }) => {
  const asked: number[] = [];
  await page.route('**/api/nebius-estate/audit/events?*', async route => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get('limit') ?? 50);
    asked.push(limit);
    const end = Date.parse('2026-10-12T16:00:00Z');
    const events = Array.from({ length: limit }, (_, i) => ({
      id: `auditevent-e00mockcut${i}`, time: new Date(end - (i + 1) * 600_000).toISOString(), service: 'COMPUTE', action: 'UPDATE', type: 'ai.nebius.compute.instance.update',
      who: { kind: 'service-account', name: 'nip-ci' }, resource: { type: 'instance', name: `vm-${i}` }, authorized: true, status: 'DONE',
    }));
    await route.fulfill({ json: { region: 'eu-north1', regions: ['eu-north1'], start: '2026-10-11T16:00:00Z', end: '2026-10-12T16:00:00Z', events, limit, truncated: true, scanned: 500, writesOnly: true, serverFiltered: true, source: 'Nebius Audit Logs (audit events API)', observedAt: '2026-10-12T16:00:00Z' } });
  });
  await page.goto('/logs');
  const card = page.locator('.ne-card', { has: page.getByText('Audit events (tenant)') });
  await expect(card.getByText('Showing the newest 50 changes, back to 2026-10-12 07:40 UTC')).toBeVisible();
  await expect(card).toContainText('Older changes in this range (from 2026-10-11 16:00 UTC) are not shown.');
  await card.getByRole('button', { name: 'Show 50 more' }).click();
  await expect(card.getByText('Showing the newest 100 changes, back to 2026-10-11 23:20 UTC')).toBeVisible();
  expect(asked).toContain(100);
  // A new range starts again at 50, in one request: never the raised limit first, then 50.
  asked.length = 0;
  await card.getByRole('group', { name: 'Audit time range' }).getByRole('button', { name: '7 d' }).click();
  await expect(card.getByText('Showing the newest 50 changes, back to 2026-10-12 07:40 UTC')).toBeVisible();
  await page.waitForTimeout(300); // a second, late request would land here
  expect(asked).toEqual([50]);
});

test('#31: with no project chosen, Logs opens on the project that wrote last (not the first with logs) and says so', async ({ page }) => {
  // Stub: sandbox (first in configuration order) last wrote 5 min ago, staging 1 min ago.
  await page.goto('/logs');
  const note = page.getByText(/^Project nip-staging \(/);
  await expect(note).toBeVisible();
  await expect(note).toContainText(/\(the one that wrote last \(\d{4}-\d\d-\d\d \d\d:\d\d UTC\) of 2 projects with log buckets in the last 7 days \(nip-sandbox, nip-staging\); pick another/);
  await expect(note).not.toContainText('the first of');
});

test('Logs opens on a bucket with lines: staging has no serial console, so the control-plane bucket that wrote last, with why', async ({ page }) => {
  // Stub: staging (the project that wrote last, #31) has only control-plane lines.
  await page.goto('/logs');
  await expect(page.getByText(/^Project nip-staging \(/)).toBeVisible();
  await expect(page.getByTestId('logs-opened-on')).toContainText(/Compute VMs has no lines in the last 7 days; showing Managed Kubernetes control plane, the bucket that wrote last \(\d{4}-\d\d-\d\d \d\d:\d\d UTC\)/);
  await expect(page.locator('#logql')).toHaveValue('{__bucket__="sp_mk8s_control_plane"}');
  await expect(page.getByRole('region', { name: /Log lines/ })).toContainText('apiserver ready');
  // A project whose serial console has lines keeps the serial-console errors preset.
  await page.goto('/logs?project=project-e00mocksandbox');
  await expect(page.getByRole('group', { name: 'Presets' }).getByRole('button', { name: 'Serial-console errors' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('logs-opened-on')).toHaveCount(0);
});

test('#64: the Alerts scope leaves out what the summary says, and a project name never breaks at its hyphen', async ({ page }) => {
  await page.goto('/alerts');
  const row = page.getByRole('row', { name: /vpc\.allocation\.count in eu-north1 is capped/ });
  const scope = row.getByRole('cell').nth(2);
  await expect(scope).not.toContainText('vpc.allocation.count');
  await expect(scope).not.toContainText('eu-north1');
  await expect(scope).toContainText('nip-sandbox');
  await expect(scope.locator('.ne-nowrap')).toHaveCSS('white-space', 'nowrap');
});

for (const width of [1440, 390]) {
  test.describe(`log line detail at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });
    test('#63: a long label name wraps in its column, never over its value; on a phone the time sits above the line', async ({ page }) => {
      await page.goto('/logs?project=project-e00mocksandbox');
      const lines = page.getByRole('region', { name: /Log lines/ });
      await expect(lines).toContainText('NVRM: loading NVIDIA UNIX');
      await lines.getByRole('button', { name: /NVRM: loading NVIDIA UNIX/ }).click();
      const name = page.locator('.ne-kv dt', { hasText: 'compute_nebius_com_node_group_id' });
      await expect(name).toBeVisible();
      const overlap = await name.evaluate(dt => {
        const dd = dt.nextElementSibling as HTMLElement;
        const a = dt.getBoundingClientRect();
        const b = dd.getBoundingClientRect();
        const sameRow = a.top < b.bottom && b.top < a.bottom;
        return { inside: dt.scrollWidth <= dt.clientWidth + 1, overlaps: sameRow && a.right > b.left + 1 };
      });
      expect(overlap).toEqual({ inside: true, overlaps: false });
      if (width === 390) {
        const row = lines.getByRole('button', { name: /NVRM: loading NVIDIA UNIX/ });
        const box = await row.evaluate(r => {
          const t = r.querySelector('.ne-logrow-time')!.getBoundingClientRect();
          const x = r.querySelector('.ne-logrow-text')!.getBoundingClientRect();
          return { above: t.bottom <= x.top + 1, text: Math.round(x.width), row: Math.round(r.getBoundingClientRect().width) };
        });
        expect(box.above).toBe(true);
        expect(box.text).toBeGreaterThan(box.row * 0.85);
      }
    });
  });
}

test('#74: a document outside the allowlist opens a drawer that says it is not readable, and shows nothing of it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); // axe reads the drawer at rest, not mid slide-in
  for (const doc of ['terraform/live/sandbox/inference/terraform.tfstate', '.env']) {
    await page.goto(`/evidence?doc=${encodeURIComponent(doc)}`);
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('Not readable through the portal')).toBeVisible();
    await expect(drawer).toContainText('Only allowlisted documentation and sizing files are served');
    await expect(drawer.locator('.ne-markdown, pre')).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  }
});

test('#26: the graph names the tenant "Tenant", with its id as hover text, never the raw id as the label', async ({ page }) => {
  await page.goto('/estate');
  // The visible label is "Tenant"; the id is its hover text and, so a screen reader can tell tenants apart, its name.
  const tenant = page.getByRole('button', { name: /^Tenant tenant-e00mocktest/ });
  await expect(tenant).toBeVisible();
  await expect(tenant.locator('text').first()).toHaveText('Tenant');
  // Its second line is the id, not "Tenant" again.
  await expect(tenant.locator('text').nth(1)).toHaveText('tenant-e00mocktest');
  await expect(page.getByText('read left → right')).toBeVisible();
  await expect(tenant.locator('title')).toContainText('tenant-e00mocktest');
  await expect(page.locator('.ne-graph svg .ne-gnode > text:first-of-type', { hasText: /^tenant-/ })).toHaveCount(0);
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme, 390 px graph`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    test('#21: after "Expand all" the graph fills its box with nodes (an indented tree), not a tall empty canvas', async ({ page }) => {
      await page.goto('/estate');
      await page.getByRole('button', { name: 'Expand all' }).click();
      const graph = page.locator('.ne-graph');
      await expect(graph).toHaveAttribute('data-layout', 'tree');
      await expect(page.getByText('87 of 87 nodes shown')).toBeVisible();
      // An indented tree is not read left to right: the legend leaves that out.
      await expect(page.getByText(/^Dashed: grouping/)).toBeVisible();
      await expect(page.getByText('read left → right')).toBeHidden();
      const fit = await graph.evaluate(el => {
        const box = el.getBoundingClientRect();
        const inView = [...el.querySelectorAll('.ne-gnode')].filter(n => {
          const r = n.getBoundingClientRect();
          return r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom;
        }).length;
        const row = el.querySelector('.ne-gnode rect')!.getBoundingClientRect().height + 10;
        return { sideways: el.scrollWidth - el.clientWidth, rows: Math.floor(el.clientHeight / row), inView };
      });
      expect(fit.sideways).toBeLessThanOrEqual(0);
      // One node per row from the top of the box to its bottom: no empty canvas.
      expect(fit.inView).toBeGreaterThanOrEqual(fit.rows - 1);
      expect(await axe(page)).toEqual([]);
    });
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme, 1440 px`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1440, height: 900 } });
    test('#45: the resources table fits its card, the Observed column is on screen, a DNS name breaks at its dots', async ({ page }) => {
      await page.goto('/estate?mode=table');
      const table = page.getByRole('table').first();
      await expect(table.locator('tbody tr').first()).toBeVisible();
      const fit = await table.evaluate(t => ({ table: t.scrollWidth, box: (t.closest('.ne-card') as HTMLElement).clientWidth }));
      expect(fit.table).toBeLessThanOrEqual(fit.box);
      const observed = await page.getByRole('columnheader', { name: /Observed/ }).boundingBox();
      expect(observed!.x + observed!.width).toBeLessThanOrEqual(1440);
      const summary = page.locator('.ne-xsummary', { hasText: 'sandbox.example.internal.' });
      // Each line of the name ends at a separator: the text is split into parts with a break opportunity after each dot.
      await expect(summary).toHaveCount(1);
      await expect(summary.locator('wbr')).not.toHaveCount(0);
      const lines = await summary.evaluate(el => {
        const out: string[] = [];
        let last = -1;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          for (let i = 0; i < n.textContent!.length; i++) {
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + 1);
            const top = Math.round(r.getBoundingClientRect().top);
            if (top !== last) out.push('');
            last = top;
            out[out.length - 1] += n.textContent![i];
          }
        }
        return out;
      });
      for (const line of lines.slice(0, -1)) expect(line.trimEnd()).toMatch(/[./·]$|records$/);
    });
  });
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1440, 390]) {
    test.describe(`${scheme} theme, ${width} px`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 }, reducedMotion: 'reduce' });

      test('#39: an alert runbook with code blocks: each block that scrolls is focusable and named, tokens pass contrast, no axe violations', async ({ page }) => {
        await page.goto('/alerts');
        await page.getByRole('row', { name: /vpc\.allocation\.count in eu-north1 is capped/ }).click();
        const drawer = page.getByRole('dialog');
        const runbook = drawer.locator('.ne-fix-runbook');
        // The highlighter loads its languages asynchronously: wait for its tokens.
        await expect(runbook.locator('pre code span[style]').first()).toBeAttached();
        if (width === 390) await expect(runbook.getByRole('region', { name: 'Code block (scrolls sideways)' }).first()).toBeVisible();
        expect(await unfocusableScrollers(page, '[role="dialog"]')).toEqual([]);
        expect(await axe(page)).toEqual([]);
        await expect(runbook.locator('pre [data-ne-tok]').first()).toBeAttached();
      });

      test('#40: Explorer drawers with no link or button (bucket, project, subnet) scroll with the keyboard; no axe violations', async ({ page }) => {
        for (const uid of ['storagebucket-e00mocksbxstate', 'project-e00mocksandbox', 'vpcsubnet-e00mocksbx']) {
          await page.goto(`/estate?uid=${encodeURIComponent(`nebius:${uid}`)}`);
          const drawer = page.getByRole('dialog');
          await expect(drawer.locator('.ne-drawer-body')).toBeVisible();
          await expect(drawer.getByRole('region').first()).toHaveAttribute('tabindex', '0');
          expect(await unfocusableScrollers(page, '[role="dialog"]'), uid).toEqual([]);
          expect(await axe(page), uid).toEqual([]);
        }
      });

      test('a selected alert row keeps every severity badge readable (contrast on the selection colour)', async ({ page }) => {
        await page.goto('/alerts');
        const inbox = page.getByRole('table').first();
        const rows = inbox.locator('tbody tr[data-clickable="true"]');
        await expect(rows.first()).toBeVisible();
        const tones = new Set<string>();
        for (let i = 0; i < (await rows.count()); i++) {
          const row = rows.nth(i);
          await row.click();
          await expect(row).toHaveAttribute('aria-selected', 'true');
          for (const c of await row.locator('.ne-badge').evaluateAll(els => els.map(e => e.className))) tones.add(c);
          // The Wave 1 verification: a selected critical row's red badge was 4.34:1 in the dark theme.
          const r = await axeBuilder(page).include(`tbody tr[aria-selected="true"]`).withRules(['color-contrast']).analyze();
          expect(r.violations.flatMap(v => v.nodes.map(n => `${n.target.join(' ')}: ${n.any.map(a => a.message).join(' ')}`)), await row.innerText()).toEqual([]);
          await page.keyboard.press('Escape');
        }
        expect([...tones].join(' ')).toMatch(/ne-tone-danger/);
      });

      test('#41: a selected log row keeps its time readable (contrast on the selection colour); no axe violations', async ({ page }) => {
        await page.goto('/logs?project=project-e00mocksandbox');
        const lines = page.getByRole('region', { name: /Log lines/ });
        await lines.getByRole('button').first().click();
        await expect(lines.getByRole('button', { pressed: true })).toHaveCount(1);
        expect(await axe(page)).toEqual([]);
      });

      for (const doc of ['runbooks/capacity-request.md', 'docs/naming.md']) {
        test(`#39, #51: the document drawer (${doc}): code blocks focusable when they scroll, inline code wraps, nothing widens the document`, async ({ page }) => {
          await page.goto(`/evidence?doc=${encodeURIComponent(doc)}`);
          const drawer = page.getByRole('dialog');
          await expect(drawer.locator('.ne-markdown pre').first()).toBeVisible();
          await expect.poll(() => unfocusableScrollers(page, '[role="dialog"]')).toEqual([]);
          // The Markdown body is never wider than its drawer (#51: inline code in naming.md widened it by 63 px at 390).
          const widths = await drawer.locator('.ne-markdown').evaluate(el => ({ body: el.scrollWidth, box: el.clientWidth }));
          expect(widths.body).toBeLessThanOrEqual(widths.box + 1);
          expect(await axe(page)).toEqual([]);
        });
      }
    });
  }
}
