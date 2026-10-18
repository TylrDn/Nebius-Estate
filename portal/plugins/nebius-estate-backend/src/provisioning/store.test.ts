import knex, { Knex } from 'knex';
import { ConflictError } from '@backstage/errors';
import { migrate } from '../database';
import { ProvisioningStore } from './store';

describe('ProvisioningStore', () => {
  let db: Knex;
  beforeEach(async () => {
    db = knex({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    await migrate(db);
  });
  afterEach(() => db.destroy());

  const prepare = (store: ProvisioningStore) =>
    store.insert(
      {
        input: { recipe: 'soperator-lab', stage: 'sandbox', region: 'eu-north1', gpuNodeCount: 0, capacityType: 'on-demand', runtimeHours: 8, owner: 'platform', requestRef: 'ticket-1' },
        createdBy: 'user:default/admin',
        baseHashes: {},
        patch: '',
        issues: [],
      },
      {},
    );

  it('allows only the documented transitions', async () => {
    const store = new ProvisioningStore(db);
    const rec = await prepare(store);
    await expect(store.transition(rec.id, 'deployed')).rejects.toBeInstanceOf(ConflictError);
    expect((await store.transition(rec.id, 'approved')).state).toBe('approved');
    expect((await store.transition(rec.id, 'deployed', { evidence: 'docs/evidence/run.md' })).evidence).toBe('docs/evidence/run.md');
  });

  it('refuses a transition from a state that changed since it was read (compare-and-set)', async () => {
    const store = new ProvisioningStore(db);
    const rec = await prepare(store);
    const stale = await store.get(rec.id);
    await store.transition(rec.id, 'withdrawn');
    jest.spyOn(store, 'get').mockResolvedValueOnce(stale); // a concurrent caller still sees `prepared`
    await expect(store.transition(rec.id, 'approved')).rejects.toBeInstanceOf(ConflictError);
    expect((await store.get(rec.id)).state).toBe('withdrawn');
  });
});
