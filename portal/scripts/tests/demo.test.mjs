import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const module = await import('../demo.mjs').catch(() => null);
const available = () => assert.ok(module, 'supported demo runner must exist');
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(25); }
  assert.fail('condition did not become true');
}
async function fixture(t, { ready = true, exit = false, host = '127.0.0.1' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'estate-demo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const port = await freePort();
  const record = join(dir, 'child.json');
  const script = `
    const fs = require('node:fs');
    const http = require('node:http');
    const cp = require('node:child_process');
    const grandchild = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
    fs.writeFileSync(process.argv[1], JSON.stringify({pid:process.pid, grandchild:grandchild.pid, env:process.env}));
    ${exit ? 'setTimeout(()=>process.exit(7),100);' : ''}
    http.createServer((req,res)=>{res.statusCode=${ready ? 200 : 503};res.end('fixture');}).listen(${port}, '${host}');
  `;
  const service = { name: 'fixture', command: process.execPath, args: ['-e', script, record], urls: [`http://127.0.0.1:${port}`] };
  return { port, record, service };
}
// Container PID 1 may retain dead orphan zombies; these cannot execute or own ports.
const alive = pid => {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false;
    }
    return true;
  } catch { return false; }
};
const recorded = path => readFile(path, 'utf8').then(JSON.parse).catch(() => null);

test('demo environment discards credentials, injected config and runtime hooks', () => {
  available();
  const env = module.demoEnvironment({ PATH: '/bin', HOME: '/operator', NEBIUS_IAM_TOKEN: 'live-secret', AWS_SECRET_ACCESS_KEY: 'aws-secret', HF_TOKEN: 'live-hf', APP_CONFIG_backend_listen_host: '0.0.0.0', NODE_OPTIONS: '--require /secret.js', HTTPS_PROXY: 'https://private', KUBECONFIG: '/private' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.NEBIUS_IAM_TOKEN, 'e2e-stub-token');
  assert.equal(env.HF_TOKEN, 'e2e-hf-token');
  for (const key of ['AWS_SECRET_ACCESS_KEY', 'APP_CONFIG_backend_listen_host', 'NODE_OPTIONS', 'HTTPS_PROXY', 'KUBECONFIG', 'HOME']) assert.equal(env[key], undefined, key);
});

test('demo launches only explicit synthetic configuration, with no private overlay', () => {
  available();
  const app = module.demoServices().find(service => service.name === 'portal');
  assert.deepEqual(app.args, ['repo', 'start', '--config', '../../app-config.yaml', '--config', '../../app-config.local.yaml', '--config', '../../e2e-stub/app-config.e2e.yaml']);
});

test('ready demo passes sanitized environment and abort cleans child and grandchild', async t => {
  available();
  const f = await fixture(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  let ready = false;
  const run = module.runDemo({ services: [f.service], ports: [f.port], env: { PATH: process.env.PATH, AWS_SECRET_ACCESS_KEY: 'never-pass' }, signal: controller.signal, timeoutMs: 2000, onReady: () => { ready = true; }, log: () => {} });
  await until(() => ready);
  const child = await recorded(f.record);
  assert.equal(child.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(child.env.NEBIUS_IAM_TOKEN, 'e2e-stub-token');
  controller.abort();
  await run;
  await until(() => !alive(child.pid) && !alive(child.grandchild));
});

test('occupied port fails before starting a child and reports the remedy', async t => {
  available();
  const f = await fixture(t);
  const occupied = createServer();
  await new Promise(resolve => occupied.listen(f.port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  await assert.rejects(module.runDemo({ services: [f.service], ports: [f.port], timeoutMs: 200, log: () => {} }), /port.*in use.*stop|port.*occupied.*stop/i);
  assert.equal(await recorded(f.record), null);
});

test('readiness timeout never announces ready and cleans the process tree', async t => {
  available();
  const f = await fixture(t, { ready: false });
  let ready = false;
  await assert.rejects(module.runDemo({ services: [f.service], ports: [f.port], timeoutMs: 500, onReady: () => { ready = true; }, log: () => {} }), /ready|readiness|timed out/i);
  assert.equal(ready, false);
  const child = await recorded(f.record);
  assert.ok(child);
  await until(() => !alive(child.pid) && !alive(child.grandchild));
});

test('early child exit fails promptly and cleans its descendants', async t => {
  available();
  const f = await fixture(t, { ready: false, exit: true });
  await assert.rejects(module.runDemo({ services: [f.service], ports: [f.port], timeoutMs: 3000, log: () => {} }), /fixture.*exit.*7/i);
  const child = await recorded(f.record);
  assert.ok(child);
  await until(() => !alive(child.grandchild));
});

test('readiness timeout identifies the last HTTP response instead of hiding it', async t => {
  available();
  const f = await fixture(t, { ready: false });
  await assert.rejects(module.runDemo({ services: [f.service], ports: [f.port], timeoutMs: 500, log: () => {} }), error => {
    assert.match(error.message, /503/);
    assert.match(error.message, new RegExp(String(f.port)));
    return true;
  });
});

test('successful readiness ends the startup deadline while services remain alive until abort', async t => {
  available();
  const f = await fixture(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  let ready = false;
  let settled = false;
  const run = module.runDemo({ services: [f.service], ports: [f.port], signal: controller.signal, timeoutMs: 600, onReady: () => { ready = true; }, log: () => {} });
  run.then(() => { settled = true; }, () => { settled = true; });
  await until(() => ready);
  const child = await recorded(f.record);
  await delay(800);
  assert.equal(settled, false);
  assert.equal(alive(child.pid), true);
  assert.equal(alive(child.grandchild), true);
  controller.abort();
  await run;
  await until(() => !alive(child.pid) && !alive(child.grandchild));
});

test('unreachable readiness reports the socket cause and cleans the child tree', async t => {
  available();
  const f = await fixture(t);
  const unreachablePort = await freePort();
  f.service.urls = [`http://127.0.0.1:${unreachablePort}`];
  await assert.rejects(module.runDemo({ services: [f.service], ports: [f.port], timeoutMs: 500, log: () => {} }), error => {
    assert.match(error.message, /ECONNREFUSED/);
    assert.match(error.message, new RegExp(String(unreachablePort)));
    return true;
  });
  const child = await recorded(f.record);
  assert.ok(child);
  await until(() => !alive(child.pid) && !alive(child.grandchild));
});

for (const host of ['127.0.0.1', '::1']) {
  test(`localhost readiness accepts an HTTP server bound only to ${host}`, async t => {
    available();
    if (host === '::1') {
      const probe = createServer();
      try {
        await new Promise((resolveListen, reject) => { probe.once('error', reject); probe.listen(0, '::1', resolveListen); });
      } catch (error) {
        if (process.env.CI) throw new Error(`CI must support IPv6 loopback: ${error.code}`);
        t.skip(`IPv6 loopback unavailable on this OS: ${error.code}`);
        return;
      } finally { if (probe.listening) await new Promise(resolveClose => probe.close(resolveClose)); }
    }
    const f = await fixture(t, { host });
    f.service.urls = [`http://localhost:${f.port}`];
    const controller = new AbortController();
    t.after(() => controller.abort());
    let ready = false;
    const run = module.runDemo({ services: [f.service], ports: [f.port], signal: controller.signal, timeoutMs: 1500, onReady: () => { ready = true; controller.abort(); }, log: () => {} });
    await run;
    assert.equal(ready, true);
    const child = await recorded(f.record);
    assert.ok(child);
    await until(() => !alive(child.pid) && !alive(child.grandchild));
  });
}

test('occupied IPv6 loopback port fails before starting any demo child', async t => {
  available();
  const f = await fixture(t);
  const occupied = createServer();
  try {
    await new Promise((resolveListen, reject) => { occupied.once('error', reject); occupied.listen(f.port, '::1', resolveListen); });
  } catch (error) {
    if (process.env.CI) throw new Error(`CI must support IPv6 loopback: ${error.code}`);
    t.skip(`IPv6 loopback unavailable on this OS: ${error.code}`);
    return;
  }
  t.after(() => new Promise(resolveClose => occupied.close(resolveClose)));
  await assert.rejects(module.runDemo({ services: [f.service], ports: [f.port], timeoutMs: 500, signal: AbortSignal.timeout(1000), log: () => {} }), /port.*in use.*stop|port.*occupied.*stop/i);
  assert.equal(await recorded(f.record), null);
});
