// @ts-check

/**
 * Nebius Estate schema: daily history, provisioning requests, billing
 * imports and rows, rate books and scenarios.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('nebius_estate_history', t => {
    t.string('day', 10).notNullable();
    t.string('project_id').notNullable();
    t.string('region').notNullable();
    t.string('stage').notNullable();
    t.text('payload').notNullable();
    t.primary(['day', 'project_id', 'region', 'stage']);
  });

  await knex.schema.createTable('nebius_provisioning_requests', t => {
    t.string('id').primary();
    t.string('state').notNullable().index();
    t.string('recipe').notNullable();
    t.string('stage').notNullable();
    t.text('files').notNullable(); // JSON array of repository paths
    t.string('created_by').notNullable();
    t.string('created_at').notNullable();
    t.string('updated_at').notNullable();
    t.text('payload').notNullable(); // JSON ProvisioningRequestRecord
  });

  await knex.schema.createTable('nebius_billing_imports', t => {
    t.string('id').primary();
    t.string('imported_at').notNullable();
    t.string('imported_by').notNullable();
    t.string('filename').notNullable();
    t.text('summary').notNullable();
  });

  // One row per FOCUS row. The filter columns are copied out of the payload
  // so reports select in SQL; supersession updates superseded_by by slot.
  await knex.schema.createTable('nebius_billing_records', t => {
    t.increments('seq').primary();
    t.string('import_id').notNullable().index();
    t.string('slot', 400).notNullable().index(); // billing account × container × charge-period start
    t.string('container_id').notNullable().index();
    t.string('charge_period_start', 30).notNullable().index();
    t.string('region_id').notNullable().index();
    t.string('service_name').notNullable().index();
    t.string('superseded_by').nullable().index();
    t.text('payload').notNullable();
  });

  await knex.schema.createTable('nebius_rate_books', t => {
    t.string('id').primary();
    t.string('classification').notNullable();
    t.string('updated_at').notNullable();
    t.string('updated_by').notNullable();
    t.text('payload', 'longtext').notNullable();
  });

  await knex.schema.createTable('nebius_scenarios', t => {
    t.string('id').primary();
    t.string('created_by').notNullable();
    t.string('updated_at').notNullable();
    t.text('payload').notNullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  for (const table of [
    'nebius_scenarios',
    'nebius_rate_books',
    'nebius_billing_records',
    'nebius_billing_imports',
    'nebius_provisioning_requests',
    'nebius_estate_history',
  ]) {
    await knex.schema.dropTable(table);
  }
};
