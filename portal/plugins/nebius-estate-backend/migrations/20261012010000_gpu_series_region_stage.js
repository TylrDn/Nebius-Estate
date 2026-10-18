// @ts-check

/**
 * GPU series keep the region and stage (nip-stage, own or inherited from the cluster) of their VM when written, so
 * the global region and stage filter keeps the history of VMs that were deleted (live audit G2.1). Nullable: a
 * series written before this has neither, and Fleet falls back to its project's region and stage. A later write
 * without them keeps the stored ones.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('nebius_estate_gpu_series', t => {
    t.string('region', 64);
    t.string('stage', 64);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.alterTable('nebius_estate_gpu_series', t => {
    t.dropColumn('region');
    t.dropColumn('stage');
  });
};
