import { AuditorService } from '@backstage/backend-plugin-api';
import { ConflictError, InputError, NotAllowedError, NotFoundError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import { z } from 'zod';
import {
  aggregateHistory,
  HISTORY_NOTE,
  CAPABILITY_MATRIX,
  commercialRateReadPermission,
  estateReadPermission,
  estimateScenario,
  EvidenceResponse,
  FilterOptions,
  globalFilterSchema,
  HistoryResponse,
  integrationAdminPermission,
  IntegrationsResponse,
  Meta,
  nebiusPermissions,
  PreviewResponse,
  previewChange,
  previewToPatch,
  provisioningPreviewPermission,
  provisioningRequestPermission,
  provisioningRequestSchema,
  RECIPE_DEFINITIONS,
  RecipesResponse,
  recipeById,
  recipeStages,
  scenarioFromProvisioning,
  sizingFilePath,
  SyncResponse,
  telemetryReadPermission,
  validateProvisioningRequest,
} from '@internal/nebius-domain';
import { Access, audited, inScope } from './lib/access';
import { takeOrThrow, TokenBucketLimiter } from './lib/limits';
import { EstateConfig, testEndpointKeys } from './lib/config';
import { parse } from './lib/parse';
import { CommercialStore } from './commercial/store';
import { commercialRouter } from './commercial/router';
import { InventoryService } from './inventory/InventoryService';
import { MANUAL_SYNC_COOLDOWN_MS } from './inventory/fastSync';
import { decisionIndex, evidenceIndex, runbookIndex } from './repo/evidence';
import { solutionsIndex } from './repo/solutions';
import { NebiusDocs } from './repo/nebiusDocs';
import { isAllowedRepoPath, PathNotAllowedError, RepoReader } from './repo/RepoReader';
import { fitsElsewhere, reservationCheck } from './provisioning/checks';
import { ProvisioningStore } from './provisioning/store';
import { HistoryStore } from './history/HistoryStore';
import { availabilityFor, capacity, emptyScopeReason, presentStages, graph, liveIssues, narrowSnapshot, overview, resourceList, resourceViews, scopeSnapshot, soperatorClusterIds, workloads, quotaCheckFor } from './views';
import { livePrice } from './commercial/livePrice';
import { liveListBook } from './commercial/listPriceBook';

export interface RouterOptions {
  cfg: EstateConfig;
  access: Access;
  auditor: AuditorService;
  inventory: InventoryService;
  repo: RepoReader;
  store: ProvisioningStore;
  history: HistoryStore;
  commercial: CommercialStore;
  priceLimiter: TokenBucketLimiter;
}

const filterSchema = globalFilterSchema.extend({
  type: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  q: z.string().max(120).optional(),
  attribution: z.enum(['attributed', 'unattributed']).optional(),
});

/** The documented JSON body limit of the estate, provisioning and commercial routes. */
export const JSON_LIMIT = '2mb';

export async function createRouter(o: RouterOptions): Promise<express.Router> {
  const { access, inventory, repo, store, cfg } = o;
  const nebiusDocs = new NebiusDocs(repo);
  const router = Router();
  // JSON bodies ≤ 2 MB, parsed per route (not router-wide), so each router keeps its own limit.
  const json = express.json({ limit: JSON_LIMIT });
  // Live prices call the Nebius billing calculator: one token bucket per user across those routes.
  const priceLimiter = o.priceLimiter;

  const scoped = async (req: express.Request) => {
    const caller = await access.require(req, estateReadPermission);
    return { caller, snap: scopeSnapshot(inventory.snapshot(), caller.scope) };
  };
  /** Scope first, then the global project / region / stage filter from the query string. */
  const filtered = async (req: express.Request) => {
    const { caller, snap } = await scoped(req);
    const f = parse(filterSchema, req.query);
    return { caller, f, snap: narrowSnapshot(snap, f), unfiltered: snap };
  };

  const testEndpoints = testEndpointKeys(cfg);
  router.get('/meta', async (req, res) => {
    const caller = await access.caller(req);
    const body: Meta = {
      user: caller.userEntityRef,
      scope: caller.scope.all ? ['*'] : [...caller.scope.projects],
      permissions: await access.allowedMap(caller, nebiusPermissions),
      ...(testEndpoints.length ? { testData: { endpoints: testEndpoints } } : {}),
    };
    res.json(body);
  });

  /** Options for the global filter, from the caller's scoped inventory and platform/stages.yaml. */
  router.get('/filters', async (req, res) => {
    const { snap } = await scoped(req);
    const model = await repo.model();
    const body: FilterOptions = {
      projects: snap.resources.filter(r => r.type === 'project').map(r => ({ id: r.providerId, name: r.name })),
      regions: [...new Set(snap.resources.map(r => r.region).filter((x): x is string => Boolean(x)))].sort(),
      // Only stages some resource carries (a filter that matches nothing is not offered); all when nothing is read yet.
      stages: presentStages(snap.resources, Object.keys(model.stages.stages)),
      // #32: before the first inventory sync the lists are empty, not the caller's scope.
      ...(inventory.snapshot().statuses.find(s => s.id === 'nebius-inventory')?.state === 'starting' ? { pending: true as const } : {}),
    };
    res.json(body);
  });

  router.get('/overview', async (req, res) => {
    const { caller, snap, f, unfiltered } = await filtered(req);
    const [telemetryAllowed, previewAllowed] = await Promise.all([
      access.allowed(caller, telemetryReadPermission),
      access.allowed(caller, provisioningPreviewPermission),
    ]);
    res.json(
      overview(snap, await repo.model(), inventory.now(), {
        telemetryAllowed,
        pendingRequests: previewAllowed ? await store.countOpen() : null,
        emptyScope: emptyScopeReason(unfiltered, snap, f),
        filter: f,
        all: unfiltered.resources,
        allQuotas: unfiltered.capacity.quotas,
      }),
    );
  });

  router.get('/resources', async (req, res) => {
    const { snap } = await scoped(req);
    res.json(resourceList(snap, await repo.model(), inventory.now(), parse(filterSchema, req.query)));
  });

  router.get('/resources/:uid', async (req, res) => {
    const { snap } = await scoped(req);
    const uid = parse(z.string().max(300), req.params.uid);
    const r = snap.resources.find(x => x.uid === uid);
    if (!r) throw new NotFoundError('resource not found or not in your scope');
    const [view] = resourceViews([r], await repo.model(), inventory.now(), { all: snap.resources, orphanStreaks: snap.orphanStreaks, inventoryReadAt: snap.inventoryReadAt });
    const related = snap.resources.flatMap(x => [
      ...r.refs.filter(ref => ref.target === x.providerId).map(ref => ({ uid: x.uid, name: x.name, type: x.type, relation: ref.relation, direction: 'out' as const })),
      ...x.refs.filter(ref => ref.target === r.providerId).map(ref => ({ uid: x.uid, name: x.name, type: x.type, relation: ref.relation, direction: 'in' as const })),
    ]);
    res.json({ ...view, related });
  });

  router.get('/graph', async (req, res) => {
    const { snap } = await scoped(req);
    res.json(graph(snap, parse(filterSchema, req.query)));
  });

  /** Daily history for the caller's scope and the global filter (gaps stay gaps). */
  router.get('/history', async (req, res) => {
    const { caller, f } = await filtered(req);
    const days = parse(z.coerce.number().int().min(2).max(400).default(30), req.query.days);
    const since = new Date(inventory.now().getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = (await o.history.since(since)).filter(r => inScope(caller.scope, r.projectId));
    const telemetryAllowed = await access.allowed(caller, telemetryReadPermission);
    const body: HistoryResponse = {
      days,
      points: aggregateHistory(rows, f).map(point => telemetryAllowed ? point : { ...point, gpuUtilMean: null }),
      source: 'Daily snapshots recorded by this portal at each sync',
      note: HISTORY_NOTE,
    };
    res.json(body);
  });

  router.get('/capacity', async (req, res) => {
    const { caller, snap, f, unfiltered } = await filtered(req);
    res.json(capacity(snap, await access.allowed(caller, telemetryReadPermission), { repo: await repo.model(), filter: f, all: unfiltered.resources, allQuotas: unfiltered.capacity.quotas, allBlockGroups: unfiltered.capacity.capacityBlockGroups, emptyScope: emptyScopeReason(unfiltered, snap, f) }));
  });

  router.get('/workloads', async (req, res) => {
    const { snap } = await filtered(req);
    res.json(workloads(snap));
  });

  router.get('/repo', async (req, res) => {
    await access.require(req, estateReadPermission);
    res.json(await repo.model());
  });

  router.get('/evidence', async (req, res) => {
    await access.require(req, estateReadPermission);
    const body: EvidenceResponse = {
      items: await evidenceIndex(repo),
      runbooks: await runbookIndex(repo),
      decisions: await decisionIndex(repo),
      recipes: (await repo.model()).recipes,
    };
    res.json(body);
  });

  /** Solutions S1–S9 (solutions/README.md), each with its composed recipes, status and footprints to price. */
  router.get('/solutions', async (req, res) => {
    await access.require(req, estateReadPermission);
    res.json(await solutionsIndex(repo));
  });

  router.get('/document', async (req, res) => {
    await access.require(req, estateReadPermission);
    const path = parse(z.string().max(200), req.query.path);
    if (!isAllowedRepoPath(path)) throw new NotAllowedError('document not readable through the portal');
    try {
      res.json({ path, markdown: await repo.read(path) });
    } catch (e) {
      if (e instanceof PathNotAllowedError) throw new NotAllowedError(e.message);
      throw new NotFoundError(`document ${path} not found`);
    }
  });

  /** The Nebius docs catalog, for the Nebius docs page and the docs coverage on Integrations (#11, W1-P26). */
  router.get('/nebius-docs', async (req, res) => {
    await access.require(req, estateReadPermission);
    res.json(await nebiusDocs.index());
  });

  /** One catalogued docs page, with the local mirror's Markdown when present. Only paths the catalog lists. */
  router.get('/nebius-docs/page', async (req, res) => {
    await access.require(req, estateReadPermission);
    const path = parse(z.string().max(200).regex(/^\/[a-z0-9/_.-]*$/), req.query.path);
    const page = await nebiusDocs.page(path);
    if (!page) throw new NotFoundError(`${path} is not in the Nebius docs catalog`);
    res.json(page);
  });

  router.get('/integrations', async (req, res) => {
    const caller = await access.require(req, estateReadPermission);
    const snap = scopeSnapshot(inventory.snapshot(), caller.scope);
    const body: IntegrationsResponse = {
      statuses: snap.statuses,
      capabilities: snap.capabilities,
      unconfiguredProjects: caller.scope.all ? inventory.snapshot().unconfiguredProjects : undefined,
      coverage: snap.coverage,
      matrix: CAPABILITY_MATRIX,
      canAdminister: await access.allowed(caller, integrationAdminPermission),
      soperatorClusterIds: soperatorClusterIds(snap),
    };
    res.json(body);
  });

  router.post('/integrations/:id/sync', json, async (req, res) => {
    await access.require(req, integrationAdminPermission);
    const id = parse(z.string().regex(/^[a-z0-9:-]{1,80}$/), req.params.id);
    const status = inventory.snapshot().statuses.find(s => s.id === id);
    if (!status) throw new NotFoundError(`integration ${id} not found`);
    // One sync at a time: a manual sync while one runs is refused at once, never queued behind it.
    const running = inventory.isRunning();
    if (running) {
      throw new ConflictError(`A sync is already running (started ${Math.max(0, Math.round((Date.now() - Date.parse(running.since)) / 1000))} s ago); its results appear here when it finishes.`);
    }
    // Bounds outbound calls: a repeated click inside the cooldown does not start another sync.
    if (status.lastAttempt && Date.now() - Date.parse(status.lastAttempt) < MANUAL_SYNC_COOLDOWN_MS) {
      const body: SyncResponse = { ok: true, note: 'A sync started less than a minute ago; not repeated.' };
      res.json(body);
      return;
    }
    await audited(o.auditor, req, 'integration-sync', { integration: id }, () => inventory.syncAll(id));
    const body: SyncResponse = { ok: true };
    res.json(body);
  });

  /* ------------------------------------------------------- provisioning */

  router.get('/provisioning/recipes', async (req, res) => {
    await access.require(req, provisioningPreviewPermission);
    const model = await repo.model();
    const body: RecipesResponse = {
      recipes: RECIPE_DEFINITIONS.map(r => ({ ...r, stages: recipeStages(r, model.stages) })),
      regions: Object.entries(model.regions.regions).map(([id, reg]) => ({
        id,
        note: reg.note,
        default: reg.default,
        platforms: Object.entries(reg.platforms).map(([pid, p]) => ({ id: pid, ...p })),
      })),
      stages: Object.fromEntries(Object.entries(model.stages.stages).map(([k, v]) => [k, v.policy])),
      sizing: model.liveRoots.map(r => ({ stage: r.stage, stack: r.stack, sizingFile: r.sizingFile, sizing: r.sizing, ...(r.runProfiles?.length ? { runProfiles: r.runProfiles } : {}) })),
      catalog: model.recipes,
    };
    res.json(body);
  });

  const preview = async (body: unknown) => {
    const input = parse(provisioningRequestSchema, body);
    const model = await repo.model();
    const path = sizingFilePath(input.recipe, input.stage);
    const sizingText = path ? await repo.read(path) : undefined;
    // The request is compared with its root's committed sizing and, when it names one, its run profile (W1-P1, #27).
    const stack = RECIPE_DEFINITIONS.find(r => r.id === input.recipe)?.stack;
    const runProfiles = model.liveRoots.find(r => r.stage === input.stage && r.stack === stack)?.runProfiles ?? [];
    const ctx = { stages: model.stages, regions: model.regions, now: inventory.now(), sizingText, runProfiles };
    const policy = validateProvisioningRequest(input, ctx);
    // The diff and the estimate are shown even when an error blocks Prepare (W1-P5); only a stage the recipe cannot
    // target or a region outside platform/regions.yaml leaves nothing to preview.
    const previewable = recipeStages(recipeById(input.recipe), model.stages).includes(input.stage) && Boolean(model.regions.regions[input.region]);
    const change = previewable ? previewChange(input, ctx) : undefined;
    // Live checks against the tenant allowances, the capacity advisor and the tenant's reservations, recorded with the request.
    const full = inventory.snapshot();
    const snap = full.capacity;
    const quotaCheck = change ? quotaCheckFor(snap.quotas, change.footprint, input.region, input.capacityType, input.recipe === 'training-capacity', full.capabilities, change.quota.mk8sClusters) : undefined;
    const availability = change ? availabilityFor(snap.resourceAdvice, change.footprint, input, model, full.capabilities) : undefined;
    const reservations = change ? reservationCheck(snap.capacityBlockGroups, change.footprint, input, model.regions, full.capabilities) : undefined;
    const fitsIn = quotaCheck?.lines.some(l => l.state !== 'ok') ? fitsElsewhere(snap.quotas, input, ctx, full.capabilities) : undefined;
    const issues = [...policy, ...liveIssues(quotaCheck, availability, input, reservations)];
    const baseHashes: Record<string, string> = {};
    if (path && sizingText !== undefined) baseHashes[path] = await repo.hash(path);
    return { input, issues, change, baseHashes, quotaCheck, availability, reservations, fitsIn };
  };

  router.post('/provisioning/preview', json, async (req, res) => {
    await access.require(req, provisioningPreviewPermission);
    const p = await preview(req.body);
    // Enforcement uses the tenant allowances: a check of the caller's own request against them, not a list of them.
    const body: PreviewResponse = { issues: p.issues, change: p.change, quotaCheck: p.quotaCheck, availability: p.availability, reservations: p.reservations, fitsIn: p.fitsIn, baseHashes: p.baseHashes, commit: (await repo.model()).commit };
    res.json(body);
  });

  /** Live list price of a previewed request's footprint from the Nebius billing calculator. */
  router.post('/provisioning/live-price', json, async (req, res) => {
    const caller = await access.require(req, provisioningPreviewPermission, commercialRateReadPermission);
    takeOrThrow(priceLimiter, caller.userEntityRef, res);
    const p = await preview(req.body);
    // Priced even when an error blocks Prepare (W1-P5): only a request with nothing to preview is refused.
    if (!p.change) throw new InputError('the request has no footprint to price: check its stage and region');
    res.json(await livePrice(inventory, cfg, p.change.footprint, p.input.region, p.input.capacityType, caller.scope));
  });

  /** Advisory estimate of a previewed request, with the default rate book on the portal clock. */
  router.post('/provisioning/estimate', json, async (req, res) => {
    const caller = await access.require(req, provisioningPreviewPermission, commercialRateReadPermission);
    const p = await preview(req.body);
    if (!p.change) throw new InputError('the request has no footprint to estimate: check its stage and region');
    // A rate book is optional (W1-P6): without one the estimate is priced at the built-in Nebius list price, and its
    // coverage names every price the calculator did not give.
    let book = await o.commercial.defaultBook(cfg.commercial.defaultRateBook);
    if (!book) {
      takeOrThrow(priceLimiter, caller.userEntityRef, res);
      try {
        book = await liveListBook(inventory, cfg, p.input.region, [p.change.footprint], p.input.capacityType, caller.scope);
      } catch (e) {
        throw new ConflictError(`No rate book is imported and the live list price is unavailable: ${(e as Error).message}`);
      }
    }
    const asOf = inventory.now();
    res.json(estimateScenario(scenarioFromProvisioning(p.change, p.input, book, asOf.toISOString().slice(0, 10)), book, asOf));
  });

  router.get('/provisioning/requests', async (req, res) => {
    await access.require(req, provisioningPreviewPermission);
    res.json({ items: await store.list() });
  });

  router.post('/provisioning/requests', json, async (req, res) => {
    const caller = await access.require(req, provisioningRequestPermission);
    const body = parse(z.object({ input: z.unknown(), baseHashes: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)) }), req.body);
    const p = await preview(body.input);
    if (!p.change || p.issues.some(i => i.severity === 'error')) throw new InputError('the request does not pass the policy checks; preview it first');
    const record = await audited(o.auditor, req, 'provisioning-request-create', { recipe: p.input.recipe, stage: p.input.stage, requestRef: p.input.requestRef }, () =>
      store.insert(
        { input: p.input, createdBy: caller.userEntityRef, baseHashes: body.baseHashes, patch: previewToPatch(p.change!), issues: p.issues },
        p.baseHashes,
        // Only files the patch changes are locked: a request that changes nothing blocks no other (G5.4).
        p.change!.files.filter(f => f.diff).map(f => f.path),
      ),
    );
    res.status(201).json(record);
  });

  router.get('/provisioning/requests/:id', async (req, res) => {
    await access.require(req, provisioningPreviewPermission);
    res.json(await store.get(parse(z.string().uuid(), req.params.id)));
  });

  router.get('/provisioning/requests/:id/patch', async (req, res) => {
    await access.require(req, provisioningPreviewPermission);
    const rec = await store.get(parse(z.string().uuid(), req.params.id));
    res.setHeader('Content-Type', 'text/x-diff; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nebius-estate-${rec.id.slice(0, 8)}.patch"`);
    res.send(rec.patch || '# No file changes: this recipe uses the committed configuration unchanged.\n');
  });

  router.post('/provisioning/requests/:id/withdraw', json, async (req, res) => {
    await access.require(req, provisioningRequestPermission);
    const id = parse(z.string().uuid(), req.params.id);
    res.json(await audited(o.auditor, req, 'provisioning-request-withdraw', { id }, () => store.transition(id, 'withdrawn')));
  });

  router.post('/provisioning/requests/:id/evidence', json, async (req, res) => {
    await access.require(req, provisioningRequestPermission);
    const id = parse(z.string().uuid(), req.params.id);
    const body = parse(z.object({ state: z.enum(['approved', 'deployed']), evidence: z.string().regex(/^docs\/evidence\/[A-Za-z0-9.-]+\.md$/).optional() }), req.body);
    if (body.state === 'deployed' && !body.evidence) throw new InputError('a deployed request must point at its evidence file in docs/evidence/');
    res.json(await audited(o.auditor, req, 'provisioning-request-transition', { id, to: body.state }, () => store.transition(id, body.state, { evidence: body.evidence })));
  });

  router.use(commercialRouter({ cfg, access, auditor: o.auditor, store: o.commercial, inventory, json, priceLimiter, regions: async () => (await repo.model()).regions.regions }));

  return router;
}
