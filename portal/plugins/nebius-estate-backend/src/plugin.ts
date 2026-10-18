import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import { nebiusPermissions } from '@internal/nebius-domain';
import { Access } from './lib/access';
import { CALCULATOR_RATE, TokenBucketLimiter } from './lib/limits';
import { readEstateConfig } from './lib/config';
import { redact } from './lib/http';
import { migrate } from './database';
import { CommercialStore } from './commercial/store';
import { InventoryService } from './inventory/InventoryService';
import { RepoReader } from './repo/RepoReader';
import { ProvisioningStore } from './provisioning/store';
import { HistoryStore } from './history/HistoryStore';
import { HealthStore } from './health/HealthStore';
import { BillingExportPuller } from './billing/exportPull';
import { recordHistory } from './history/record';
import { backfillHistory } from './history/backfill';
import { createRouter } from './router';
import { setupOperate } from './operate';
import { AiServices } from './ai/AiServices';
import { readAiConfig } from './ai/config';
import { aiRouter } from './ai/router';
import { readWorkloadModelRefs } from './ai/workloadModels';
import { BudgetStore } from './budgets/store';
import { BudgetService } from './budgets/service';
import { budgetsRouter } from './budgets/router';

/**
 * Nebius Estate backend: inventory, repository model, evidence, capacity,
 * workloads, provisioning previews, FOCUS billing, rate books and scenarios.
 * Read-only towards every cloud API.
 *
 * @public
 */
export const nebiusEstatePlugin = createBackendPlugin({
  pluginId: 'nebius-estate',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        userInfo: coreServices.userInfo,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
        auditor: coreServices.auditor,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
        lifecycle: coreServices.lifecycle,
      },
      async init(d) {
        const cfg = readEstateConfig(d.config);
        d.permissionsRegistry.addPermissions(nebiusPermissions);
        const db = await d.database.getClient();
        if (!d.database.migrations?.skip) await migrate(db, { tenantId: cfg.nebius?.tenantId });

        const inventory = new InventoryService(cfg, d.logger);
        inventory.useHealthStore(new HealthStore(db));
        const history = new HistoryStore(db);
        const commercial = new CommercialStore(db);
        inventory.useBillingExport(new BillingExportPuller(db, commercial));
        const intervalMinutes = cfg.nebius?.syncIntervalMinutes ?? 15;
        inventory.setSchedule(intervalMinutes * 60_000, 60_000);
        // The fast re-sync timer (armed by setSchedule while something is changing state) and a running sync stop with
        // the plugin, and shutdown waits for them, so nothing writes to the database once it is closed (caveat 1).
        let firstHistory: Promise<void> = Promise.resolve();
        d.lifecycle.addShutdownHook(async () => {
          await inventory.stop();
          await firstHistory.catch(() => undefined);
        });
        const repo = new RepoReader(cfg.repoRoot);
        const priceLimiter = new TokenBucketLimiter(CALCULATOR_RATE);
        // Token Factory and Hugging Face checks run on the same sync loop (connectors token-factory, huggingface).
        const ai = new AiServices(readAiConfig(d.config), { modelRefs: () => readWorkloadModelRefs(repo) });
        inventory.useExtension(ai);
        // Fleet, Alerts and Logs: extensions of this sync loop and an after-sync alert evaluation (before start()).
        const operate = setupOperate({ cfg, inventory, db, logger: d.logger, auditor: d.auditor, access: new Access({ httpAuth: d.httpAuth, userInfo: d.userInfo, permissions: d.permissions, roles: cfg.roles }), repo: new RepoReader(cfg.repoRoot), priceLimiter });
        // Start-up does not wait on the cloud: the first sync runs in the background
        // (unless waitForFirstSync is set, e.g. for scripted checks).
        await inventory.start();
        firstHistory = inventory.ready().then(async () => {
          if (inventory.stopped) return;
          await recordHistory(history, inventory);
          // Days recorded before the per-day peak (G2.5) that GPU telemetry contradicts are raised and marked once (#33).
          const days = inventory.stopped ? [] : await backfillHistory(history, operate.samples, inventory.now());
          if (days.length) d.logger.info(`nebius-estate: history backfilled from GPU telemetry for ${days.join(', ')}`);
        });
        // Not awaited unless waitForFirstSync: a failure is logged, never an unhandled rejection.
        firstHistory.catch(e => d.logger.warn(`nebius-estate: could not record or backfill the first history day: ${redact((e as Error).message)}`));
        if (cfg.waitForFirstSync) await firstHistory;
        await d.scheduler.scheduleTask({
          id: 'nebius-estate-sync',
          frequency: { minutes: intervalMinutes },
          timeout: { minutes: 10 },
          initialDelay: { minutes: 1 },
          scope: 'local',
          fn: async () => {
            // A run long overdue (the host slept) waits for the API or is deferred (F1.45).
            if (await inventory.runScheduled()) await recordHistory(history, inventory);
          },
        });

        d.httpRouter.use(operate.router);
        d.httpRouter.use(
          await createRouter({
            cfg,
            access: new Access({ httpAuth: d.httpAuth, userInfo: d.userInfo, permissions: d.permissions, roles: cfg.roles }),
            auditor: d.auditor,
            inventory,
            repo,
            store: new ProvisioningStore(db),
            history,
            commercial,
            priceLimiter,
          }),
        );
        const access = new Access({ httpAuth: d.httpAuth, userInfo: d.userInfo, permissions: d.permissions, roles: cfg.roles });
        // Budget alerts: budgetService.signals(now) returns BudgetSignal[] (threshold crossings, credit expiry ≤ 14 days).
        const budgetStore = new BudgetStore(db, cfg.nebius?.tenantId ?? '');
        const budgetService = new BudgetService(budgetStore, commercial, inventory, cfg);
        // Budget and credit signals become alerts (source `budgets`) at each evaluation after a sync.
        operate.engine.useBudgetSignals(() => budgetService.signals(), () => budgetService.defined());
        // A budget, credit or spend write re-evaluates the budget alerts at once (W1-P19).
        d.httpRouter.use(budgetsRouter({ access, auditor: d.auditor, store: budgetStore, service: budgetService, onChange: c => operate.engine.reevaluateBudgets(c) }));
        d.httpRouter.use(aiRouter({ access, inventory, ai, syncIntervalMinutes: intervalMinutes }));
      },
    });
  },
});
