#!/usr/bin/env node
/**
 * Runs backstage-cli with the portal's config overlays, adding the git-ignored operator overlay
 * (app-config.private.yaml) only when it exists. Never passes an empty argument, and never requires
 * the private overlay.
 *
 *   node scripts/backstage-config.mjs start [args…]   backstage-cli repo start (paths relative to each package)
 *   node scripts/backstage-config.mjs check           backstage-cli config:check --strict (paths relative to portal/)
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hasPrivate = existsSync(resolve(root, 'app-config.private.yaml'));

/** `--config` pairs for the given files, prefixed as the command expects; the private overlay only when present. */
export function configArgs(prefix, privateOverlay = hasPrivate) {
  const files = ['app-config.yaml', 'app-config.local.yaml', ...(privateOverlay ? ['app-config.private.yaml'] : [])];
  return files.flatMap(f => ['--config', `${prefix}${f}`]);
}

function run(args) {
  const child = spawn('backstage-cli', args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' });
  child.on('exit', (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'start') {
  run(['repo', 'start', ...configArgs('../../'), ...rest.filter(a => a !== '')]);
} else if (mode === 'check') {
  run(['config:check', '--strict', ...configArgs('')]);
} else if (mode !== 'args') {
  console.error('usage: backstage-config.mjs start [args…] | check');
  process.exit(2);
} else {
  // Prints the arguments (one per line) for inspection and tests.
  console.log(configArgs(rest[0] ?? '').join('\n'));
}
