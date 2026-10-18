// @ts-check

/**
 * Recorded sync runs per connector and per API capability (connector health).
 * Kept 7 days; pruned on write by HealthStore.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('nebius_estate_sync_runs', t => {
    t.increments('id').primary();
    t.string('kind', 16).notNullable(); // connector | capability
    t.string('subject', 120).notNullable();
    t.string('started_at', 32).notNullable();
    t.integer('duration_ms').notNullable();
    t.boolean('ok').notNullable();
    t.string('error_class', 40);
    t.integer('http_status');
    t.integer('items');
    t.index(['subject', 'started_at']);
    t.index(['started_at']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('nebius_estate_sync_runs');
};
