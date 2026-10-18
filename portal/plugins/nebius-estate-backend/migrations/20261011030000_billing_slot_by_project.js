// @ts-check

/**
 * Billing rows: one supersession rule and bounded storage.
 *
 *  1. Superseded rows are deleted (imports delete them since this migration; nothing reads them).
 *  2. Every row's slot is re-derived from the project it is attributed to — billing account ×
 *     (x_ProjectId, else x_ContainerId) × charge-period start — the same id the scope checks, reports
 *     and the `container_id` column use (billingSlot in nebius-domain/src/billing.ts). Rows stored
 *     under the old rule (x_ContainerId) and a later import under the new one could then share a
 *     slot while both are active: the rows of the newest import are kept, the others are deleted,
 *     as a re-import would have done.
 *  3. Each import keeps the projects it carried (`projects`, JSON), so the import list (summary,
 *     who, when) still follows the caller's scope after its rows are superseded and deleted.
 * Idempotent: a second run finds nothing to change. Runs after 20261011021100_focus_extension_columns,
 * which fills x_ProjectId on stored rows first.
 * @param {import('knex').Knex} knex
 */
async function reslotAndPrune(knex) {
  const R = 'nebius_billing_records';
  const I = 'nebius_billing_imports';
  const deleted = await knex(R).whereNotNull('superseded_by').delete();

  let reslotted = 0;
  let lastSeq = 0;
  for (;;) {
    const batch = await knex(R).where('seq', '>', lastSeq).orderBy('seq').limit(500).select('seq', 'slot', 'payload');
    if (!batch.length) break;
    lastSeq = batch[batch.length - 1].seq;
    for (const r of batch) {
      /** @type {Record<string, any>} */
      const p = JSON.parse(r.payload);
      if (typeof p.billingAccountId !== 'string' || typeof p.chargePeriodStart !== 'string') continue;
      const slot = [p.billingAccountId, p.projectId || p.containerId || '', p.chargePeriodStart].join('\u001f');
      if (slot === r.slot && p.slot === slot) continue;
      await knex(R).where({ seq: r.seq }).update({ slot, payload: JSON.stringify({ ...p, slot }) });
      reslotted++;
    }
  }

  // Slots held by more than one import: keep the newest import's rows (what a re-import does).
  let collided = 0;
  /** @type {{ slot: string }[]} */
  const shared = await knex(R).select('slot').groupBy('slot').havingRaw('count(distinct import_id) > 1');
  for (const { slot } of shared) {
    const owners = await knex(R).join(I, `${R}.import_id`, `${I}.id`).where(`${R}.slot`, slot).distinct(`${R}.import_id`, `${I}.imported_at`).orderBy(`${I}.imported_at`, 'desc');
    const older = owners.slice(1).map(o => o.import_id);
    if (older.length) {
      await knex(R).where({ slot }).whereIn('import_id', older).delete();
      collided++;
    }
  }

  let imports = 0;
  const missing = await knex(I).whereNull('projects').select('id');
  for (const { id } of missing) {
    const projects = (await knex(R).where({ import_id: id }).distinct('container_id')).map(r => r.container_id).filter(Boolean).sort();
    await knex(I).where({ id }).update({ projects: JSON.stringify(projects) });
    imports++;
  }
  return { deleted, reslotted, collided, imports };
}

exports.reslotAndPrune = reslotAndPrune;

/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('nebius_billing_imports', 'projects'))) {
    await knex.schema.alterTable('nebius_billing_imports', t => {
      t.text('projects'); // JSON array of the project ids the import carried
    });
  }
  await reslotAndPrune(knex);
};

/** Deleted rows cannot be restored; the slot and projects changes are ignored by older code. */
exports.down = async function down() {};
