import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dataManagerPath = require.resolve('@material-table/core/dist/utils/data-manager.js');
// Resolve from the real consumer: a hoisted safe copy must not mask a nested old UUID.
const tableRequire = createRequire(dataManagerPath);
const uuid = tableRequire('uuid');
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('material-table generates valid unique row keys with its resolved UUID dependency', () => {
  const DataManager = require(dataManagerPath).default;
  const manager = new DataManager();
  manager.setData([{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }]);
  const keys = manager.data.map(row => row.tableData.uuid);
  keys.forEach(key => assert.match(key, uuidV4Pattern));
  assert.equal(new Set(keys).size, 2);
});

test('material-table retains generated row keys and selection when data refreshes', () => {
  const DataManager = require(dataManagerPath).default;
  const manager = new DataManager();
  manager.setColumns([{ title: 'Name', field: 'name' }]);
  manager.setData([{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }]);
  const selectedKey = manager.data[0].tableData.uuid;
  manager.getRenderState();
  manager.changeRowSelected(true, [0]);
  manager.setData([{ id: 1, name: 'alpha refreshed' }, { id: 2, name: 'beta' }]);
  assert.equal(manager.data[0].tableData.uuid, selectedKey);
  assert.equal(manager.data[0].tableData.checked, true);
  assert.equal(manager.selectedCount, 1);
  manager.getRenderState();
  manager.changeRowSelected(false, [0]);
  assert.equal(manager.selectedCount, 0);
  assert.equal(manager.data[0].tableData.checked, false);
});

test('material-table preserves caller-provided row keys', () => {
  const DataManager = require(dataManagerPath).default;
  const manager = new DataManager();
  manager.setData([{ id: 1, uuid: 'external-row-key' }]);
  assert.equal(manager.data[0].tableData.uuid, 'external-row-key');
});

test('resolved UUID supports the CommonJS v4 API used by existing consumers', () => {
  assert.match(uuid.v4(), uuidV4Pattern);
  const output = new Uint8Array(20).fill(0xaa);
  assert.equal(uuid.v4({}, output, 4), output);
  assert.deepEqual([...output.slice(0, 4)], [0xaa, 0xaa, 0xaa, 0xaa]);
  assert.equal(output[10] >> 4, 4);
  assert.equal(output[12] >> 6, 2);
});

for (const name of ['v3', 'v5', 'v6']) {
  test(`resolved UUID ${name} rejects invalid output bounds before modifying the buffer`, () => {
    const invoke = (output, offset) => name === 'v6'
      ? uuid.v6({}, output, offset)
      : uuid[name]('www.widgets.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8', output, offset);
    for (const [length, offset] of [[8, 0], [16, 1], [16, -1]]) {
      const output = new Uint8Array(length).fill(0xaa);
      assert.throws(() => invoke(output, offset), RangeError);
      assert.deepEqual([...output], Array(length).fill(0xaa));
    }
    const output = new Uint8Array(20).fill(0xaa);
    assert.equal(invoke(output, 4), output);
    assert.deepEqual([...output.slice(0, 4)], [0xaa, 0xaa, 0xaa, 0xaa]);
    assert.equal(output[10] >> 4, Number(name.slice(1)));
    assert.equal(output[12] >> 6, 2);
  });
}
