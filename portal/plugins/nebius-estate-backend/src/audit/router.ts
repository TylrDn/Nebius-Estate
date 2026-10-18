import { InputError, NotAllowedError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import { z } from 'zod';
import { AuditEventsResponse, auditReadPermission, MAX_AUDIT_EVENTS, MAX_AUDIT_RANGE_MINUTES } from '@internal/nebius-domain';
import { Access } from '../lib/access';
import { classify } from '../inventory/contract';
import { InventoryService } from '../inventory/InventoryService';
import { parse } from '../lib/parse';
import { redact } from '../lib/http';
import { AUDIT_GRANT, AUDIT_SOURCE, AuditClient, auditInputsGap } from './AuditClient';
import { readAuditEvents } from './readEvents';

export interface AuditRouterOptions {
  access: Access;
  inventory: InventoryService;
  client: () => AuditClient | undefined;
  tenant: () => string | undefined;
  regions: () => string[];
}

const queryParams = z.object({
  region: z.string().regex(/^[a-z]+-[a-z]+\d+$/).optional(),
  sinceMinutes: z.coerce.number().int().min(1).max(MAX_AUDIT_RANGE_MINUTES).default(24 * 60),
  limit: z.coerce.number().int().min(1).max(MAX_AUDIT_EVENTS).default(50),
  /** "true": GET and LIST calls too (most events are reads, by this portal among others). */
  reads: z.enum(['true', 'false']).default('false'),
});

/**
 * Recent tenant audit events, read on demand (GET to Nebius only; nothing is stored). Tenant-wide, so
 * only a caller whose scope is every project may read them.
 */
export function auditRouter(o: AuditRouterOptions): express.Router {
  const router = Router();

  router.get('/audit/events', async (req, res) => {
    const caller = await o.access.require(req, auditReadPermission);
    if (!caller.scope.all) throw new NotAllowedError('audit events are tenant-wide: they need a role scoped to every project');
    const q = parse(queryParams, req.query);
    const regions = o.regions();
    if (q.region && !regions.includes(q.region)) throw new InputError(`region ${q.region} is not a region of a listed project (${regions.join(', ') || 'none yet'})`);
    const region = q.region ?? regions[0] ?? '';
    const now = o.inventory.now();
    const end = now.toISOString();
    const start = new Date(now.getTime() - q.sinceMinutes * 60_000).toISOString();
    const writesOnly = q.reads === 'false';
    const body = (extra: Partial<AuditEventsResponse>): AuditEventsResponse => ({
      region, regions, start, end, events: [], limit: q.limit, truncated: false, writesOnly, source: AUDIT_SOURCE, observedAt: end, ...extra,
    });
    const client = o.client();
    const tenant = o.tenant();
    if (!client || !tenant || !region) {
      // Configured, the tenant or the regions are missing: not read yet, or the project reads failed (F1.32).
      const synced = o.inventory.snapshot().statuses.find(s => s.id === 'nebius-inventory')?.state !== 'starting';
      const unavailableReason = !client
        ? 'Audit events need the Nebius connector, the tenant and at least one listed project (docs/portal/nebius-setup.md).'
        : auditInputsGap({ tenant: !!tenant, regions: !!region, synced });
      res.json(body({ unavailableReason }));
      return;
    }
    try {
      const r = await readAuditEvents(client, { tenant, region, start, end, limit: q.limit, writesOnly });
      res.json(body({ events: r.events, truncated: r.truncated, scannedFrom: r.scannedFrom, scanned: r.scanned, serverFiltered: r.serverFiltered }));
    } catch (e) {
      const state = classify(e).state;
      res.json(body({ unavailableReason: `Could not read audit events (${state}): ${redact((e as Error).message).slice(0, 200)}${state === 'permission-denied' ? ` Grant ${AUDIT_GRANT}.` : ''}` }));
    }
  });

  return router;
}
