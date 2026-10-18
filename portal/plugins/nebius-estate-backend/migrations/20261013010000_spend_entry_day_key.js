// @ts-check

/**
 * One Token Factory spend entry per provider and day (W1-P22), held by the database: `day_key` is
 * "<provider>|<date>" and unique per tenant, so two writes for the same day cannot both be stored, whatever their
 * timing. Days entered twice before this migration keep both rows (nothing is deleted); the newest holds the day and
 * the others have no key until they are edited or deleted.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('nebius_spend_entries', t => {
    t.string('day_key', 80);
  });
  const rows = await knex('nebius_spend_entries').select('id', 'tenant_id', 'payload').orderBy([{ column: 'updated_at', order: 'desc' }, { column: 'id', order: 'desc' }]);
  const held = new Set();
  for (const r of rows) {
    let key;
    try {
      const p = JSON.parse(r.payload);
      key = typeof p.provider === 'string' && typeof p.date === 'string' ? `${p.provider}|${p.date}` : undefined;
    } catch {
      key = undefined;
    }
    if (!key || held.has(`${r.tenant_id}\n${key}`)) continue;
    held.add(`${r.tenant_id}\n${key}`);
    await knex('nebius_spend_entries').where({ id: r.id }).update({ day_key: key });
  }
  await knex.schema.alterTable('nebius_spend_entries', t => {
    t.unique(['tenant_id', 'day_key'], { indexName: 'nebius_spend_entries_day_key' });
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('nebius_spend_entries', t => {
    t.dropUnique(['tenant_id', 'day_key'], 'nebius_spend_entries_day_key');
    t.dropColumn('day_key');
  });
};
