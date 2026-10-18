// @ts-check

/**
 * GPU series keep the last-known names of their VM, node group, cluster and project (from the inventory when
 * the series was written), so the Fleet page names the GPUs of deleted resources instead of raw ids.
 * Nullable: a series first seen after its VM was deleted has none. A later write without names keeps them.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('nebius_estate_gpu_series', t => {
    t.string('instance_name', 200);
    t.string('node_group_name', 200);
    t.string('cluster_name', 200);
    t.string('project_name', 200);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.alterTable('nebius_estate_gpu_series', t => {
    t.dropColumn('instance_name');
    t.dropColumn('node_group_name');
    t.dropColumn('cluster_name');
    t.dropColumn('project_name');
  });
};
