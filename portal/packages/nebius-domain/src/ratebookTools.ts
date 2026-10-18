import { ZodIssue } from 'zod';
import { parseCsv, toCsv } from './csv';
import { Decimal } from './decimal';
import { ChargeComponent, RateBook, RateBookKind, RateEntry, rateBookSchema, rateEntrySchema } from './pricing';
import { parsePreset } from './units';

/**
 * Rate books made without typing JSON (W1-P6, W1-P7): from the Nebius billing calculator's current list prices, or
 * from a CSV built on a downloadable template. Both go through `rateBookSchema`, as an imported JSON book does.
 */

/** The built-in price source: the live calculator's list price, priced per scenario, never stored (W1-P6). */
export const LIVE_LIST_BOOK_ID = 'nebius-list-price';
export const LIVE_LIST_BOOK_NAME = 'Nebius list price (live calculator)';

/** One calculator answer, per hour: a VM of a preset, or a storage spec of a size. */
export type ListPriceItem =
  | { kind: 'instance'; region: string; platform: string; preset: string; capacityType: 'on-demand' | 'preemptible'; hourly: string }
  | { kind: 'storage'; region: string; component: Extract<ChargeComponent, 'boot-disk' | 'disk-ssd' | 'disk-io-m3' | 'filesystem'>; gib: number; hourly: string };

/**
 * Rate entries from calculator prices: a GPU VM becomes a per-GPU rate of its preset that bundles the preset's vCPU
 * and RAM (the calculator prices the whole VM), a CPU VM a per-vCPU rate with RAM at 0 (included), a storage spec a
 * per-GiB-hour rate. Preemptible prices are marked variable (the spot price at that moment).
 */
export function listPriceBook(o: { id: string; name: string; currency: string; retrievedAt: string; source: string; items: ListPriceItem[] }): RateBook {
  const day = o.retrievedAt.slice(0, 10);
  const base = { provider: 'nebius', currency: o.currency.toUpperCase(), effectiveFrom: day, source: o.source, retrievedAt: o.retrievedAt, classification: 'public' as const };
  const entries: RateEntry[] = [];
  for (const it of o.items) {
    if (it.kind === 'storage') {
      entries.push(rateEntrySchema.parse({
        ...base, id: `${it.region}-${it.component}`.slice(0, 120), region: it.region, service: 'compute', component: it.component,
        unit: { quantity: 'storage_gib', per: 'hour' }, capacityType: 'any', price: Decimal.from(it.hourly).div(it.gib).toString(),
        note: `Calculator price of a ${it.gib} GiB spec, per GiB.`,
      }));
      continue;
    }
    const shape = parsePreset(it.preset);
    if (!shape) continue;
    const variable = it.capacityType === 'preemptible' ? { priceSemantics: 'variable' as const } : {};
    const id = `${it.region}-${it.platform}-${it.preset}-${it.capacityType}`.slice(0, 116);
    if (shape.gpus > 0) {
      entries.push(rateEntrySchema.parse({
        ...base, ...variable, id, region: it.region, service: 'compute', platform: it.platform, preset: it.preset, component: 'gpu',
        unit: { quantity: 'gpu', per: 'hour' }, capacityType: it.capacityType, price: Decimal.from(it.hourly).div(shape.gpus).toString(), bundles: ['vcpu', 'ram'],
        note: `Calculator price of the ${it.preset} VM, per GPU; its vCPU and RAM are included.`,
      }));
    } else {
      entries.push(
        rateEntrySchema.parse({
          ...base, ...variable, id: `${id}-v`, region: it.region, service: 'compute', platform: it.platform, preset: it.preset, component: 'vcpu',
          unit: { quantity: 'vcpu', per: 'hour' }, capacityType: it.capacityType, price: Decimal.from(it.hourly).div(shape.vcpus).toString(),
          note: `Calculator price of the ${it.preset} VM, per vCPU; its RAM is included.`,
        }),
        rateEntrySchema.parse({
          ...base, ...variable, id: `${id}-r`, region: it.region, service: 'compute', platform: it.platform, preset: it.preset, component: 'ram',
          unit: { quantity: 'ram_gib', per: 'hour' }, capacityType: it.capacityType, price: '0', note: 'RAM is included in the vCPU rate (the calculator prices the whole VM).',
        }),
      );
    }
  }
  return rateBookSchema.parse({ id: o.id, name: o.name, kind: 'public-list', classification: 'public', currency: o.currency.toUpperCase(), entries, note: `Built from ${o.source} at ${o.retrievedAt}.` });
}

/* --------------------------------------------------------------------- CSV */

const REQUIRED = ['id', 'region', 'service', 'component', 'quantity', 'per', 'capacity_type', 'price', 'effective_from', 'source'] as const;
const OPTIONAL = ['platform', 'preset', 'effective_to', 'bundles', 'note'] as const;
const COLUMNS = ['id', 'region', 'service', 'platform', 'preset', 'component', 'quantity', 'per', 'capacity_type', 'price', 'effective_from', 'effective_to', 'source', 'bundles', 'note'];

/** The schema's field path in the CSV's column names. */
const COLUMN_OF: Record<string, string> = { 'unit.quantity': 'quantity', 'unit.per': 'per', capacityType: 'capacity_type', effectiveFrom: 'effective_from', effectiveTo: 'effective_to' };

/** A downloadable template: the columns and two example rows in the test currency XTS (invented prices). */
export function rateBookCsvTemplate(): string {
  return toCsv(COLUMNS, [
    ['gpu-h100-od', 'eu-north1', 'compute', 'gpu-h100-sxm', '', 'gpu', 'gpu', 'hour', 'on-demand', '2.00', '2026-10-01', '', 'Example: order form 12 (replace)', 'vcpu;ram', 'Per GPU-hour; the VM\'s vCPU and RAM are included'],
    ['ssd', 'eu-north1', 'compute', '', '', 'disk-ssd', 'storage_gib', 'month730', 'any', '0.07', '2026-10-01', '', 'Example: order form 12 (replace)', '', 'Per GiB per 730 h month'],
  ]);
}

const issueText = (row: number, i: ZodIssue) => {
  const path = i.path.join('.');
  const column = COLUMN_OF[path] ?? path;
  // The allowed values in words, whichever zod version names them (options or values).
  const allowed = (i as { options?: unknown[]; values?: unknown[] }).options ?? (i as { values?: unknown[] }).values;
  const message = Array.isArray(allowed) && allowed.length ? `must be one of ${allowed.join(', ')}` : i.message;
  return `row ${row}: ${column}: ${message}`;
};

/**
 * A rate book from a CSV upload (W1-P7): one rate per row, in the template's columns; every wrong row and field is
 * named, and no book is built while any row is wrong (nothing half-imported).
 */
export function rateBookFromCsv(
  text: string,
  meta: { id: string; name: string; kind: RateBookKind; classification: 'public' | 'confidential'; currency: string; retrievedAt?: string },
): { book?: RateBook; errors: string[]; rows: number } {
  const parsed = parseCsv(text, 5000, COLUMNS.length + 5);
  const missing = REQUIRED.filter(c => !parsed.header.includes(c));
  if (missing.length) return { errors: [`missing columns: ${missing.join(', ')}`], rows: parsed.rows.length };
  const errors = parsed.errors.map(e => `row ${e.line}: ${e.message}`);
  const entries: RateEntry[] = [];
  parsed.rows.forEach((r, i) => {
    const row = i + 2;
    const opt = (k: (typeof OPTIONAL)[number]) => (r[k]?.trim() ? r[k].trim() : undefined);
    const e = rateEntrySchema.safeParse({
      id: r.id?.trim(), provider: 'nebius', region: r.region?.trim(), service: r.service?.trim(), platform: opt('platform'), preset: opt('preset'),
      component: r.component?.trim(), unit: { quantity: r.quantity?.trim(), per: r.per?.trim() }, capacityType: r.capacity_type?.trim(),
      currency: meta.currency, price: r.price?.trim(), effectiveFrom: r.effective_from?.trim(), effectiveTo: opt('effective_to'), source: r.source?.trim(),
      retrievedAt: meta.retrievedAt ?? new Date().toISOString(), classification: meta.classification,
      bundles: opt('bundles')?.split(/[;,]/).map(x => x.trim()).filter(Boolean) ?? [], note: opt('note'),
    });
    if (e.success) entries.push(e.data);
    else errors.push(...e.error.issues.map(x => issueText(row, x)));
  });
  if (errors.length) return { errors, rows: parsed.rows.length };
  const book = rateBookSchema.safeParse({ id: meta.id, name: meta.name, kind: meta.kind, classification: meta.classification, currency: meta.currency, entries });
  if (!book.success) return { errors: book.error.issues.map(x => `${x.path.join('.') || 'book'}: ${x.message}`), rows: parsed.rows.length };
  return { book: book.data, errors: [], rows: parsed.rows.length };
}
