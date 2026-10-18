import express from 'express';
import Router from 'express-promise-router';
import { z } from 'zod';
import { commercialRateReadPermission, estateReadPermission, FLEET_RANGES, globalFilterSchema, telemetryReadPermission } from '@internal/nebius-domain';
import { Access, inScope } from '../lib/access';
import { EstateConfig } from '../lib/config';
import { parse } from '../lib/parse';
import { TokenBucketLimiter } from '../lib/limits';
import { InventoryService } from '../inventory/InventoryService';
import { liveRunRate } from '../commercial/livePrice';
import { scopeSnapshot } from '../views';
import { fleet, VmPricer } from './fleet';
import { TelemetryRecorder } from './recorder';
import { SampleStore } from './SampleStore';

export interface FleetRouterOptions {
  cfg: EstateConfig;
  access: Access;
  inventory: InventoryService;
  store: SampleStore;
  recorder: TelemetryRecorder;
  priceLimiter: TokenBucketLimiter;
}

const fleetQuery = globalFilterSchema.extend({ range: z.enum(FLEET_RANGES).default('24h') });

/**
 * One calculator call per running VM shape, not per GPU (G2.9): a VM that is not running is answered before the
 * cache, so it never stands for the running VMs of its shape.
 */
export function cachedPricer(rate: VmPricer): VmPricer {
  const cache = new Map<string, ReturnType<VmPricer>>();
  return vm => {
    if (vm.status !== 'running') return Promise.resolve({ hourly: null, reason: 'The VM is not running now; the calculator prices running VMs only.' });
    const key = `${vm.projectId}|${vm.spec.platform}|${vm.spec.preset}|${vm.spec.capacityType}`;
    if (!cache.has(key)) cache.set(key, rate(vm));
    return cache.get(key)!;
  };
}

/** GET /fleet: the GPU heat map from the sample store, roll-ups, idle-GPU cost and service panels. */
export function fleetRouter(o: FleetRouterOptions): express.Router {
  const router = Router();
  router.get('/fleet', async (req, res) => {
    const caller = await o.access.require(req, telemetryReadPermission, estateReadPermission);
    // Scope first, then the global filter, as every estate view does.
    const q = parse(fleetQuery, req.query);
    const scoped = scopeSnapshot(o.inventory.snapshot(), caller.scope);
    let priceUnavailable = await o.access.allowed(caller, commercialRateReadPermission)
      ? undefined : 'Idle cost needs nebius.commercial.rate.read across the telemetry project scope.';
    let checkedLimit = false;
    const price = cachedPricer(async vm => {
      if (!priceUnavailable && !checkedLimit) {
        checkedLimit = true;
        const wait = o.priceLimiter.take(caller.userEntityRef);
        if (wait) priceUnavailable = `Too many live-price requests: try again in ${wait} s.`;
      }
      if (priceUnavailable) return { hourly: null, reason: priceUnavailable };
      const r = await liveRunRate(o.inventory, o.cfg, [vm]);
      return r.value?.hourly ? { hourly: r.value.hourly, source: r.value.source } : { hourly: null, reason: r.unavailableReason ?? 'The calculator returned no hourly price for this VM.' };
    });
    res.json(
      await fleet({
        store: o.store,
        snap: scoped,
        // Region and stage follow each GPU series' stored labels, not the current inventory: a deleted VM's
        // history stays under the filter it ran in (G2.1).
        inScope: p => inScope(caller.scope, p) && (!q.project || p === q.project),
        filter: { region: q.region, stage: q.stage },
        range: q.range,
        now: o.inventory.now(),
        syncIntervalMinutes: o.cfg.nebius?.syncIntervalMinutes ?? 15,
        monitoringConfigured: Boolean(o.cfg.nebius?.projects.length && o.cfg.nebius.monitoring.enabled),
        figures: o.recorder.serviceFigures(),
        price,
      }),
    );
  });
  return router;
}
