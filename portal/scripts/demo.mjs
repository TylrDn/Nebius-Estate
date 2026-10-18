#!/usr/bin/env node
// Independent synthetic demonstration. Explicit configuration and an allowlisted environment
// keep operator credentials, private overlays and runtime injection out of every child.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
export function demoEnvironment(source = process.env) {
  const env = {};
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'CI']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return { ...env, NODE_ENV: 'development', HOST: '127.0.0.1', BROWSER: 'none',
    NEBIUS_IAM_TOKEN: 'e2e-stub-token', NEBIUS_SA_ID: '', NEBIUS_SA_PUBLIC_KEY_ID: '', NEBIUS_PROJECT_IDS: '',
    NEBIUS_BILLING_EXPORT_BUCKET: 'e00mock-billing-export', NEBIUS_BILLING_EXPORT_REGION: 'eu-west2',
    NEBIUS_BILLING_EXPORT_PREFIX: 'focus/', NEBIUS_BILLING_EXPORT_ACCESS_KEY_ID: 'e00mock-access-key',
    NEBIUS_BILLING_EXPORT_SECRET_ACCESS_KEY: 'e00mock-secret', NEBIUS_API_KEY: 'e2e-tf-key', HF_TOKEN: 'e2e-hf-token' };
}
export function demoServices() {
  return [
    { name: 'stub', command: process.execPath, args: ['e2e-stub/nebius-stub.mjs'], urls: ['http://127.0.0.1:7199/healthz'] },
    { name: 'portal', command: resolve(root, 'node_modules/.bin/backstage-cli'),
      args: ['repo', 'start', '--config', '../../app-config.yaml', '--config', '../../app-config.local.yaml', '--config', '../../e2e-stub/app-config.e2e.yaml'],
      urls: ['http://localhost:3100', 'http://127.0.0.1:7107/.backstage/health/v1/readiness'] },
  ];
}
export async function checkPort(port) {
  for (const host of ['127.0.0.1', '::1']) {
    const server = createServer();
    try {
      await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen({ port, host, exclusive: true }, resolveListen); });
    } catch (error) {
      // Hosts without IPv6 can still run an IPv4-only demo. A collision is never ignored.
      if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)) continue;
      throw new Error(`Demo port ${port} on ${host} is in use or unavailable; stop the process using it and retry (${error.code}).`);
    } finally {
      if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
    }
  }
}

function signalGroup(child, signal) {
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
// Browser and Node can choose different localhost families. Probe either numeric loopback
// without changing browser origins or depending on the platform's DNS address ordering.
function readinessTargets(url) {
  const target = new URL(url);
  if (target.hostname !== 'localhost') return [url];
  return ['127.0.0.1', '[::1]'].map(host => {
    const candidate = new URL(target);
    candidate.hostname = host;
    return candidate.href;
  });
}
function readinessError(error, depth = 0) {
  if (!error || depth > 3) return '';
  const fields = [error.message ?? String(error), error.code, error.address, error.port].filter(value => value !== undefined);
  const nested = [error.cause, ...(error.errors ?? [])].filter(Boolean).map(cause => readinessError(cause, depth + 1)).filter(Boolean);
  return [...fields, ...nested].join(' ');
}
export async function runDemo({ services = demoServices(), ports = [3100, 7107, 7199], env = process.env,
  signal, timeoutMs = 180_000, onReady = () => {}, log = console.log } = {}) {
  if (process.platform === 'win32') throw new Error('Demo process groups require POSIX; use Linux or macOS.');
  for (const port of ports) await checkPort(port);
  const home = await mkdtemp(resolve(tmpdir(), 'estate-demo-home-'));
  const children = [];
  let failure;
  const aborted = () => signal?.aborted;
  const check = () => { if (failure) throw failure; };
  try {
    const deadline = Date.now() + timeoutMs;
    for (const service of services) {
      if (aborted()) return;
      const child = spawn(service.command, service.args, { cwd: root, env: { ...demoEnvironment(env), HOME: home }, detached: true, stdio: 'inherit' });
      children.push(child);
      child.on('error', error => { failure = new Error(`${service.name} failed to start: ${error.message}. Run make doctor, then make portal-install.`); });
      child.on('exit', (code, exitSignal) => { failure ??= new Error(`${service.name} exited (${code ?? exitSignal}) before the demo stopped.`); });
      for (const url of service.urls) {
        let ready = false;
        let last = 'no response';
        let reported;
        while (Date.now() < deadline && !aborted()) {
          check();
          const outcomes = [];
          for (const candidate of readinessTargets(url)) {
            if (Date.now() >= deadline || aborted()) break;
            let outcome = 'no response';
            try {
              const response = await fetch(candidate, { signal: AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now()))) });
              outcome = `HTTP ${response.status}`;
              await response.body?.cancel();
              ready = response.ok;
            } catch (error) { outcome = `${outcome}; request error: ${readinessError(error)}`; }
            outcomes.push(`${candidate}: ${outcome}`);
            if (ready) break;
          }
          last = outcomes.join('; ') || last;
          if (last !== reported) { log(`${service.name} readiness at ${url}: ${last}`); reported = last; }
          if (ready) break;
          await pause(100);
        }
        if (aborted()) return;
        check();
        if (!ready) throw new Error(`${service.name} readiness timed out at ${url} (last: ${last}); inspect startup output and run make doctor.`);
      }
    }
    check();
    log('Independent project — synthetic test data, not a Nebius tenant or customer deployment.');
    log('Demo ready: http://localhost:3100 — Ctrl-C stops all demo services.');
    onReady();
    while (!aborted()) { check(); await pause(100); }
  } finally {
    for (const child of children) if (child.pid) signalGroup(child, 'SIGTERM');
    await pause(500);
    for (const child of children) if (child.pid) signalGroup(child, 'SIGKILL');
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null || !child.pid ? undefined : new Promise(resolveExit => child.once('exit', resolveExit))));
    await rm(home, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try { await runDemo({ signal: controller.signal }); } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
