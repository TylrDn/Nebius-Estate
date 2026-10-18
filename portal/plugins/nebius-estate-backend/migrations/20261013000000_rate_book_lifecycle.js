// @ts-check

/**
 * Rate-book lifecycle (W1-P8): a book can be archived (kept for the scenarios that price with it, never picked as a
 * default or offered for a new scenario) and one book can be the portal default, stored here instead of guessed as
 * the first by id. A configured default (nebiusEstate.commercial.defaultRateBook) still wins.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('nebius_rate_books', t => {
    t.string('archived_at', 32);
    t.boolean('is_default').notNullable().defaultTo(false);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('nebius_rate_books', t => {
    t.dropColumn('archived_at');
    t.dropColumn('is_default');
  });
};
