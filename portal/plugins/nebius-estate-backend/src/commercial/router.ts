import { AuditorService } from '@backstage/backend-plugin-api';
import { ConflictError, InputError, NotAllowedError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import { z } from 'zod';
import {
  aggregateCosts,
  attributedProject,
  billingImportPermission,
  BillingSummaryResponse,
  billingReadPermission,
  BuiltInPriceSource,
  COST_METRIC_DESCRIPTIONS,
  COST_METRICS,
  CostDimension,
  commercialRateReadPermission,
  commercialRateWritePermission,
  estimateRunRate,
  estimateScenario,
  exportCadence,
  exportedThrough,
  exportHealth,
  footprintSchema,
  globalFilterSchema,
  LIVE_LIST_BOOK_ID,
  LIVE_LIST_BOOK_NAME,
  rateBookCsvTemplate,
  normalizeFocusCsv,
  quoteDocument,
  quoteToCsvRows,
  RateBook,
  RateBookChoice,
  RateBookSummary,
  rateBookSchema,
  RunRateResponse,
  scenarioReadPermission,
  scenarioSchema,
  scenarioWritePermission,
  spansMoreThanADay,
  toCsv,
} from '@internal/nebius-domain';
import { Access, audited, Caller, inScope } from '../lib/access';
import { takeOrThrow, TokenBucketLimiter } from '../lib/limits';
import { EstateConfig } from '../lib/config';
import { parse } from '../lib/parse';
import { InventoryService } from '../inventory/InventoryService';
import { BillingQuery, CommercialStore } from './store';
import { livePrice, liveRunRate } from './livePrice';
import { buildListPriceBook, liveListBook } from './listPriceBook';

export interface CommercialRouterOptions {
  cfg: EstateConfig;
  access: Access;
  auditor: AuditorService;
  store: CommercialStore;
  inventory: InventoryService;
  /** The JSON body parser of these routes (2 MB), applied per route. */
  json: express.RequestHandler;
  /** Per-user limit of the calculator-backed routes (shared with /provisioning/live-price). */
  priceLimiter: TokenBucketLimiter;
  /** platform/regions.yaml: each region's platforms and their known presets (for books from list prices). */
  regions: () => Promise<Record<string, { platforms: Record<string, { single_gpu_preset?: string; ib_preset?: string }> }>>;
}

const toIso = (d?: string) => (d && d.length === 10 ? `${d}T00:00:00.000Z` : d);

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/);
const summaryQuery = globalFilterSchema.pick({ project: true, region: true }).extend({
  metric: z.enum(COST_METRICS).default('BilledCost'),
  dimension: z
    .string()
    .regex(/^(project|service|region|resource|chargeCategory|day|label:nip-[a-z-]{1,30})$/)
    .default('project'),
  from: day.optional(),
  to: day.optional(),
  service: z.string().max(80).optional(),
}).refine(q => !q.from || !q.to || toIso(q.from)! < toIso(q.to)!, { path: ['to'], message: '"to" must be after "from" (the range is [from, to), UTC)' });

/** Rate-book and scenario ids in URLs (also used in download file names). */
const idParam = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/, 'an id of letters, digits and dashes');


/**
 * FOCUS billing reports and imports, rate books, scenarios, draft quotes and
 * the inventory run-rate. Mounted on the plugin router.
 */
export function commercialRouter(o: CommercialRouterOptions): express.Router {
  const { access, store, cfg, inventory } = o;
  const router = Router();

  /** nip-* labels by provider id from the current inventory, for the billing label join. */
  const labels = () => {
    const out = new Map<string, Record<string, string>>();
    for (const r of inventory.snapshot().resources) {
      const nip = Object.fromEntries(Object.entries(r.labels).filter(([k]) => k.startsWith('nip-')));
      if (Object.keys(nip).length) out.set(r.providerId, nip);
    }
    return (id: string) => out.get(id);
  };

  /** The rate book the run-rate uses, said with its reason (G4.5). */
  const runRateBook = async (requested?: string): Promise<{ book?: RateBook; choice?: RateBookChoice }> => {
    if (requested) {
      const book = await store.book(requested);
      return { book, choice: { id: book.id, name: book.name, how: 'requested', text: 'The rate book chosen for this request.' } };
    }
    const c = await store.defaultBookChoice(cfg.commercial.defaultRateBook);
    if (!c.book) return {};
    const text = {
      configured: 'Set in the configuration (nebiusEstate.commercial.defaultRateBook).',
      'portal-default': 'Set as the portal default on Commercial → Rate books (stored in the portal database).',
      only: 'The only active rate book. Set it as the portal default (Rate books) to keep this choice when another is imported.',
      'first-by-id': `No default is set (Rate books → Set as portal default, or nebiusEstate.commercial.defaultRateBook): the first of ${c.count} active rate books by id, so importing, archiving or deleting a book can change it.`,
    }[c.how];
    return { book: c.book, choice: { id: c.book.id, name: c.book.name, how: c.how, text } };
  };

  const report = async (caller: Caller, q: z.infer<typeof summaryQuery>) => {
    const query: BillingQuery = { scope: caller.scope, project: q.project, region: q.region, service: q.service, from: toIso(q.from), to: toIso(q.to) };
    return aggregateCosts(await store.activeRecords(query), q.metric, q.dimension as CostDimension, {}, q.dimension.startsWith('label:') ? labels() : undefined);
  };

  /* ------------------------------------------------------------- run-rate */

  router.get('/runrate', async (req, res) => {
    const caller = await access.require(req, commercialRateReadPermission);
    const q = parse(globalFilterSchema.extend({ rateBookId: idParam.optional() }), req.query);
    const { book, choice } = await runRateBook(q.rateBookId);
    if (!book) {
      const body: RunRateResponse = {
        value: null,
        unavailableReason: cfg.commercial.defaultRateBook
          ? `The configured default rate book ${cfg.commercial.defaultRateBook} is not imported.`
          : (await store.bookStates()).size
            ? 'Every rate book is archived: restore one on Commercial → Rate books (an archived book cannot be the portal default).'
            : 'No rate book has been imported.',
        // With the live list price available (the live run-rate), a user rate book is optional: not a gap to set up.
        ...(!cfg.commercial.defaultRateBook && inventory.calculator() ? { rateBookOptional: true } : {}),
      };
      res.json(body);
      return;
    }
    const snap = inventory.snapshot();
    const resources = snap.resources.filter(
      r =>
        inScope(caller.scope, r.projectId) &&
        (!q.project || r.projectId === q.project) &&
        (!q.region || r.region === q.region) &&
        (!q.stage || r.labels['nip-stage'] === q.stage),
    );
    const body: RunRateResponse = { value: estimateRunRate(resources, book, inventory.now().toISOString().slice(0, 10), { inventoryReadAt: snap.inventoryReadAt }), observedAt: snap.observedAt, rateBookChoice: choice };
    res.json(body);
  });

  /** Running inventory in scope at Nebius list price (billing calculator), project by project. */
  router.get('/runrate/live', async (req, res) => {
    const caller = await access.require(req, commercialRateReadPermission);
    takeOrThrow(o.priceLimiter, caller.userEntityRef, res);
    const q = parse(globalFilterSchema, req.query);
    const resources = inventory.snapshot().resources.filter(
      r => inScope(caller.scope, r.projectId) && (!q.project || r.projectId === q.project) && (!q.region || r.region === q.region) && (!q.stage || r.labels['nip-stage'] === q.stage),
    );
    res.json(await liveRunRate(inventory, cfg, resources));
  });

  /** A footprint (e.g. a scenario's expected one) at Nebius list price. */
  router.post('/pricing/footprint', o.json, async (req, res) => {
    const caller = await access.require(req, scenarioReadPermission, commercialRateReadPermission);
    takeOrThrow(o.priceLimiter, caller.userEntityRef, res);
    const body = parse(z.object({ footprint: footprintSchema, region: globalFilterSchema.shape.region, capacityType: z.enum(['on-demand', 'reserved', 'preemptible']).optional() }), req.body);
    res.json(await livePrice(inventory, cfg, body.footprint, body.region, body.capacityType, caller.scope));
  });

  /* -------------------------------------------------------------- billing */

  router.get('/billing/summary', async (req, res) => {
    const caller = await access.require(req, billingReadPermission);
    const q = parse(summaryQuery, req.query);
    // The totals, the daily chart and the reporting period follow the project, region and date range. Lag,
    // "exported through" and coverage describe the export as a whole (every row the caller may see): a filtered
    // project's last usage is not the export's freshness (G1.3), and is returned apart as selectionLastUsage.
    const selection: BillingQuery = { scope: caller.scope, project: q.project, region: q.region };
    const ranged: BillingQuery = { ...selection, from: toIso(q.from), to: toIso(q.to) };
    const narrowed = Boolean(q.from || q.to);
    const selected = Boolean(q.project || q.region);
    const [active, overall, selectionRows, counts, countsAnyRange, countsAll, arrivals] = await Promise.all([
      store.activeRecords(ranged),
      narrowed || selected ? store.activeRecords({ scope: caller.scope }) : undefined,
      selected && narrowed ? store.activeRecords(selection) : undefined,
      store.storedCounts(ranged),
      narrowed ? store.storedCounts(selection) : undefined,
      selected ? store.storedCounts({ scope: caller.scope }) : undefined,
      store.exportArrivals(),
    ]);
    const nextFile = exportCadence(arrivals, inventory.now());
    const health = exportHealth(active, counts, inventory.now());
    const whole = overall ? exportHealth(overall, { rows: 0, imports: 0 }, inventory.now()) : undefined;
    const selectionLastUsage = selected ? exportedThrough(selectionRows ?? active) : undefined;
    const pull = inventory.snapshot().statuses.find(s => s.id === 'billing-object-storage');
    // A month-long row (tax) belongs to no single day: left off the day axis, counted and said (G4.10).
    const long = active.filter(spansMoreThanADay);
    const longReport = long.length ? aggregateCosts(long, q.metric, 'chargeCategory') : undefined;
    const body: BillingSummaryResponse = {
      report: await report(caller, q),
      daily: aggregateCosts(long.length ? active.filter(r => !spansMoreThanADay(r)) : active, q.metric, 'day'),
      ...(longReport ? { dailyExcluded: { rows: long.length, totals: longReport.totals, categories: [...new Set(long.map(r => r.chargeCategory || '(none)'))].sort() } } : {}),
      metricDescription: COST_METRIC_DESCRIPTIONS[q.metric],
      health: whole ? { ...health, lagHours: whole.lagHours, exportedThrough: whole.exportedThrough, firstUsageHour: whole.firstUsageHour, coverage: whole.coverage } : health,
      // The reporting period ends with the last hour of the rows shown (selection and range), not the export's (G4.2).
      ...(health.exportedThrough ? { periodThrough: health.exportedThrough } : {}),
      rowsAnyRange: (countsAnyRange ?? counts).rows,
      importedRows: (countsAll ?? countsAnyRange ?? counts).rows,
      ...(selected ? { selectionLastUsage } : {}),
      exportPull: pull
        ? { state: pull.state, scope: pull.scope, lastSuccess: pull.lastSuccess, note: pull.missingCoverage[0] ?? pull.error, ...(pull.health?.nextRunAt ? { nextRunAt: pull.health.nextRunAt } : {}), ...(nextFile ? { nextFile } : {}) }
        : undefined,
      kind: 'reported',
      note: 'Reported cost from imported billing exports. Not a forecast, not an invoice reconciliation.',
    };
    res.json(body);
  });

  router.get('/billing/export.csv', async (req, res) => {
    const caller = await access.require(req, billingReadPermission);
    const q = parse(summaryQuery, req.query);
    const r = await report(caller, q);
    const rows = r.groups.flatMap(g => g.totals.map(t => [g.label, q.metric, t.amount, t.currency, g.rows, g.unattributed ? 'yes' : 'no']));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nebius-cost-${q.dimension.replace(/[^a-z-]/g, '-')}-${q.metric}.csv"`);
    res.send(toCsv([q.dimension, 'metric', 'amount', 'currency', 'rows', 'unattributed'], rows));
  });

  router.get('/billing/imports', async (req, res) => {
    const caller = await access.require(req, billingReadPermission);
    res.json({ items: await store.imports(caller.scope) });
  });

  router.post(
    '/billing/imports',
    // Authorize before the body is read, so only importers can send a large upload.
    async (req, res, next) => {
      res.locals.caller = await access.require(req, billingImportPermission);
      next();
    },
    express.text({ type: ['text/csv', 'text/plain'], limit: cfg.billing.maxImportBytes }),
    async (req, res) => {
      const caller: Caller = res.locals.caller;
      if (typeof req.body !== 'string' || !req.body.length) throw new InputError('send the FOCUS CSV as the request body (Content-Type: text/csv)');
      const filename = parse(z.string().max(120).regex(/^[A-Za-z0-9._ -]+$/).default('upload.csv'), req.query.filename);
      let normalized: ReturnType<typeof normalizeFocusCsv>;
      try {
        normalized = normalizeFocusCsv(req.body);
      } catch (e) {
        throw new InputError(`not a readable FOCUS CSV: ${(e as Error).message}`);
      }
      if (normalized.missingColumns.length) throw new InputError(`not a FOCUS export: missing ${normalized.missingColumns.join(', ')}`);
      // Both project columns are checked: the attributed project (scope, reports, supersession slot) and the container.
      const outOfScope = normalized.records.filter(
        r => !inScope(caller.scope, attributedProject(r).id || undefined) || (r.containerId !== '' && !inScope(caller.scope, r.containerId)) || (r.projectId !== '' && !inScope(caller.scope, r.projectId)),
      );
      if (outOfScope.length) throw new NotAllowedError(`${outOfScope.length} rows belong to projects outside your scope`);
      const result = await audited(o.auditor, req, 'billing-import', { filename, rows: normalized.records.length }, () =>
        store.importRecords({ importedBy: caller.userEntityRef, filename, importedAt: new Date().toISOString() }, normalized),
      );
      res.status(201).json(result);
    },
  );

  /* ----------------------------------------------------------- rate books */

  router.get('/ratebooks', async (req, res) => {
    await access.require(req, commercialRateReadPermission);
    const states = await store.bookStates();
    const items: RateBookSummary[] = (await store.books()).map(b => ({
      id: b.id,
      name: b.name,
      kind: b.kind,
      classification: b.classification,
      currency: b.currency,
      entries: b.entries.length,
      discountRules: b.discountRules,
      note: b.note,
      archived: states.get(b.id)?.archived ?? false,
      isDefault: states.get(b.id)?.isDefault ?? false,
    }));
    const builtIn: BuiltInPriceSource = {
      id: LIVE_LIST_BOOK_ID,
      name: LIVE_LIST_BOOK_NAME,
      currency: (cfg.nebius?.pricing.currency ?? 'usd').toUpperCase(),
      available: Boolean(inventory.calculator()),
      ...(inventory.calculator() ? {} : { reason: 'Live list prices need the Nebius connector: projects and a read-only identity (docs/portal/nebius-setup.md).' }),
    };
    res.json({ items, runRateBook: (await runRateBook()).choice, builtIn });
  });

  /** The CSV template for a rate book (W1-P7): the columns and two example rows in the test currency. */
  router.get('/ratebooks/template.csv', async (req, res) => {
    await access.require(req, commercialRateReadPermission);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="rate-book-template.csv"');
    res.send(rateBookCsvTemplate());
  });

  /**
   * A rate book from current list prices, for a preview (W1-P7): the presets platform/regions.yaml names for each
   * region (optionally only some platforms) and the storage specs, priced by the billing calculator. Not stored: the
   * page shows it and saves it through PUT /ratebooks/:id.
   */
  router.post('/ratebooks/from-list-prices', o.json, async (req, res) => {
    const caller = await access.require(req, commercialRateWritePermission);
    takeOrThrow(o.priceLimiter, caller.userEntityRef, res);
    const body = parse(
      z.object({ id: rateBookSchema.shape.id, name: rateBookSchema.shape.name, regions: z.array(globalFilterSchema.shape.region.unwrap()).min(1).max(10), platforms: z.array(z.string().max(64)).max(20).optional() }),
      req.body,
    );
    if (body.id === LIVE_LIST_BOOK_ID) throw new InputError(`${LIVE_LIST_BOOK_ID} is the built-in live price source; pick another id`);
    const model = await o.regions();
    const unknown = body.regions.filter(r => !model[r]);
    const regions = body.regions
      .filter(r => model[r])
      .map(region => ({
        region,
        presets: Object.entries(model[region].platforms)
          .filter(([p]) => !body.platforms?.length || body.platforms.includes(p))
          .flatMap(([platform, p]) => [...new Set([p.single_gpu_preset, p.ib_preset].filter((x): x is string => Boolean(x)))].map(preset => ({ platform, preset }))),
      }));
    try {
      const r = await buildListPriceBook(inventory, cfg, { id: body.id, name: body.name, regions }, caller.scope);
      res.json({ book: r.book, skipped: [...unknown.map(u => `${u}: not in platform/regions.yaml`), ...r.skipped] });
    } catch (e) {
      throw new ConflictError(`list prices unavailable: ${(e as Error).message}`);
    }
  });

  router.get('/ratebooks/:id', async (req, res) => {
    await access.require(req, commercialRateReadPermission);
    res.json(await store.book(parse(idParam, req.params.id)));
  });

  router.put('/ratebooks/:id', o.json, async (req, res) => {
    const caller = await access.require(req, commercialRateWritePermission);
    const id = parse(idParam, req.params.id);
    const book = parse(rateBookSchema, req.body);
    if (book.id !== id) throw new InputError('rate book id does not match the URL');
    if (id === LIVE_LIST_BOOK_ID) throw new InputError(`${LIVE_LIST_BOOK_ID} is the built-in live price source and cannot be replaced; pick another id`);
    res.json(await audited(o.auditor, req, 'ratebook-write', { id: book.id, classification: book.classification, entries: book.entries.length }, () => store.putBook(book, caller.userEntityRef)));
  });

  /**
   * Deletes a rate book (G4.5). Refused while a scenario prices with it (its draft quotes would break) or while it is
   * the configured default (the run-rate and provisioning estimates would go unavailable without saying why).
   */
  router.delete('/ratebooks/:id', async (req, res) => {
    await access.require(req, commercialRateWritePermission);
    const id = parse(idParam, req.params.id);
    await store.book(id); // 404 first
    if (cfg.commercial.defaultRateBook === id) {
      throw new ConflictError(`rate book ${id} is the configured default (nebiusEstate.commercial.defaultRateBook): change the configuration first`);
    }
    if ((await store.bookStates()).get(id)?.isDefault) throw new ConflictError(`rate book ${id} is the portal default: unset it first (Rate books)`);
    const users = (await store.scenarios()).filter(sc => sc.rateBookId === id);
    if (users.length) {
      throw new ConflictError(`rate book ${id} prices ${users.length} scenario${users.length === 1 ? '' : 's'} (${users.slice(0, 5).map(sc => sc.name).join(', ')}${users.length > 5 ? ', …' : ''}): move or delete ${users.length === 1 ? 'it' : 'them'} first`);
    }
    await audited(o.auditor, req, 'ratebook-delete', { id }, () => store.deleteBook(id));
    res.status(204).end();
  });

  /**
   * Archive or restore a rate book (W1-P8): an archived book stays readable and keeps pricing its scenarios, but is
   * never a default and is not offered for a new scenario. The default (configured or portal) is not archived.
   */
  router.post('/ratebooks/:id/archive', o.json, async (req, res) => {
    await access.require(req, commercialRateWritePermission);
    const id = parse(idParam, req.params.id);
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    await store.book(id); // 404 first
    if (archived && cfg.commercial.defaultRateBook === id) throw new ConflictError(`rate book ${id} is the configured default (nebiusEstate.commercial.defaultRateBook): change the configuration first`);
    if (archived && (await store.bookStates()).get(id)?.isDefault) throw new ConflictError(`rate book ${id} is the portal default: unset it first`);
    await audited(o.auditor, req, archived ? 'ratebook-archive' : 'ratebook-restore', { id }, () => store.setArchived(id, archived));
    res.json({ id, archived });
  });

  /** The portal default rate book, stored in the database (W1-P8); a configured default still wins and is said so. */
  router.post('/ratebooks/:id/default', async (req, res) => {
    await access.require(req, commercialRateWritePermission);
    const id = parse(idParam, req.params.id);
    await store.book(id); // 404 first
    if ((await store.bookStates()).get(id)?.archived) throw new ConflictError(`rate book ${id} is archived: restore it first`);
    await audited(o.auditor, req, 'ratebook-default', { id }, () => store.setDefault(id));
    res.json({ id, isDefault: true, overriddenBy: cfg.commercial.defaultRateBook });
  });

  router.delete('/ratebooks/:id/default', async (req, res) => {
    await access.require(req, commercialRateWritePermission);
    const id = parse(idParam, req.params.id);
    if (!(await store.bookStates()).get(id)?.isDefault) throw new ConflictError(`rate book ${id} is not the portal default`);
    await audited(o.auditor, req, 'ratebook-default-unset', { id }, () => store.setDefault(undefined));
    res.json({ id, isDefault: false });
  });

  /* ------------------------------------------------------------ scenarios */

  /** The built-in price source for a scenario (W1-P6): its own presets at the calculator's list price in its region. */
  const scenarioListBook = async (s: z.infer<typeof scenarioSchema>, caller: Caller) => {
    try {
      return await liveListBook(inventory, cfg, s.region, [s.footprints.min, s.footprints.expected, s.footprints.max], s.capacityType, caller.scope);
    } catch (e) {
      throw new ConflictError(`the live list price is unavailable: ${(e as Error).message}`);
    }
  };

  /** Estimates on the portal clock. */
  const estimate = async (caller: Caller, body: unknown, res: express.Response) => {
    const s = parse(scenarioSchema, body);
    if (s.rateBookId === LIVE_LIST_BOOK_ID) {
      takeOrThrow(o.priceLimiter, caller.userEntityRef, res);
      return estimateScenario(s, await scenarioListBook(s, caller), inventory.now());
    }
    return estimateScenario(s, await store.book(s.rateBookId), inventory.now());
  };

  router.post('/estimate', o.json, async (req, res) => {
    const caller = await access.require(req, scenarioReadPermission, commercialRateReadPermission);
    res.json(await estimate(caller, req.body, res));
  });

  router.get('/scenarios', async (req, res) => {
    await access.require(req, scenarioReadPermission);
    res.json({ items: await store.scenarios() });
  });

  router.get('/scenarios/:id', async (req, res) => {
    await access.require(req, scenarioReadPermission);
    res.json(await store.scenario(parse(idParam, req.params.id)));
  });

  router.post('/scenarios', o.json, async (req, res) => {
    const caller = await access.require(req, scenarioWritePermission);
    const s = parse(scenarioSchema, req.body);
    res.status(201).json(await audited(o.auditor, req, 'scenario-write', { name: s.name }, () => store.putScenario({ ...s, id: undefined }, caller.userEntityRef)));
  });

  router.put('/scenarios/:id', o.json, async (req, res) => {
    const caller = await access.require(req, scenarioWritePermission);
    const id = parse(idParam, req.params.id);
    await store.scenario(id);
    const s = parse(scenarioSchema, req.body);
    res.json(await audited(o.auditor, req, 'scenario-write', { id }, () => store.putScenario({ ...s, id }, caller.userEntityRef)));
  });

  router.delete('/scenarios/:id', async (req, res) => {
    await access.require(req, scenarioWritePermission);
    const id = parse(idParam, req.params.id);
    await audited(o.auditor, req, 'scenario-delete', { id }, () => store.deleteScenario(id));
    res.status(204).end();
  });

  router.get('/scenarios/:id/quote.:format', async (req, res) => {
    const caller = await access.require(req, scenarioReadPermission, commercialRateReadPermission);
    const format = parse(z.enum(['json', 'csv']), req.params.format);
    const id = parse(idParam, req.params.id);
    const e = await estimate(caller, await store.scenario(id), res);
    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="draft-quote-${id}.json"`);
      res.json(quoteDocument(e));
      return;
    }
    const { header, rows } = quoteToCsvRows(e);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="draft-quote-${id}.csv"`);
    res.send(`# ${e.label}\n# rate book: ${e.rateBook.name} (${e.rateBook.kind}); as of ${e.asOf}; valid until ${e.validUntil}\n${toCsv(header, rows)}`);
  });

  return router;
}
