import express from 'express';
import Router from 'express-promise-router';
import { AiServicesResponse, estateReadPermission, ObservedResource, serverlessListed } from '@internal/nebius-domain';
import { Access } from '../lib/access';
import { InventoryService } from '../inventory/InventoryService';
import { scopeSnapshot, serverlessReadAt } from '../views';
import { AiServices } from './AiServices';
import { mlServices } from './mlServices';

export interface AiRouterOptions {
  access: Access;
  inventory: InventoryService;
  ai: AiServices;
  syncIntervalMinutes: number;
}

const row = (r: ObservedResource) => ({
  uid: r.uid,
  name: r.name,
  projectId: r.projectId,
  region: r.region,
  status: r.statusDetail ?? r.status,
  platform: r.spec.platform,
  preset: r.spec.preset,
});

/**
 * GET /ai-services: Token Factory and Hugging Face checks from the last sync (cached for one sync
 * interval; "Sync now" on Integrations re-runs them), the Serverless AI endpoints and jobs, and the container
 * registries and MLflow clusters of the caller's scope. Nothing here calls out per request, and no key or token is ever returned.
 */
export function aiRouter(o: AiRouterOptions): express.Router {
  const router = Router();
  router.get('/ai-services', async (req, res) => {
    const caller = await o.access.require(req, estateReadPermission);
    const snap = scopeSnapshot(o.inventory.snapshot(), caller.scope);
    const caps = snap.capabilities.filter(c => c.id === 'ai.endpoints' || c.id === 'ai.jobs');
    const bad = caps.filter(c => c.state !== 'ok');
    const body: AiServicesResponse = {
      ...o.ai.views(),
      serverless: {
        endpoints: snap.resources.filter(r => r.type === 'ai-endpoint').map(row),
        jobs: snap.resources.filter(r => r.type === 'ai-job').map(row),
        observedAt: serverlessReadAt(snap),
        note: !caps.length
          ? 'The Serverless lists have not been read yet: the inventory connector needs projects and a read-only identity (Integrations).'
          : bad.length
            ? `${bad.map(c => `${c.title}: ${c.state.replace(/-/g, ' ')}${c.hint ? ` (${c.hint})` : ''}`).join('; ')}`
            : undefined,
        listed: serverlessListed(caps),
      },
      mlServices: mlServices(snap),
      syncIntervalMinutes: o.syncIntervalMinutes,
    };
    res.json(body);
  });
  return router;
}
