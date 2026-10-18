import {
  accountSummary,
  BudgetInput,
  BudgetView,
  BudgetSignal,
  budgetPeriodRange,
  budgetSignals,
  BudgetsResponse,
  budgetStatus,
  CONFIG_BUDGETS_NOTE,
  CONSOLE_LINKS,
  evaluateBudget,
  exportCadence,
  evaluateCredits,
  LivePriceResponse,
  periodWindow,
  runRateCovers,
  SpendContext,
} from '@internal/nebius-domain';
import { inScope, ProjectScope } from '../lib/access';
import { EstateConfig } from '../lib/config';
import { CommercialStore } from '../commercial/store';
import { liveRunRate } from '../commercial/livePrice';
import { InventoryService } from '../inventory/InventoryService';
import { BudgetStore } from './store';

const ALL: ProjectScope = { all: true, projects: new Set() };

type RateResult = Pick<SpendContext, 'runRate' | 'runRateUnavailable' | 'nothingRunning'>;

/**
 * Whether a caller sees (and may write) a budget: an unrestricted caller sees every budget; a
 * project-scoped caller only budgets whose project conditions are all in their scope. Budgets
 * without a project condition are account-wide and, like credits and spend entries (which carry no
 * project), only for unrestricted callers.
 */
export function budgetVisible(scope: ProjectScope, projects: readonly string[]): boolean {
  return scope.all || (projects.length > 0 && projects.every(p => inScope(scope, p)));
}

/**
 * Evaluates budgets and credits against the best spend source for each (FOCUS export rows, the live
 * run-rate since the last exported hour, Token Factory spend entered by the owner). Reads only the
 * rows of the longest period in use; prices the run-rate once per distinct project/region scope
 * (the calculator caches per spec).
 */
export class BudgetService {
  constructor(
    private readonly store: BudgetStore,
    private readonly commercial: CommercialStore,
    private readonly inventory: InventoryService,
    private readonly cfg: EstateConfig,
  ) {}

  /** `computeOnly`: a budget with a Compute service condition; the run-rate then leaves out managed databases. */
  private async runRate(scope: ProjectScope, projects: string[], regions: string[], computeOnly = false): Promise<RateResult> {
    const resources = this.inventory
      .snapshot()
      .resources.filter(r => inScope(scope, r.projectId) && (!projects.length || projects.includes(r.projectId ?? '')) && (!regions.length || regions.includes(r.region ?? '')))
      .filter(r => !computeOnly || (r.type !== 'postgresql-cluster' && r.type !== 'mlflow-cluster'));
    const r: LivePriceResponse = await liveRunRate(this.inventory, this.cfg, resources);
    // Nothing running (after an inventory read) is a fact the forecast and the projected line use (W1-P20, #69).
    if (!r.value) return { runRateUnavailable: r.unavailableReason ?? 'no live run-rate', ...(r.nothingRunning ? { nothingRunning: true } : {}) };
    if (!r.value.hourly) return { runRateUnavailable: 'the calculator priced nothing per hour for the running inventory' };
    // Running resources the calculator did not price are not in the hourly total: counted, so no figure reads as all of them.
    return { runRate: { hourly: r.value.hourly, asOf: r.value.asOf, source: r.value.source, ...(r.value.unpriced.length ? { unpriced: r.value.unpriced.length } : {}) } };
  }

  async evaluate(scope: ProjectScope = ALL, opts: { now?: Date; canEdit?: boolean } = {}): Promise<BudgetsResponse> {
    const now = opts.now ?? this.inventory.now();
    const [allBudgets, allCredits, allEntries] = await Promise.all([this.store.list('budget'), this.store.list('credit'), this.store.list('spend')]);
    // Scope first: a restricted caller never receives another project's budget, nor account-wide items.
    const budgets = allBudgets.filter(b => budgetVisible(scope, b.scope.projects));
    const credits = scope.all ? allCredits : [];
    const entries = scope.all ? allEntries : [];
    const month = periodWindow('monthly', now).start;
    const from = [month, ...budgets.map(b => periodWindow(b.period, now).start), ...credits.map(c => `${c.appliedOn}T00:00:00.000Z`)].sort()[0];
    const [rows, coverage, arrivals] = await Promise.all([this.commercial.activeRecords({ scope, from }), this.commercial.chargeSpan(scope), this.commercial.exportArrivals()]);
    const base: SpendContext = { now, rows, coverage, entries };
    const pull = this.inventory.snapshot().statuses.find(s => s.id === 'billing-object-storage');
    const nextFile = exportCadence(arrivals, now);

    const rates = new Map<string, Promise<RateResult>>();
    const rateFor = (projects: string[], regions: string[], computeOnly = false) => {
      const key = `${[...projects].sort().join(',')}|${[...regions].sort().join(',')}|${computeOnly}`;
      if (!rates.has(key)) rates.set(key, this.runRate(scope, projects, regions, computeOnly));
      return rates.get(key)!;
    };
    const account = await rateFor([], []);

    const budgetViews = await Promise.all(
      budgets.map(async b => {
        const rate = b.provider === 'ai-cloud' && runRateCovers(b.scope) ? await rateFor(b.scope.projects, b.scope.regions, b.scope.services.length > 0) : {};
        return evaluateBudget(b, { ...base, ...rate });
      }),
    );
    const creditViews = evaluateCredits(credits, { ...base, ...account });
    // Deprecated config budgets: shown read-only here (the single place budgets appear), never imported.
    const configBudgets = await Promise.all(
      this.cfg.budgets
        .filter(b => inScope(scope, b.scope.project))
        .map(async b => budgetStatus(b, await this.commercial.activeRecords({ scope, project: b.scope.project, ...budgetPeriodRange(b.period) }))),
    );
    return {
      generatedAt: now.toISOString(),
      budgets: budgetViews,
      credits: creditViews,
      entries: [...entries].sort((a, b) => b.date.localeCompare(a.date)),
      summary: accountSummary({ ...base, ...account }, budgetViews, creditViews, configBudgets),
      signals: budgetSignals({ budgets: budgetViews, credits: creditViews }, now),
      canEdit: opts.canEdit ?? false,
      scopeNote: scope.all
        ? undefined
        : `Your access covers ${scope.projects.size} project(s): only budgets limited to those projects are shown, and spend in other projects is not counted. Account-wide budgets, credits and Token Factory spend need access to every project.`,
      links: CONSOLE_LINKS,
      configBudgets,
      configBudgetsNote: configBudgets.length ? CONFIG_BUDGETS_NOTE : undefined,
      ...(pull?.health?.nextRunAt || nextFile ? { exportFreshness: { ...(pull?.health?.nextRunAt ? { nextRunAt: pull.health.nextRunAt } : {}), ...(nextFile ? { nextFile } : {}) } } : {}),
    };
  }

  /**
   * One unsaved budget evaluated as Budgets would show it (W1-P23): the drawer previews its scope's spend while the
   * amount and conditions are typed. Nothing is stored; rows outside the caller's scope are not read.
   */
  async preview(scope: ProjectScope, input: BudgetInput, now = this.inventory.now()): Promise<BudgetView> {
    const from = periodWindow(input.period, now).start;
    const [rows, coverage] = await Promise.all([this.commercial.activeRecords({ scope, from }), this.commercial.chargeSpan(scope)]);
    const entries = scope.all ? await this.store.list('spend') : [];
    const rate = input.provider === 'ai-cloud' && runRateCovers(input.scope) ? await this.runRate(scope, input.scope.projects, input.scope.regions, input.scope.services.length > 0) : {};
    return evaluateBudget({ ...input, id: 'preview', createdBy: '', updatedAt: now.toISOString() }, { now, rows, coverage, entries, ...rate });
  }

  /** How many budgets and credits are entered: a budget alert rule with none to watch says so (#65). */
  async defined(): Promise<{ budgets: number; credits: number }> {
    const [budgets, credits] = await Promise.all([this.store.list('budget'), this.store.list('credit')]);
    return { budgets: budgets.length, credits: credits.length };
  }

  /**
   * Threshold crossings and credit-expiry warnings (≤ 14 days). The alert rule engine reads them over
   * the whole account (the default); `/budgets/signals` passes the caller's scope.
   * Stable ids: `budget:<id>:threshold:<value>`, `credit:<id>:expiry`.
   */
  async signals(now?: Date, scope: ProjectScope = ALL): Promise<BudgetSignal[]> {
    return (await this.evaluate(scope, { now })).signals;
  }
}
