import { expect, test } from '@playwright/test';
// Test-only: locates the shared test data next to the stub.
// eslint-disable-next-line no-restricted-imports
import { resolve } from 'path';

/**
 * Budgets & credits and AI services against the e2e stub (e2e-stub/aiStub.js for Token Factory and
 * Hugging Face). Both pages are also in the themed axe and 390 px checks of portal.test.ts (PAGES).
 * The budget data is entered through the UI, as the owner would; nothing is seeded.
 */

// eslint-disable-next-line no-restricted-syntax
const TEST_DATA = resolve(__dirname, '../../../e2e-stub');

test.describe.serial('budgets & credits', () => {
  // The FOCUS file is imported first, so the spend these budgets measure does not depend on whether another test file
  // imported it already (other files import it in parallel; before, "Account monthly" read 2.99 or 127.48 XTS).
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/costs');
    await page.locator('input[type=file]').setInputFiles(resolve(TEST_DATA, 'focus.csv'));
    await expect(page.getByText(/^Imported \d+ rows/)).toBeVisible();
    await page.close();
  });

  test('starts with nothing entered and says what to add; mirrors the console', async ({ page }) => {
    await page.goto('/budgets');
    await expect(page.getByRole('heading', { level: 1, name: 'Budgets & credits' })).toBeVisible();
    await expect(page.getByRole('link', { name: /the console \(Billing → Budgets\)/ })).toHaveAttribute('href', 'https://console.nebius.com/billing');
    // F1.8: the config budget listed below is counted, apart from the ones entered here; never "nothing tracked".
    await expect(page.getByRole('table', { name: 'Budgets from the configuration' }).getByRole('row', { name: /sandbox-run-481/ })).toBeVisible();
    const tile = page.getByRole('region', { name: 'Budgets summary', exact: true }); // G4.16: not a second region named "Budgets"
    await expect(tile.locator('.ne-tile-value')).toHaveText('1');
    await expect(tile).toContainText('0 entered by you (1 from config)');
    await expect(page.getByText('Nothing tracked yet')).toHaveCount(0);
    await expect(page.getByText('No budgets or credits entered by you')).toBeVisible();
    await expect(page.getByText(/1 budget from the configuration is listed below/)).toBeVisible();
  });

  test('F1.6: the month headline is what was spent; the run-rate estimate is a separate projected line', async ({ page }) => {
    await page.goto('/budgets');
    const tile = page.getByRole('region', { name: 'Spend this month' });
    const amount = (t: string | null) => Number((t ?? '').replace(/[^\d.]/g, ''));
    const actual = tile.locator('div').filter({ hasText: /\(actual\)$/ }).last();
    await expect(actual).toBeVisible();
    const spent = amount(await tile.locator('.ne-tile-value').first().textContent());
    // Nothing entered yet: the headline is the export's actual figure alone.
    expect(spent).toBe(amount(await actual.locator('.ne-num').textContent()));
    const projected = tile.getByTestId('projected');
    await expect(projected).toContainText(/^Projected/);
    await expect(projected).toContainText('live run-rate estimate');
    expect(amount(await projected.locator('.ne-num').first().textContent())).toBeGreaterThan(spent);
  });

  // Before any Token Factory spend is entered (serial): nothing is known drawn from the credit.
  test('#36: a credit with no spend entered is unverified: "≤ amount", grey, on Budgets and the Overview', async ({ page }) => {
    await page.goto('/budgets');
    await page.getByRole('button', { name: 'Add credit' }).first().click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Name').fill('Unverified promo');
    await drawer.getByLabel('Provider').selectOption('token-factory');
    await drawer.getByLabel('Amount').fill('25');
    await drawer.getByRole('button', { name: 'Save' }).click();
    const row = page.getByRole('table', { name: 'Credits' }).getByRole('row', { name: /Unverified promo/ });
    await expect(row.getByTestId('credit-remaining')).toHaveText(/^≤ 25\.00 USD\s*no spend entered$/);
    await expect(row.getByRole('meter')).toHaveCount(0);
    await expect(row.getByText('Unverified: no spend entered', { exact: true })).toHaveClass(/ne-tone-neutral/);
    await expect(row.locator('.ne-tone-ok')).toHaveCount(0);
    const tile = page.getByRole('region', { name: 'Credit remaining' });
    await expect(tile.locator('.ne-tile-value')).toHaveText('≤ 25.00 USD');
    await expect(tile).toContainText('unverified: no spend entered');
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Budgets (advisory)' })).toContainText('Unverified promo: ≤ 25.00 USD of 25.00 USD left (no spend entered) · no expiry entered');
    await page.goto('/budgets');
    await row.getByRole('button', { name: 'Delete Unverified promo' }).click();
    await row.getByRole('button', { name: /Confirm: delete Unverified promo/ }).click();
    await expect(page.getByText('Deleted the credit “Unverified promo”.')).toBeVisible();
  });

  test('a Token Factory promo credit and its spend: remaining, expiry and a signal', async ({ page }) => {
    await page.goto('/budgets');
    await page.getByRole('button', { name: 'Add credit' }).first().click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Name').fill('Token Factory promo credit');
    await drawer.getByLabel('Provider').selectOption('token-factory');
    await drawer.getByLabel('Amount').fill('25');
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await drawer.getByLabel('Expires on (optional)').fill(soon);
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Saved “Token Factory promo credit”/)).toBeVisible();
    await expect(page.getByRole('table', { name: 'Credits' }).getByText('Token Factory promo credit')).toBeVisible();
    await expect(page.getByText(/Expires in [45] days/).first()).toBeVisible();

    await page.getByRole('button', { name: 'Add spend' }).click();
    await page.getByRole('dialog').getByLabel('Spend that day').fill('2.50');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('table', { name: 'Credits' }).getByText('22.50 USD')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Budget and credit signals' })).toBeVisible();
  });

  // After the promo credit and today's spend (serial).
  test('W1-P22: a second spend entry for the same day replaces the first, said before Save', async ({ page }) => {
    const today = new Date().toISOString().slice(0, 10);
    await page.goto('/budgets');
    await page.getByRole('button', { name: 'Add spend' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Date (UTC)').fill(today);
    await drawer.getByLabel('Spend that day').fill('2.50');
    await expect(drawer.getByText(`Spend for ${today} is already entered`)).toBeVisible();
    await expect(drawer).toContainText('saving replaces that entry, it is not added to it');
    await drawer.getByRole('button', { name: `Save (replaces the entry of ${today})` }).click();
    await expect(page.getByText(`Replaced the spend entry of ${today}.`)).toBeVisible();
    await expect(page.getByRole('table', { name: 'Token Factory spend entries' }).getByRole('row', { name: new RegExp(today) })).toHaveCount(1);
  });

  // After the promo credit and today's spend (serial): a missing expiry is grey; a credit burning out is amber, with its signal.
  test('W1-P21: no expiry is grey, never green; a credit the burn uses up within 14 days is amber with a signal', async ({ page }) => {
    const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    await page.goto('/budgets');
    await page.getByRole('button', { name: 'Add credit' }).first().click();
    let drawer = page.getByRole('dialog');
    await drawer.getByLabel('Name').fill('No-expiry credit');
    await drawer.getByLabel('Provider').selectOption('token-factory');
    await drawer.getByLabel('Amount').fill('100');
    await drawer.getByRole('button', { name: 'Save' }).click();
    const credits = page.getByRole('table', { name: 'Credits' });
    await expect(credits.getByRole('row', { name: /No-expiry credit/ }).getByText('Active · no expiry entered', { exact: true })).toHaveClass(/ne-tone-neutral/);
    // Applied six days ago and drawn from five days ago: it runs out within days.
    await page.getByRole('button', { name: 'Add credit' }).first().click();
    drawer = page.getByRole('dialog');
    await drawer.getByLabel('Name').fill('Burning credit');
    await drawer.getByLabel('Provider').selectOption('token-factory');
    await drawer.getByLabel('Amount').fill('10');
    await drawer.getByLabel('Applied on').fill(day(6));
    await drawer.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Add spend' }).click();
    drawer = page.getByRole('dialog');
    await drawer.getByLabel('Date (UTC)').fill(day(5));
    await drawer.getByLabel('Spend that day').fill('7');
    await drawer.getByRole('button', { name: 'Save' }).click();
    const burning = credits.getByRole('row', { name: /Burning credit/ });
    await expect(burning.getByText(/^Runs out about \d{4}-\d{2}-\d{2} at the current burn$/)).toHaveClass(/ne-tone-warn/);
    await expect(page.getByRole('region', { name: 'Budget and credit signals' }).or(page.locator('.ne-card', { hasText: 'Budget and credit signals' })).first()).toContainText(/Credit “Burning credit” runs out about/);
    // Cleaned up: the entry and both credits.
    await page.getByRole('table', { name: 'Token Factory spend entries' }).getByRole('row', { name: new RegExp(day(5)) }).getByRole('button', { name: /^Delete spend of/ }).click();
    await page.getByRole('button', { name: /Confirm: delete spend of/ }).click();
    for (const name of ['Burning credit', 'No-expiry credit']) {
      await credits.getByRole('row', { name: new RegExp(name) }).getByRole('button', { name: `Delete ${name}` }).click();
      await page.getByRole('button', { name: `Confirm: delete ${name} from the portal` }).click();
      await expect(page.getByText(`Deleted the credit “${name}”.`)).toBeVisible();
    }
  });

  test('F1.9: a budget is checked in plain words before it is sent, then measured against the export', async ({ page }) => {
    const posts: string[] = [];
    page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/budgets/')) posts.push(r.url()); });
    await page.goto('/budgets');
    await page.getByRole('button', { name: 'Add budget' }).first().click();
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(drawer.getByLabel('Name')).toHaveAccessibleDescription('Enter a name (up to 80 characters).');
    await expect(drawer.getByLabel('Amount')).toHaveAccessibleDescription('Enter an amount greater than 0, such as 100 or 99.50.');
    await expect(drawer.getByLabel('Name')).toBeFocused();
    await expect(drawer.getByText('Not saved: 2 fields need a fix.')).toBeVisible();
    await drawer.getByLabel('Name').fill('Account monthly');
    await drawer.getByLabel('Amount').fill('-5');
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(drawer.getByLabel('Amount')).toHaveAccessibleDescription('Enter an amount greater than 0, such as 100 or 99.50.');
    await expect(drawer).not.toContainText(/Too small|expected string/);
    expect(posts.filter(u => !u.endsWith('/budgets/preview'))).toEqual([]);
    // 260 XTS: nip-sandbox's 127.48 XTS this month is under half of it; with the live estimate it is over.
    await drawer.getByLabel('Amount').fill('260');
    await expect(drawer.getByText(/need a fix/)).toHaveCount(0);
    // F1.7: a new budget starts in the currency the spend is in.
    await expect(drawer.getByLabel('Currency')).toHaveValue('XTS');
    // The project condition is a picker of the projects you can see, by name.
    const projects = drawer.getByRole('group', { name: 'Project condition' });
    await projects.getByRole('checkbox', { name: /nip-sandbox/ }).check();
    // W1-P23: the scope's spend this period, measured while the budget is typed (nothing saved yet).
    await expect(drawer.getByTestId('scope-preview')).toContainText(/127\.48 XTS spent in this scope this month so far \(49 % of the amount\) · billing through/);
    expect(posts.filter(u => !u.endsWith('/budgets/preview'))).toEqual([]);
    await drawer.getByRole('button', { name: 'Save' }).click();
    const row = page.getByRole('table', { name: 'Budgets' }).getByRole('row', { name: /Account monthly/ });
    await expect(row).toBeVisible();
    await expect(row.getByText('actual', { exact: true })).toBeVisible();
    // W1-P22: how fresh the billing figure is, on the row itself.
    await expect(row.getByTestId('budget-asof')).toHaveText(/^billing through \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    await expect(row.getByText('nip-sandbox', { exact: true })).toHaveAttribute('title', 'project-e00mocksandbox');
    expect(posts.filter(u => !u.endsWith('/budgets/preview'))).toHaveLength(1);
    // W1-P23: Open in Costs shows this budget's project and period.
    const month = new Date().toISOString().slice(0, 7);
    await row.getByRole('link', { name: 'Open in Costs: budget Account monthly' }).click();
    await expect(page).toHaveURL(new RegExp(`/costs\\?project=project-e00mocksandbox&from=${month}-01&to=\\d{4}-\\d{2}-01`));
    await expect(page.getByLabel('Project', { exact: true })).toHaveValue('project-e00mocksandbox');
    await expect(page.getByLabel('From (UTC)')).toHaveValue(`${month}-01`);
  });

  test('F1.47: Used is the actual, as for the config budget of the same project and month; the projection is apart', async ({ page }) => {
    await page.goto('/budgets');
    // The config budget sandbox-run-481 (nip-sandbox, this month, 1500 XTS); the same budget entered here must agree.
    await page.getByRole('button', { name: 'Add budget' }).first().click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Name').fill('Sandbox month');
    await drawer.getByLabel('Amount').fill('1500');
    await drawer.getByRole('group', { name: 'Project condition' }).getByRole('checkbox', { name: /nip-sandbox/ }).check();
    await drawer.getByRole('button', { name: 'Save' }).click();
    const entered = page.getByRole('table', { name: 'Budgets' }).getByRole('row', { name: /Sandbox month/ });
    const config = page.getByRole('table', { name: 'Budgets from the configuration' }).getByRole('row', { name: /sandbox-run-481/ });
    const pct = async (t: string | null) => Number(/([\d.]+) %/.exec(t ?? '')?.[1]);
    const used = await pct(await entered.getByTestId('budget-used').textContent());
    expect(used).toBe(await pct(await config.getByRole('cell').nth(3).textContent()));
    // The config budget says how fresh its figure is, as the entered rows do (W1-P22; Wave 1 verification).
    await expect(config.getByTestId('config-budget-asof')).toHaveText(/^billing through \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    // Account monthly (260 XTS, nip-sandbox): 127.48 XTS spent; only the live estimate passes the amount.
    const small = page.getByRole('table', { name: 'Budgets' }).getByRole('row', { name: /Account monthly/ });
    await expect(small).toContainText('Within every threshold');
    await expect(small).not.toContainText(/Over the amount/);
    expect(await pct(await small.getByTestId('budget-used').textContent())).toBeLessThan(100);
    await expect(small.getByTestId('budget-projected')).toContainText(/^Projected .* with the live estimate/);
    expect(await pct(await small.getByTestId('budget-projected').textContent())).toBeGreaterThan(100);
    await expect(small.getByText('Projected over the amount with the live estimate')).toBeVisible();
    // W1-P20: two forecast lines, each with what it assumes.
    const forecast = small.getByTestId('budget-forecast');
    await expect(forecast).toContainText(/→ [\d,.]+ XTS \([\d,]+ %\) at this period's average burn \([\d,.]+ XTS a day\)/);
    // The stub runs a resource the calculator cannot price: the line names it instead of counting it as zero.
    await expect(forecast).toContainText(/→ [\d,.]+ XTS \([\d,]+ %\) if nothing new runs \([\d,.]+ XTS \/ h running now; 1 running resource without a price is not in it\)/);
    await entered.getByRole('button', { name: 'Delete Sandbox month' }).click();
    await entered.getByRole('button', { name: /Confirm: delete Sandbox month/ }).click();
    await expect(page.getByText('Deleted the budget “Sandbox month”.')).toBeVisible();
  });

  test('F1.9: credit and spend drawers say what is wrong in words, without a request', async ({ page }) => {
    const bad: string[] = [];
    page.on('response', r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
    await page.goto('/budgets');
    await page.getByRole('button', { name: 'Add credit' }).first().click();
    let drawer = page.getByRole('dialog');
    // A credit follows its provider's spend currency: AI Cloud spend is in XTS.
    await drawer.getByLabel('Provider').selectOption('ai-cloud');
    await expect(drawer.getByLabel('Currency')).toHaveValue('XTS');
    await drawer.getByLabel('Expires on (optional)').fill('2020-01-01');
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(drawer.getByLabel('Name')).toHaveAccessibleDescription('Enter a name (up to 80 characters).');
    await expect(drawer.getByLabel('Expires on (optional)')).toHaveAccessibleDescription('The expiry is before the applied date.');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Add spend' }).click();
    drawer = page.getByRole('dialog');
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(drawer.getByLabel('Spend that day')).toHaveAccessibleDescription('Enter the spend of that day as 0 or more, such as 12.40.');
    expect(bad).toEqual([]);
  });

  test('F1.7: a budget in a currency the spend is not in shows no data, not 0 % and green', async ({ page }) => {
    await page.goto('/budgets');
    await page.getByRole('button', { name: 'Add budget' }).first().click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Name').fill('Dollar budget');
    await drawer.getByLabel('Amount').fill('100');
    await drawer.getByLabel('Currency').fill('USD');
    await drawer.getByRole('button', { name: 'Save' }).click();
    const row = page.getByRole('table', { name: 'Budgets' }).getByRole('row', { name: /Dollar budget/ });
    await expect(row.getByText('No data: spend is in XTS, this budget in USD')).toHaveClass(/ne-tone-neutral/);
    await expect(row).toContainText('no data');
    await expect(row).not.toContainText('Within every threshold');
    await expect(row).toContainText("Edit the budget's currency to XTS");
    // The Overview says the same: no data and why, in grey, never "no spend reported" (85.79 XTS was reported).
    await page.goto('/');
    const tile = page.getByRole('region', { name: 'Budgets (advisory)' });
    const reason = tile.getByText('No data: spend is in XTS, this budget in USD');
    await expect(reason).toHaveClass(/ne-tone-neutral/);
    await expect(tile).not.toContainText('no spend reported');
    await expect(tile.getByRole('meter', { name: 'Budget Dollar budget' })).toHaveCount(0);
    await page.goto('/budgets');
    await row.getByRole('button', { name: 'Delete Dollar budget' }).click();
    await row.getByRole('button', { name: /Confirm: delete Dollar budget/ }).click();
    await expect(page.getByText('Deleted the budget “Dollar budget”.')).toBeVisible();
  });

  test('G4.9, G4.15, G4.16: an AI Cloud credit drawn from all spend says so on the page; used up warns; one Budgets region; date sort words', async ({ page }) => {
    await page.goto('/budgets');
    await page.getByRole('button', { name: 'Add credit' }).first().click();
    const drawer = page.getByRole('dialog');
    // G4.15: the drawer subtitle is prose, not an id.
    const subtitle = drawer.getByText('Entered by you; stored in the portal database. Nothing is sent to Nebius.');
    await expect(subtitle).not.toHaveClass(/ne-mono/);
    await drawer.getByLabel('Name').fill('G4 cloud credit');
    await drawer.getByLabel('Provider').selectOption('ai-cloud');
    await drawer.getByLabel('Amount').fill('10');
    await drawer.getByLabel('Applied on').fill('2026-10-01');
    await drawer.getByRole('button', { name: 'Save' }).click();
    const row = page.getByRole('table', { name: 'Credits' }).getByRole('row', { name: /G4 cloud credit/ });
    // The stub export marks no row x_TrialId: the draw is an assumption, said beside the figure.
    await expect(row.getByText('assumed: all spend')).toBeVisible();
    await expect(row.getByText(/marks no row as credit-funded \(x_TrialId empty\).*Check the balance in the console/)).toBeVisible();
    await expect(row.getByText('Used up', { exact: true })).toHaveClass(/ne-tone-warn/);
    // G4.16: the summary tile and the budgets table no longer share the name "Budgets" (a strict-mode collision).
    await expect(page.getByRole('region', { name: 'Budgets summary', exact: true })).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Budgets', exact: true })).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    const sort = page.getByRole('combobox', { name: 'Sort Token Factory spend entries by' });
    await expect(sort.locator('option')).toContainText(['Date, oldest first', 'Date, newest first']);
    await page.setViewportSize({ width: 1440, height: 900 });
    await row.getByRole('button', { name: 'Delete G4 cloud credit' }).click();
    await row.getByRole('button', { name: /Confirm: delete G4 cloud credit/ }).click();
    await expect(page.getByText('Deleted the credit “G4 cloud credit”.')).toBeVisible();
  });
});

test('AI services: Token Factory models and key health, Hugging Face access per workload model, Serverless', async ({ page }) => {
  await page.goto('/ai-services');
  await expect(page.getByRole('heading', { level: 1, name: 'AI services' })).toBeVisible();
  await expect(page.getByText('configured · valid').first()).toBeVisible();
  await expect(page.getByText('mock-org/mock-chat-70b')).toBeVisible();
  await expect(page.getByText('Usage and balance: console only', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the Token Factory console' })).toHaveAttribute('href', 'https://tokenfactory.nebius.com');
  await expect(page.getByText('e2e-mock-user (user)')).toBeVisible();
  const models = page.getByRole('table', { name: 'Workload models' });
  await expect(models.getByRole('row', { name: /Qwen\/Qwen2\.5-1\.5B-Instruct.*open · readable/ })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Serverless endpoints and jobs' })).toBeVisible();
});

test('integrations: Token Factory and Hugging Face are connectors with recorded health, no longer "not connected"', async ({ page }) => {
  await page.goto('/integrations');
  await expect(page.getByText('Token Factory (models, key health)').first()).toBeVisible();
  await expect(page.getByText('Hugging Face (token, gated access)').first()).toBeVisible();
  await expect(page.getByText(/Not connected: needs a Token Factory API key/)).toHaveCount(0);
});

test('costs: the tab and range fixes; commercial: the tab follows the URL', async ({ page }) => {
  await page.goto('/costs');
  await page.getByLabel('From (UTC)').fill('2026-10-20');
  await page.getByLabel('To (exclusive)').fill('2026-10-01');
  await expect(page.getByText('“To” must be after “From”.')).toBeVisible();
  await page.goto('/commercial?tab=ratebooks');
  await expect(page.getByRole('tab', { name: 'Rate books' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Scenarios & draft quotes' }).click();
  await expect(page).not.toHaveURL(/tab=ratebooks/);
  // #72: a tab that does not exist is said, as on Evidence, not dropped silently.
  await page.goto('/commercial?tab=bogus');
  await expect(page.getByText('Unknown tab “bogus”; showing Scenarios & draft quotes. Tabs: scenarios, ratebooks.')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Scenarios & draft quotes' })).toHaveAttribute('aria-selected', 'true');
});
