// @ts-check

/**
 * Budgets, credits and Token Factory spend entries the owner types in (Budgets & credits page).
 * Nebius exposes no API for them; they are local data, never in git. Every row carries its owner
 * (created_by) and tenant, so the portal can serve a team later without a data migration.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  for (const name of ['nebius_budgets', 'nebius_credits', 'nebius_spend_entries']) {
    await knex.schema.createTable(name, t => {
      t.string('id', 64).primary();
      t.string('tenant_id', 120).notNullable().defaultTo('');
      t.string('created_by', 300).notNullable();
      t.string('updated_by', 300).notNullable();
      t.string('updated_at', 32).notNullable();
      t.text('payload').notNullable();
    });
  }
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  for (const name of ['nebius_spend_entries', 'nebius_credits', 'nebius_budgets']) await knex.schema.dropTable(name);
};
