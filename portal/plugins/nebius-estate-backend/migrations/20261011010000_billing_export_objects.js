// @ts-check

/**
 * Objects read from the billing export bucket: key, ETag and size, so a file is
 * imported once and again only when it changes.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('nebius_billing_export_objects', t => {
    t.string('object_key', 1024).primary();
    t.string('etag', 200).notNullable();
    t.bigInteger('size').notNullable();
    t.string('last_modified', 40);
    t.string('status', 16).notNullable(); // imported | failed
    t.string('import_id', 64);
    t.string('processed_at', 32).notNullable();
    t.text('error');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('nebius_billing_export_objects');
};
