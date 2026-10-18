import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('doctor reports missing tools with remedies without invoking installs or exposing credentials', async () => {
  const script = fileURLToPath(new URL('../doctor.mjs', import.meta.url));
  const child = spawn(process.execPath, [script], { env: { PATH: '/nonexistent-estate-doctor-path', NEBIUS_IAM_TOKEN: 'never-print-this' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(code, 1);
  assert.match(output, /Node.*architecture|architecture.*Node/is);
  assert.match(output, /Yarn.*corepack enable/is);
  assert.match(output, /Docker.*Docker/is);
  const browser = output.split('\n').find(line => /Chromium cache/.test(line));
  assert.ok(browser, 'doctor must report browser prerequisite status');
  if (!browser.startsWith('OK ')) assert.match(browser, /playwright install chromium/);
  assert.doesNotMatch(output, /never-print-this/);
});

test('doctor accepts the checked-in readable Yarn release without executable permission', async () => {
  const script = fileURLToPath(new URL('../doctor.mjs', import.meta.url));
  const child = spawn(process.execPath, [script], { env: { PATH: '/nonexistent-estate-doctor-path' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.match(output, /OK Pinned Yarn release/);
});
