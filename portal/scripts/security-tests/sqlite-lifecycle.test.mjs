import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const backendRequire = createRequire(require.resolve('@backstage/backend-defaults'));

// Allocation-driven GC (not explicit global.gc()) exercises Node's native addon
// cleanup hooks. Affected Node 24 releases abort before the query loop completes.
test('installed SQLite statements survive allocation-driven collection and clean shutdown', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const Database = require(${JSON.stringify(backendRequire.resolve('better-sqlite3'))});
    const db = new Database(':memory:');
    db.exec('CREATE TABLE example (value INTEGER); INSERT INTO example VALUES (42)');
    let allocations = [];
    for (let i = 0; i < 100000; i++) {
      assert.equal(db.prepare('SELECT value FROM example').get().value, 42);
      allocations.push({ i, padding: 'x'.repeat(100) });
      if (allocations.length > 1000) allocations = [];
    }
    db.close();
    console.log('SQLITE_LIFECYCLE_COMPLETE');
  `], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  assert.match(child.stdout, /SQLITE_LIFECYCLE_COMPLETE/);
});
