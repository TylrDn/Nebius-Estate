#!/usr/bin/env node
// Read-only prerequisites: no subprocesses, package downloads, installs or cloud calls.
import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkPort } from './demo.mjs';
import { supportedNodeVersion } from './node-runtime.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exists = (path, mode = constants.X_OK) => access(path, mode).then(() => true, () => false);
const binary = async name => (await Promise.all((process.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => exists(join(path, name))))).some(Boolean);
const full = process.argv.includes('--full');
let failed = false;
function report(ok, label, remedy, optional = false) {
  console.log(`${ok ? 'OK' : optional && !full ? 'OPTIONAL' : 'MISSING'} ${label}${ok ? '' : ` — ${remedy}`}`);
  failed ||= !ok && (!optional || full);
}
console.log(`Node ${process.version}; architecture ${process.platform}/${process.arch}. No installs or cloud requests are performed.`);
report(supportedNodeVersion(process.versions.node), 'Node 22 or 24.22+ (24.22.0 recommended)', 'select Node 24.22.0 (nvm install 24.22.0 && nvm use 24.22.0), then corepack enable. Earlier Node 24 releases can abort during SQLite cleanup');
report(await binary('yarn'), 'Yarn launcher', 'run corepack enable; the repository pins Yarn 4.13.0');
report(await exists(join(root, '.yarn/releases/yarn-4.13.0.cjs'), constants.R_OK), 'Pinned Yarn release', 'restore portal/.yarn/releases from git');
report(await exists(join(root, 'node_modules/.bin/backstage-cli')), 'Portal dependencies', 'make portal-install (network required; no cloud credentials)');
for (const [name, remedy] of [['git', 'install Git'], ['make', 'install make / Xcode command line tools'], ['python3', 'install Python 3 for the native SQLite build fallback'], ['docker', 'install and open Docker Desktop; daemon availability is not checked']]) report(await binary(name), name === 'docker' ? 'Docker (optional for native portal; required for toolbox)' : name, remedy, name === 'docker');
console.log('Docker daemon is not queried. Apple Silicon toolbox runs may require linux/amd64 emulation.');
for (const port of [3100, 7107, 7199]) { try { await checkPort(port); report(true, `Loopback port ${port} available`); } catch (error) { report(false, `Loopback port ${port}`, error.message); } }
const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), '.cache/ms-playwright'), join(homedir(), 'Library/Caches/ms-playwright')].filter(Boolean);
let browser = false;
for (const cache of caches) {
  const entries = await readdir(cache).catch(() => []);
  for (const entry of entries.filter(name => /^chromium-\d+$/.test(name))) {
    for (const executable of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium']) browser ||= await exists(join(cache, entry, executable));
  }
}
report(browser, 'Chromium cache for browser tests (optional for demo)', 'cd portal && yarn playwright install chromium (Linux CI: yarn playwright install --with-deps chromium); browser launch is checked by portal-e2e', true);
console.log('Default: demo prerequisites determine exit status; Docker/Chromium are optional. Use --full to require the toolbox and browser prerequisites too.');
process.exitCode = failed ? 1 : 0;
