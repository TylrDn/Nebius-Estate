import assert from 'node:assert/strict';
import { test } from 'node:test';
import { supportedNodeVersion } from '../node-runtime.mjs';

test('Node runtime policy accepts supported LTS versions with the SQLite cleanup fix', () => {
  for (const version of ['22.22.0', 'v24.22.0', '24.22.1', '24.23.0']) {
    assert.equal(supportedNodeVersion(version), true, version);
  }
});

test('Node runtime policy rejects affected Node 24 and unsupported majors', () => {
  for (const version of ['24.18.1', '24.19.0', '24.21.0', '20.19.0', '25.0.0', '26.12.0', '24.22.0-rc.1', 'unknown']) {
    assert.equal(supportedNodeVersion(version), false, version);
  }
});
