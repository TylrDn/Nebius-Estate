import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const integrationRequire = createRequire(require.resolve('@backstage/integration'));

test('Backstage GitHub static credentials remain scoped to their configured host', async () => {
  const { SingleInstanceGithubCredentialsProvider } = integrationRequire('@backstage/integration');
  const provider = SingleInstanceGithubCredentialsProvider.create({ host: 'github.com', apiBaseUrl: 'https://api.github.com', token: 'synthetic-token' });
  const credential = await provider.getCredentials({ url: 'https://github.com/example/repository' });
  assert.equal(credential.token, 'synthetic-token');
  assert.equal(credential.headers.Authorization, 'Bearer synthetic-token');
});

test('the CommonJS Octokit parent paginates with the configured fetch transport', async () => {
  const { Octokit } = integrationRequire('@octokit/rest');
  const calls = [];
  const octokit = new Octokit({ auth: 'synthetic-token', request: { fetch: async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers.authorization });
    const second = String(url).includes('page=2');
    return new Response(JSON.stringify([{ id: second ? 2 : 1 }]), { status: 200, headers: {
      'content-type': 'application/json', ...(second ? {} : { link: '<https://api.github.com/orgs/example/repos?page=2>; rel="next"' }),
    } });
  } } });
  const repos = await octokit.paginate(octokit.rest.repos.listForOrg, { org: 'example' });
  assert.deepEqual(repos.map(repo => repo.id), [1, 2]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.authorization === 'token synthetic-token'));
});

test('the Octokit app-auth parent creates a verifiable application JWT', async () => {
  const { createAppAuth } = integrationRequire('@octokit/auth-app');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const auth = createAppAuth({ appId: 123, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const result = await auth({ type: 'app' });
  const [header, payload, signature] = result.token.split('.');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, 123);
  assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
});

test('Backstage app credentials paginate selected repositories and cache installation tokens', async t => {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method, path: req.url });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/app/installations') return res.end(JSON.stringify([{ id: 44, account: { login: 'example', type: 'Organization' }, suspended_at: null }]));
    if (req.url === '/app/installations/44/access_tokens') return res.end(JSON.stringify({ token: 'synthetic-installation-token', expires_at: new Date(Date.now() + 3600000).toISOString(), repository_selection: 'selected' }));
    if (req.url.startsWith('/installation/repositories')) {
      const second = req.url.includes('page=2');
      if (!second) res.setHeader('link', `<http://127.0.0.1:${server.address().port}/installation/repositories?page=2>; rel="next"`);
      return res.end(JSON.stringify({ total_count: 2, repositories: [{ id: second ? 2 : 1, name: second ? 'second' : 'allowed' }] }));
    }
    res.statusCode = 404;
    return res.end(JSON.stringify({ message: 'Not Found' }));
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { SingleInstanceGithubCredentialsProvider } = integrationRequire('@backstage/integration');
  const provider = SingleInstanceGithubCredentialsProvider.create({
    host: 'github.com', apiBaseUrl: `http://127.0.0.1:${server.address().port}`,
    apps: [{ appId: 123, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), allowedInstallationOwners: ['example'] }],
  });
  for (const repo of ['allowed', 'second', 'allowed']) {
    const credential = await provider.getCredentials({ url: `https://github.com/example/${repo}` });
    assert.equal(credential.token, 'synthetic-installation-token');
  }
  await assert.rejects(provider.getCredentials({ url: 'https://github.com/example/refused' }), /does not have access/);
  assert.equal(calls.filter(call => call.path === '/app/installations/44/access_tokens').length, 1);
  assert.equal(calls.filter(call => call.path.startsWith('/installation/repositories')).length, 2);
});

test('Octokit HTTP errors retain the status and request information', async () => {
  const { Octokit } = integrationRequire('@octokit/rest');
  const octokit = new Octokit({ request: { fetch: async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } }) } });
  await assert.rejects(octokit.request('GET /repos/{owner}/{repo}', { owner: 'example', repo: 'absent' }), error => {
    assert.equal(error.status, 404);
    assert.equal(error.request.method, 'GET');
    assert.match(error.request.url, /example\/absent/);
    return true;
  });
});

// Resolve from an actual js-yaml 3 consumer so the CLI cannot silently test only v4.
const yamlRequire = createRequire(require.resolve('read-yaml-file'));
const yamlRoot = dirname(yamlRequire.resolve('js-yaml/package.json'));
const yamlCli = resolve(yamlRoot, 'bin/js-yaml.js');
const cli = (args, input = '') => spawnSync(process.execPath, [yamlCli, ...args], { input, encoding: 'utf8', timeout: 5000 });

test('the legacy js-yaml CLI keeps its help/version and suppressed option support', () => {
  assert.match(yamlRequire('js-yaml/package.json').version, /^3\./);
  const help = cli(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--compact/);
  assert.match(help.stdout, /--trace/);
  assert.doesNotMatch(help.stdout, /--to-json/);
  const version = cli(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^3\./);
  const legacy = cli(['-j'], 'answer: 42\n');
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.deepEqual(JSON.parse(legacy.stdout), { answer: 42 });
});

test('the legacy js-yaml CLI converts stdin and preserves parser behavior', () => {
  const yaml = cli([], 'answer: 42\nitems: [a, b]\n');
  assert.equal(yaml.status, 0, yaml.stderr);
  assert.deepEqual(JSON.parse(yaml.stdout), { answer: 42, items: ['a', 'b'] });
  const json = cli([], '{"answer":42}');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(yamlRequire('js-yaml').safeLoad(json.stdout), { answer: 42 });
});

test('the legacy js-yaml CLI still rejects invalid input, options and missing files', () => {
  for (const args of [[], ['--compact'], ['--trace']]) {
    const result = cli(args, 'answer: [\n');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /YAML|unexpected|end of|flow/i);
  }
  assert.notEqual(cli(['--not-an-option']).status, 0);
  assert.equal(cli(['/nonexistent-synthetic-yaml-input']).status, 2);
});
