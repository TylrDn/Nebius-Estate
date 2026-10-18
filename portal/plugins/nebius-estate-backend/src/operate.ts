import { AuditorService, LoggerService } from '@backstage/backend-plugin-api';
import express from 'express';
import Router from 'express-promise-router';
import { Knex } from 'knex';
import { Access } from './lib/access';
import { TokenBucketLimiter } from './lib/limits';
import { MAX_TELEMETRY_RESPONSE_BYTES } from './lib/http';
import { EstateConfig } from './lib/config';
import { InventoryService } from './inventory/InventoryService';
import { RepoReader } from './repo/RepoReader';
import { AlertStore } from './alerts/AlertStore';
import { AlertEngine, NotifierRegistry } from './alerts/engine';
import { alertsRouter } from './alerts/router';
import { LogsClient, LogsExtension } from './logs/LogsClient';
import { logsRouter } from './logs/router';
import { AuditClient, AuditExtension } from './audit/AuditClient';
import { auditRouter } from './audit/router';
import { MetricsClient } from './telemetry/MetricsClient';
import { TelemetryRecorder } from './telemetry/recorder';
import { fleetRouter } from './telemetry/router';
import { SampleStore } from './telemetry/SampleStore';

export interface OperateDeps {
  cfg: EstateConfig;
  inventory: InventoryService;
  db: Knex;
  logger: LoggerService;
  auditor: AuditorService;
  access: Access;
  repo: RepoReader;
  priceLimiter: TokenBucketLimiter;
}

/**
 * Fleet, Alerts and Logs (the OPERATE pages built on telemetry): the sample store, the Logs and
 * audit connectors run as extensions of the inventory's sync loop, the alert engine after every sync.
 * No scheduler of their own. Call before `inventory.start()`; mount `router` next to the others.
 */
export function setupOperate(d: OperateDeps): { router: express.Router; engine: AlertEngine; recorder: TelemetryRecorder; notifiers: NotifierRegistry; samples: SampleStore } {
  const n = d.cfg.nebius;
  const projects = () => n?.projects.map(p => p.id) ?? [];
  const maxConcurrency = n?.maxConcurrency ?? 12;
  const syncIntervalMinutes = n?.syncIntervalMinutes ?? 15;
  const metrics = () => {
    if (!n?.monitoring.enabled) return undefined;
    const http = d.inventory.nebiusClient(n.monitoring.endpoint, { maxResponseBytes: MAX_TELEMETRY_RESPONSE_BYTES });
    return http ? new MetricsClient(http, n.monitoring.endpoint) : undefined;
  };
  const logs = () => {
    if (!n?.logging.enabled) return undefined;
    const http = d.inventory.nebiusClient(n.logging.endpoint, { maxResponseBytes: MAX_TELEMETRY_RESPONSE_BYTES });
    return http ? new LogsClient(http, n.logging.endpoint) : undefined;
  };

  const audit = () => {
    if (!n?.audit.enabled) return undefined;
    const http = d.inventory.nebiusClient(n.audit.endpoint, { maxResponseBytes: MAX_TELEMETRY_RESPONSE_BYTES });
    return http ? new AuditClient(http, n.audit.endpoint) : undefined;
  };
  // Audit events are tenant-wide and per region: the tenant from config or the projects' parent, the regions the listed projects are in.
  const listedProjects = () => d.inventory.snapshot().resources.filter(r => r.type === 'project' && projects().includes(r.providerId));
  // The inventory keeps the tenant it read last, so a failed project read does not lose it (F1.32).
  const auditTenant = () => d.inventory.tenantId() ?? listedProjects().find(r => r.tenantId)?.tenantId;
  const auditRegions = () => [...new Set(listedProjects().map(r => r.region).filter((x): x is string => Boolean(x)))].sort();

  const samples = new SampleStore(d.db);
  const recorder = new TelemetryRecorder({ store: samples, client: metrics, projects, resources: () => d.inventory.snapshot().resources, maxConcurrency, syncIntervalMinutes, now: () => d.inventory.now() });
  d.inventory.useExtension(recorder);
  d.inventory.useExtension(new LogsExtension({ client: logs, projects, maxConcurrency, syncIntervalMinutes, now: () => d.inventory.now() }));
  d.inventory.useExtension(new AuditExtension({ client: audit, tenant: auditTenant, regions: auditRegions, settled: () => d.inventory.inventorySettled(), maxConcurrency, syncIntervalMinutes, now: () => d.inventory.now() }));

  const store = new AlertStore(d.db);
  const notifiers = new NotifierRegistry();
  const engine = new AlertEngine({ store, repo: d.repo, inventory: d.inventory, metrics, projects, maxConcurrency, logger: d.logger, notifiers });
  d.inventory.afterSync(async () => {
    await engine.evaluate();
  });
  // A fast sync re-reads only VMs and clusters: resolve the alerts of VMs that are gone, nothing else.
  d.inventory.afterFastSync(async () => {
    await engine.resolveGoneVms();
  });

  const router = Router();
  // No router-wide body parser: this router is mounted first, so one here would parse (and cap) every
  // plugin route's body. The alerts write route parses its own (64 KB).
  router.use(fleetRouter({ cfg: d.cfg, access: d.access, inventory: d.inventory, store: samples, recorder, priceLimiter: d.priceLimiter }));
  const projectNames = () => new Map(d.inventory.snapshot().resources.filter(r => r.type === 'project').map(r => [r.providerId, r.name]));
  router.use(alertsRouter({ access: d.access, auditor: d.auditor, store, engine, repo: d.repo, notifiers, now: () => d.inventory.now(), projectNames, resources: () => d.inventory.snapshot().resources }));
  router.use(logsRouter({ access: d.access, inventory: d.inventory, client: logs, projects }));
  router.use(auditRouter({ access: d.access, inventory: d.inventory, client: audit, tenant: auditTenant, regions: auditRegions }));
  return { router, engine, recorder, notifiers, samples };
}
