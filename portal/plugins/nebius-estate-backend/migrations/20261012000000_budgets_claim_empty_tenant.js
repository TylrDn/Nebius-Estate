// @ts-check

/**
 * Budgets, credits and spend entries saved while no tenant id was configured carry an empty tenant_id,
 * and the store reads only the configured tenant's rows, so they vanished from Budgets once the tenant
 * was mapped (F1.32). This gives them to the tenant the backend runs with (`nebius.tenantId`, passed by
 * `migrate()` as `knex.userParams.nebiusTenantId`). Without one it does nothing; it never deletes, and a
 * re-run changes nothing. The store also reads empty-tenant rows, for any saved after this ran.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const tenantId = knex.userParams?.nebiusTenantId;
  if (!tenantId) return;
  for (const name of ['nebius_budgets', 'nebius_credits', 'nebius_spend_entries']) {
    await knex(name).where({ tenant_id: '' }).update({ tenant_id: tenantId });
  }
};

/**
 * Which rows had an empty tenant is not recorded, so there is nothing to undo.
 */
exports.down = async function down() {};
