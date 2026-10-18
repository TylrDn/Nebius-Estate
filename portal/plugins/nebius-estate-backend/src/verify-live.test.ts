import { mockServices } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import { CapabilityStatus } from '@internal/nebius-domain';
import knex from 'knex';
import { readEstateConfig } from './lib/config';
import { InventoryService } from './inventory/InventoryService';
import { REPO_ROOT } from './__testUtils__/testing';
import { AiServices } from './ai/AiServices';
import { readAiConfig } from './ai/config';
import { readWorkloadModelRefs } from './ai/workloadModels';
import { RepoReader } from './repo/RepoReader';
import { migrate } from './database';
import { MetricsClient } from './telemetry/MetricsClient';
import { SampleStore } from './telemetry/SampleStore';
import { TelemetryRecorder } from './telemetry/recorder';
import { LogsClient, LogsExtension } from './logs/LogsClient';
import { AuditClient, AuditExtension } from './audit/AuditClient';
import { FetchFn, HttpClient } from './lib/http';
import { NEBIUS_MONITORING } from './inventory/endpoints';
import { GPU_UTIL_QUERY, PrometheusConnector } from './inventory/prometheus';

/**
 * `yarn verify:live` — runs every read-only probe against the real account with
 * the credentials in the environment (NEBIUS_PROJECT_IDS and a service account
 * or NEBIUS_IAM_TOKEN; docs/portal/nebius-setup.md) and prints a capability
 * table. Fails when a capability verified on a live account no longer answers,
 * or when any response drifts from the documented contract. Skipped unless
 * NEBIUS_VERIFY_LIVE=1, so it never runs in CI or in `test:all`.
 */
const live = process.env.NEBIUS_VERIFY_LIVE === '1' ? describe : describe.skip;

const row = (c: CapabilityStatus) =>
  [c.id.padEnd(30), c.state.padEnd(18), String(c.items ?? '').padStart(6), `${c.latencyMs ?? ''}`.padStart(7), c.drift?.length ? 'DRIFT' : 'ok'.padEnd(5), c.verified ? 'verified' : '        ', (c.hint ?? c.lastError ?? '').slice(0, 120)].join('  ');

live('verify:live (real account, read-only)', () => {
  // Stopped after the run, pass or fail: the sync loop's re-sync timer and the sample database would
  // otherwise outlive the tests (the script used to need --forceExit).
  const cleanup: (() => unknown)[] = [];
  afterAll(async () => {
    for (const c of cleanup.reverse()) await c();
  });

  it('every verified capability still answers, and nothing drifts from the documented contract', async () => {
    const cfg = readEstateConfig(
      new ConfigReader({
        backend: { listen: { host: '127.0.0.1' } },
        nebiusEstate: {
          repoRoot: REPO_ROOT,
          access: { roles: [{ name: 'verify', principals: ['user:development/guest'], permissions: ['*'] }] },
          nebius: {
            tenantId: process.env.NEBIUS_TENANT_ID || undefined,
            projectIdsEnv: 'NEBIUS_PROJECT_IDS',
            // Rehearsal against the loopback e2e stub only (yarn e2e:stub); never set for the real check.
            ...(process.env.NEBIUS_VERIFY_STUB ? { apiEndpoint: process.env.NEBIUS_VERIFY_STUB, monitoring: { endpoint: process.env.NEBIUS_VERIFY_STUB }, logging: { endpoint: process.env.NEBIUS_VERIFY_STUB }, pricing: { currency: 'xts' } } : {}),
            auth: { serviceAccount: { idEnv: 'NEBIUS_SA_ID', publicKeyIdEnv: 'NEBIUS_SA_PUBLIC_KEY_ID', privateKeyFileEnv: 'NEBIUS_SA_PRIVATE_KEY_FILE' }, tokenEnv: 'NEBIUS_IAM_TOKEN' },
          },
        },
      }),
    );
    expect(cfg.nebius?.projects.length).toBeGreaterThan(0);
    const svc = new InventoryService(cfg, mockServices.logger.mock());
    // The Fleet and Logs connectors run on the same sync loop (sample store in memory; nothing is kept).
    const db = knex({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    cleanup.push(() => db.destroy());
    await migrate(db);
    const n = cfg.nebius!;
    const projects = () => n.projects.map(p => p.id);
    const metrics = () => {
      const http = svc.nebiusClient(n.monitoring.endpoint);
      return http ? new MetricsClient(http, n.monitoring.endpoint) : undefined;
    };
    const logs = () => {
      const http = svc.nebiusClient(n.logging.endpoint);
      return http ? new LogsClient(http, n.logging.endpoint) : undefined;
    };
    svc.useExtension(new TelemetryRecorder({ store: new SampleStore(db), client: metrics, projects, resources: () => svc.snapshot().resources, maxConcurrency: n.maxConcurrency, syncIntervalMinutes: n.syncIntervalMinutes }));
    svc.useExtension(new LogsExtension({ client: logs, projects, maxConcurrency: n.maxConcurrency, syncIntervalMinutes: n.syncIntervalMinutes }));
    const audit = () => {
      const http = svc.nebiusClient(n.audit.endpoint);
      return http ? new AuditClient(http, n.audit.endpoint) : undefined;
    };
    const listed = () => svc.snapshot().resources.filter(r => r.type === 'project' && projects().includes(r.providerId));
    const tenant = () => n.tenantId ?? listed().find(r => r.tenantId)?.tenantId;
    const regions = () => [...new Set(listed().map(r => r.region).filter((x): x is string => Boolean(x)))].sort();
    svc.useExtension(new AuditExtension({ client: audit, tenant, regions, settled: () => svc.inventorySettled(), maxConcurrency: n.maxConcurrency, syncIntervalMinutes: n.syncIntervalMinutes }));
    cleanup.push(() => svc.stop());
    await svc.start();
    await svc.ready();

    // Explicit checks of the two read paths the Fleet, Alerts and Logs pages add, for every listed project:
    // a metrics query_range (1 h of GPU utilisation, 1-min step) and a logs `labels` call (start/end in ns).
    const end = Date.now();
    const extra: string[] = [];
    const failures: string[] = [];
    for (const p of projects()) {
      try {
        const r = await metrics()!.queryRange(p, 'DCGM_FI_DEV_GPU_UTIL', Math.floor(end / 1000) - 3600, Math.floor(end / 1000), 60);
        extra.push(`  metrics query_range  ${p}  ok  ${r.length} GPU series, ${r.reduce((a, x) => a + x.values.length, 0)} points`);
      } catch (e) {
        failures.push(`metrics query_range ${p}: ${(e as Error).message.slice(0, 160)}`);
      }
      try {
        const l = await logs()!.labels(p, end - 3_600_000, end);
        extra.push(`  logs labels          ${p}  ok  [${l.join(', ')}]`);
      } catch (e) {
        failures.push(`logs labels ${p}: ${(e as Error).message.slice(0, 160)}`);
      }
    }
    // Audit events (tenant, per region of the listed projects): the Logs page reads them on demand.
    for (const region of regions()) {
      try {
        const r = await audit()!.list(tenant()!, region, new Date(end - 3_600_000).toISOString(), new Date(end).toISOString(), 20);
        extra.push(`  audit events         ${region.padEnd(14)}  ok  ${r.events.length} event(s) in the last hour (first page of 20)`);
      } catch (e) {
        failures.push(`audit events ${region}: ${(e as Error).message.slice(0, 160)}`);
      }
    }
    process.stdout.write(`\nRead paths for Fleet, Alerts, Logs and audit events:\n${extra.join('\n')}\n${failures.map(f => `  FAILED ${f}`).join('\n')}\n`);
    const snap = svc.snapshot();
    const caps = [...snap.capabilities].sort((a, b) => a.id.localeCompare(b.id));
    process.stdout.write(
      `\nNebius Estate — capability probe, ${new Date().toISOString()}, ${cfg.nebius!.projects.length} project(s)\n` +
        `${['capability'.padEnd(30), 'state'.padEnd(18), 'items'.padStart(6), 'ms'.padStart(7), 'schema', '        ', 'hint / last error'].join('  ')}\n` +
        `${caps.map(row).join('\n')}\n` +
        `connectors: ${snap.statuses.map(s => `${s.id}=${s.state}`).join(', ')}\n\n`,
    );
    const regressions = caps.filter(c => c.verified && c.scope !== 'tenant' && c.state !== 'ok' && c.state !== 'not-configured').map(c => `${c.id}: ${c.state}${c.lastError ? ` (${c.lastError.slice(0, 160)})` : ''}`);
    const drift = caps.filter(c => c.drift?.length).map(c => `${c.id}: ${c.drift!.join('; ')}`);
    expect({ regressions, drift, failures }).toEqual({ regressions: [], drift: [], failures: [] });
  }, 600_000);

  // AI services: Token Factory (NEBIUS_API_KEY) and Hugging Face (HF_TOKEN) answer with the configured
  // key and token; every model the workloads pull is checked (gated status and access), never downloaded.
  it('Token Factory lists models and Hugging Face checks the token and each workload model', async () => {
    const ai = new AiServices(readAiConfig(new ConfigReader({ nebiusEstate: { ai: { tokenFactory: { apiKeyEnv: 'NEBIUS_API_KEY' }, huggingface: { tokenEnv: 'HF_TOKEN' } } } })), {
      modelRefs: () => readWorkloadModelRefs(new RepoReader(REPO_ROOT)),
    });
    const r = await ai.sync(new Date().toISOString());
    const { tokenFactory: tf, huggingface: hf } = ai.views();
    process.stdout.write(
      `\nAI services — ${new Date().toISOString()}\n` +
        `${r.capabilities.map(c => `${c.id.padEnd(30)}  ${c.state.padEnd(18)}  ${String(c.items ?? '').padStart(6)}  ${`${c.latencyMs ?? ''}`.padStart(7)}  ${(c.hint ?? c.lastError ?? '').slice(0, 120)}`).join('\n')}\n` +
        `token-factory: ${tf.state}, key valid ${tf.keyValid}, ${tf.models.length} models\n` +
        `huggingface: ${hf.state}, token valid ${hf.tokenValid}, account type ${hf.account?.type ?? '—'}, token ${hf.account?.tokenRole ?? '—'}\n` +
        `${hf.models.map(m => `  ${m.repo.padEnd(40)} gated=${String(m.gated).padEnd(6)} accessible=${String(m.accessible).padEnd(5)} ${m.note}`).join('\n')}\n\n`,
    );
    const problems = [
      ...(process.env.NEBIUS_API_KEY && tf.state !== 'ok' ? [`token-factory: ${tf.state} ${tf.error ?? ''}`] : []),
      ...(process.env.HF_TOKEN && hf.state !== 'ok' ? [`huggingface: ${hf.state} ${hf.error ?? ''}`] : []),
      ...(process.env.HF_TOKEN ? hf.models.filter(m => m.accessible === false).map(m => `${m.repo}: no access (${m.note})`) : []),
    ];
    expect(problems).toEqual([]);
  }, 120_000);
});

/** Needs PROMETHEUS_TOKEN as well (an OBSERVABILITY static key of the read-only service account). */
const livePrometheus = process.env.NEBIUS_VERIFY_LIVE === '1' && process.env.PROMETHEUS_TOKEN ? describe : describe.skip;

livePrometheus('verify:live: external Prometheus client (real account, read-only)', () => {
  // The external Prometheus client, pointed (in this test only; the portal's config is unchanged) at the official
  // Nebius Monitoring endpoint with PROMETHEUS_TOKEN (an OBSERVABILITY static key of the read-only service account).
  // An empty vector passes (no GPU running); Nebius series carry instance_id and no Hostname.
  it('the external Prometheus client answers against Nebius Monitoring and reads its label shapes', async () => {
    const projects = (process.env.NEBIUS_PROJECT_IDS ?? '').split(',').map(x => x.trim()).filter(Boolean);
    expect(projects.length).toBeGreaterThan(0);
    const base = (p: string) => `${NEBIUS_MONITORING}/projects/${encodeURIComponent(p)}/service-provider/prometheus`;
    // A query swap for the label check only: the client's own aggregation over the last 7 days of samples.
    const lookBack: FetchFn = (input, init) => {
      const url = new URL(input);
      url.searchParams.set('query', GPU_UTIL_QUERY.replace('(DCGM_FI_DEV_GPU_UTIL)', '(last_over_time(DCGM_FI_DEV_GPU_UTIL[7d]))'));
      return fetch(url.toString(), init);
    };
    const client = (f?: FetchFn) => new HttpClient({ allowedOrigins: [NEBIUS_MONITORING], timeoutMs: 30_000, authorization: async () => `Bearer ${process.env.PROMETHEUS_TOKEN}`, ...(f ? { fetch: f } : {}) });

    const now = await new PrometheusConnector(base(projects[0]), client()).sync();
    const lines = [`  query (now)        ${projects[0].slice(0, 14)}…  ok  ${now.samples.length} sample(s)`];
    expect(now.samples.every(x => x.instanceId === undefined || x.node === x.instanceId)).toBe(true);

    // The first project with DCGM series in the last 7 days shows the live label shape.
    let shaped: { project: string; samples: number } | undefined;
    for (const p of projects) {
      const t = await new PrometheusConnector(base(p), client(lookBack)).sync();
      if (!t.samples.length) continue;
      expect(t.samples.every(x => x.instanceId?.startsWith('computeinstance-') && x.node === x.instanceId)).toBe(true);
      shaped = { project: p, samples: t.samples.length };
      break;
    }
    lines.push(shaped ? `  label shape (7 d)  ${shaped.project.slice(0, 14)}…  ok  ${shaped.samples} VM(s) by instance_id` : '  label shape (7 d)  no DCGM series in any listed project in 7 days: shape not observed');
    process.stdout.write(`\nExternal Prometheus client against Nebius Monitoring — ${new Date().toISOString()}\n${lines.join('\n')}\n\n`);
  }, 120_000);
});
