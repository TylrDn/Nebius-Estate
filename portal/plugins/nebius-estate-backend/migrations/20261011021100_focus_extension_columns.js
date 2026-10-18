// @ts-check

/**
 * Nebius FOCUS extension columns (x_TenantId, x_TenantName, x_ProjectId, x_ProjectName, x_TrialId,
 * x_ContractPriceId, x_UsageBasedDiscountIds) are parsed since 2026-10-11. Rows imported before then
 * lack them. This migration:
 *  1. clears the literal NULL the export writes for "no value" from every stored text field and the
 *     indexed region/service columns, and re-derives what a stored row implies (the project from a container that is a project) and fills
 *     the other fields with '' — the same rule as withFocusExtensions in nebius-domain/src/billing.ts;
 *  2. queues every export-bucket file whose import reported these columns as unknown for a re-import
 *     on the next sync (ETag cleared): re-importing an hour supersedes the old rows, so the trial and
 *     tenant fields arrive without double counting.
 * Both steps are idempotent: a filled row is left alone, and a re-imported file no longer reports the
 * columns as unknown. Manual uploads cannot be re-read (the file is not kept): import them again on
 * Costs to get x_TrialId.
 * @param {import('knex').Knex} knex
 */
async function backfill(knex) {
  const FIELDS = ['tenantId', 'tenantName', 'projectId', 'projectName', 'trialId', 'contractPriceId', 'usageBasedDiscountIds'];
  let rows = 0;
  let lastSeq = 0;
  for (;;) {
    const batch = await knex('nebius_billing_records').where('seq', '>', lastSeq).orderBy('seq').limit(500).select('seq', 'payload');
    if (!batch.length) break;
    lastSeq = batch[batch.length - 1].seq;
    for (const r of batch) {
      const raw = JSON.parse(r.payload);
      const isNull = /** @param {unknown} v */ v => typeof v === 'string' && v.trim().toUpperCase() === 'NULL';
      if (FIELDS.every(f => typeof raw[f] === 'string') && !Object.values(raw).some(isNull)) continue;
      /** @type {Record<string, any>} */
      const p = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, isNull(v) ? '' : v]));
      const containerIsProject = /^project-[a-z0-9]+$/.test(p.containerId ?? '');
      /** @type {Record<string, any>} */
      const next = {
        ...p,
        tenantId: p.tenantId ?? '',
        tenantName: p.tenantName ?? '',
        projectId: p.projectId ?? (containerIsProject ? p.containerId : ''),
        projectName: p.projectName ?? (containerIsProject ? p.containerName : ''),
        trialId: p.trialId ?? '',
        contractPriceId: p.contractPriceId ?? '',
        usageBasedDiscountIds: p.usageBasedDiscountIds ?? '',
      };
      await knex('nebius_billing_records').where({ seq: r.seq }).update({ payload: JSON.stringify(next), container_id: next.projectId || next.containerId, region_id: next.regionId, service_name: next.serviceName });
      rows++;
    }
  }
  const NEW = ['x_TenantId', 'x_TenantName', 'x_ProjectId', 'x_ProjectName'];
  const imports = await knex('nebius_billing_imports').select('id', 'summary');
  const stale = imports.filter(i => {
    try {
      const unknown = JSON.parse(i.summary).unknownColumns ?? [];
      return unknown.some(/** @param {string} c */ c => NEW.includes(c));
    } catch {
      return false;
    }
  }).map(i => i.id);
  let files = 0;
  for (let i = 0; i < stale.length; i += 200) {
    files += await knex('nebius_billing_export_objects').whereIn('import_id', stale.slice(i, i + 200)).where('status', 'imported').update({ etag: '', status: 'reimport' });
  }
  return { rows, files };
}

exports.backfill = backfill;

/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await backfill(knex);
};

/** Nothing to undo: the added fields are ignored by older code. */
exports.down = async function down() {};
