// @ts-check

/**
 * GPU sample store (1-minute samples kept 7 days, hourly roll-ups kept 90 days; pruned on write by
 * SampleStore) and the alert store (current alerts, their state history and local notes).
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  // One row per GPU series: the labels that identify it.
  await knex.schema.createTable('nebius_estate_gpu_series', t => {
    t.string('series_key', 300).primary();
    t.string('project_id', 80).notNullable().index();
    t.string('instance_id', 80);
    t.string('node', 200).notNullable();
    t.string('gpu', 120);
    t.string('cluster_id', 80);
    t.string('node_group_id', 80);
    t.integer('last_seen').notNullable(); // seconds since the epoch
  });

  // 1-minute samples: one row per GPU and minute, every DCGM field in its own column.
  await knex.schema.createTable('nebius_estate_gpu_samples', t => {
    t.string('series_key', 300).notNullable();
    t.integer('ts').notNullable(); // seconds since the epoch, minute-aligned
    t.float('util');
    t.float('temp');
    t.float('power');
    t.float('mem_used');
    t.float('mem_total');
    t.primary(['series_key', 'ts']);
    t.index(['ts']);
  });

  await knex.schema.createTable('nebius_estate_gpu_hourly', t => {
    t.string('series_key', 300).notNullable();
    t.integer('hour').notNullable();
    t.integer('samples').notNullable();
    t.integer('idle_samples').notNullable();
    t.float('util_avg');
    t.float('util_max');
    t.float('temp_avg');
    t.float('temp_max');
    t.float('power_avg');
    t.float('mem_used_avg');
    t.float('mem_total');
    t.primary(['series_key', 'hour']);
    t.index(['hour']);
  });

  // Current state of every alert (rule × label set); resolved alerts stay until pruned.
  await knex.schema.createTable('nebius_estate_alerts', t => {
    t.string('id', 40).primary();
    t.string('rule_id', 300).notNullable().index();
    t.string('state', 16).notNullable().index();
    t.string('severity', 16).notNullable();
    t.string('project_id', 80);
    t.string('active_at', 32).notNullable();
    t.string('resolved_at', 32);
    t.string('last_eval_at', 32).notNullable();
    t.text('payload').notNullable(); // JSON AlertInstance
  });

  // Every state transition (history), kept 90 days.
  await knex.schema.createTable('nebius_estate_alert_events', t => {
    t.increments('seq').primary();
    t.string('alert_id', 40).notNullable().index();
    t.string('rule_id', 300).notNullable();
    t.string('at', 32).notNullable().index();
    t.string('from_state', 16).notNullable();
    t.string('to_state', 16).notNullable();
    t.float('value');
  });

  // Acknowledge / mute: local notes with the user ref. Nothing leaves the portal.
  await knex.schema.createTable('nebius_estate_alert_notes', t => {
    t.string('id', 40).primary();
    t.string('alert_id', 40).notNullable().index();
    t.string('kind', 8).notNullable(); // ack | mute
    t.string('user_ref', 200).notNullable();
    t.text('note');
    t.string('created_at', 32).notNullable();
    t.string('until', 32);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  for (const table of ['nebius_estate_alert_notes', 'nebius_estate_alert_events', 'nebius_estate_alerts', 'nebius_estate_gpu_hourly', 'nebius_estate_gpu_samples', 'nebius_estate_gpu_series']) {
    await knex.schema.dropTable(table);
  }
};
