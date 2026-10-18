import { AuditorService } from '@backstage/backend-plugin-api';
import { ConflictError, InputError, NotAllowedError, NotFoundError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import { z } from 'zod';
import { billingReadPermission, budgetInputSchema, budgetWritePermission, spendEntryInputSchema } from '@internal/nebius-domain';
import { Access, audited, Caller } from '../lib/access';
import { parse } from '../lib/parse';
import { budgetVisible, BudgetService } from './service';
import { BudgetKind, BudgetStore } from './store';

export interface BudgetsRouterOptions {
  access: Access;
  auditor: AuditorService;
  store: BudgetStore;
  service: BudgetService;
  /**
   * Called after every budget, credit or spend-entry write, before the response (W1-P19): the alert engine re-evaluates
   * the budget signals at once. A failure there never fails the write; the next sync evaluates them again.
   */
  onChange?: (change: { deleted?: { type: 'budget' | 'credit'; id: string } }) => Promise<unknown>;
}

const KIND_PATHS: Record<string, BudgetKind> = { budget: 'budget', credit: 'credit', spend: 'spend' };
const id = z.string().uuid();

/** Zod issues as one readable 400 (the form shows it next to the fields). */
async function body<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof z.ZodError) throw new InputError(e.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
    throw e;
  }
}

/**
 * What a project-scoped caller may write: budgets whose project conditions are all in their scope.
 * Account-wide budgets, credits and spend entries (no project) need access to every project.
 * Invalid input is left to the store's validation (400).
 */
function assertWritable(caller: Caller, kind: BudgetKind, input: unknown) {
  if (caller.scope.all) return;
  if (kind !== 'budget') throw new NotAllowedError(`${kind === 'credit' ? 'credits' : 'spend entries'} are account-wide: writing them needs access to every project`);
  const parsed = budgetInputSchema.safeParse(input);
  if (!parsed.success) return;
  const projects = parsed.data.scope.projects;
  if (!projects.length) throw new NotAllowedError('an account-wide budget (no project condition) needs access to every project: name projects in your scope');
  const outside = projects.filter(p => !caller.scope.projects.has(p));
  if (outside.length) throw new NotAllowedError(`project(s) outside your scope: ${outside.join(', ')}`);
}

/**
 * Budgets & credits: GET /budgets (evaluated), GET /budgets/signals, and create / update / delete of
 * budgets, credits and Token Factory spend entries under /budgets/{budget|credit|spend}. Reading needs
 * nebius.billing.read; writing needs nebius.billing.budget.write and is audited. Both follow the
 * caller's project scope (budgetVisible): a project-scoped caller reads and writes only budgets limited
 * to its projects. Local data only: nothing is sent to Nebius or Token Factory.
 */
export function budgetsRouter(o: BudgetsRouterOptions): express.Router {
  const router = Router();
  const changed = async (change: Parameters<NonNullable<BudgetsRouterOptions['onChange']>>[0] = {}) => {
    try {
      await o.onChange?.(change);
    } catch {
      // Re-evaluated at the next sync; the write itself succeeded.
    }
  };
  // Body parser on the write routes only (64 KB): a router-wide parser would also run on every other plugin route.
  const json = express.json({ limit: '64kb' });

  router.get('/budgets', async (req, res) => {
    const caller = await o.access.require(req, billingReadPermission);
    res.json(await o.service.evaluate(caller.scope, { canEdit: await o.access.allowed(caller, budgetWritePermission) }));
  });

  router.get('/budgets/signals', async (req, res) => {
    const caller = await o.access.require(req, billingReadPermission);
    res.json({ items: await o.service.signals(undefined, caller.scope) });
  });

  /** An unsaved budget evaluated against its scope (W1-P23): reading only, in the caller's scope; nothing is stored. */
  router.post('/budgets/preview', json, async (req, res) => {
    const caller = await o.access.require(req, billingReadPermission);
    const input = await body(async () => budgetInputSchema.parse(req.body));
    if (!budgetVisible(caller.scope, input.scope.projects)) {
      throw new NotAllowedError(input.scope.projects.length ? 'a project condition outside your scope' : 'an account-wide budget (no project condition) needs access to every project');
    }
    res.json(await o.service.preview(caller.scope, input));
  });

  /**
   * One Token Factory spend entry per day (W1-P22): the Usage tab shows a day's total, so a second entry for the same
   * day would be summed silently. Refused with the entry to replace instead; the page offers the replace.
   */
  const oneEntryPerDay = async (input: unknown, exceptId?: string) => {
    const parsed = spendEntryInputSchema.safeParse(input);
    if (!parsed.success) return; // left to the store's validation (400)
    const same = (await o.store.list('spend')).find(e => e.date === parsed.data.date && e.provider === parsed.data.provider && e.id !== exceptId);
    if (same) throw new ConflictError(`A spend entry for ${same.date} exists (${same.amount} ${same.currency}, id ${same.id}): replace it instead of adding a second one.`);
  };

  /** The stored record, when the caller may see it (404 otherwise, as for an unknown id). */
  const visible = async (caller: Caller, kind: BudgetKind, rid: string) => {
    const rec = await o.store.get(kind, rid);
    const projects = rec && kind === 'budget' ? (rec as { scope: { projects: string[] } }).scope.projects : [];
    if (!rec || !(caller.scope.all || (kind === 'budget' && budgetVisible(caller.scope, projects)))) throw new NotFoundError(`${kind} ${rid} not found or not in your scope`);
  };

  router.post('/budgets/:kind', json, async (req, res) => {
    const kind = parse(z.enum(['budget', 'credit', 'spend']), req.params.kind);
    const caller = await o.access.require(req, budgetWritePermission);
    assertWritable(caller, KIND_PATHS[kind], req.body);
    if (kind === 'spend') await oneEntryPerDay(req.body);
    const rec = await audited(o.auditor, req, `budgets-${kind}-create`, {}, () => body(() => o.store.create(KIND_PATHS[kind], req.body, caller.userEntityRef)));
    await changed();
    res.status(201).json(rec);
  });

  router.put('/budgets/:kind/:id', json, async (req, res) => {
    const kind = parse(z.enum(['budget', 'credit', 'spend']), req.params.kind);
    const rid = parse(id, req.params.id);
    const caller = await o.access.require(req, budgetWritePermission);
    await visible(caller, KIND_PATHS[kind], rid);
    assertWritable(caller, KIND_PATHS[kind], req.body);
    if (kind === 'spend') await oneEntryPerDay(req.body, rid);
    const rec = await audited(o.auditor, req, `budgets-${kind}-update`, { id: rid }, () => body(() => o.store.update(KIND_PATHS[kind], rid, req.body, caller.userEntityRef)));
    await changed();
    res.json(rec);
  });

  router.delete('/budgets/:kind/:id', async (req, res) => {
    const kind = parse(z.enum(['budget', 'credit', 'spend']), req.params.kind);
    const rid = parse(id, req.params.id);
    const caller = await o.access.require(req, budgetWritePermission);
    await visible(caller, KIND_PATHS[kind], rid);
    await audited(o.auditor, req, `budgets-${kind}-delete`, { id: rid }, () => o.store.remove(KIND_PATHS[kind], rid));
    const k = KIND_PATHS[kind];
    await changed(k === 'spend' ? {} : { deleted: { type: k, id: rid } });
    res.status(204).end();
  });

  return router;
}
