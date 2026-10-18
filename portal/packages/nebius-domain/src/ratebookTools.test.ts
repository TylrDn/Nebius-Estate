import { estimateScenario } from './pricing';
import { LIVE_LIST_BOOK_ID, listPriceBook, rateBookCsvTemplate, rateBookFromCsv } from './ratebookTools';

const at = '2026-10-12T10:00:00.000Z';

describe('a rate book from current list prices (W1-P6, W1-P7)', () => {
  const book = listPriceBook({
    id: 'list-2026-10-12',
    name: 'List prices 2026-10-12',
    currency: 'XTS',
    retrievedAt: at,
    source: 'Nebius billing calculator (list price), project nip-sandbox',
    items: [
      { kind: 'instance', region: 'eu-north1', platform: 'gpu-h100-sxm', preset: '1gpu-16vcpu-200gb', capacityType: 'on-demand', hourly: '2.95' },
      { kind: 'instance', region: 'eu-north1', platform: 'gpu-h100-sxm', preset: '8gpu-128vcpu-1600gb', capacityType: 'preemptible', hourly: '12' },
      { kind: 'instance', region: 'eu-north1', platform: 'cpu-d3', preset: '8vcpu-32gb', capacityType: 'on-demand', hourly: '0.2' },
      { kind: 'storage', region: 'eu-north1', component: 'disk-ssd', gib: 100, hourly: '0.0097' },
    ],
  });

  it('turns priced VMs into per-GPU rates that bundle the preset\'s vCPU and RAM, and CPU VMs into a vCPU rate', () => {
    expect(book).toMatchObject({ id: 'list-2026-10-12', kind: 'public-list', classification: 'public', currency: 'XTS' });
    const gpu = book.entries.find(e => e.preset === '1gpu-16vcpu-200gb')!;
    expect(gpu).toMatchObject({ region: 'eu-north1', component: 'gpu', platform: 'gpu-h100-sxm', unit: { quantity: 'gpu', per: 'hour' }, capacityType: 'on-demand', price: '2.95', bundles: ['vcpu', 'ram'], effectiveFrom: '2026-10-12', retrievedAt: at, classification: 'public' });
    expect(book.entries.find(e => e.preset === '8gpu-128vcpu-1600gb')).toMatchObject({ price: '1.5', capacityType: 'preemptible', priceSemantics: 'variable' });
    const cpu = book.entries.filter(e => e.platform === 'cpu-d3');
    expect(cpu.map(e => [e.component, e.price])).toEqual([['vcpu', '0.025'], ['ram', '0']]);
    expect(cpu[1].note).toMatch(/included in the vCPU rate/);
    expect(book.entries.find(e => e.component === 'disk-ssd')).toMatchObject({ unit: { quantity: 'storage_gib', per: 'hour' }, price: '0.000097' });
  });

  it('prices a scenario the same way as the calculator priced the VM (no double counting)', () => {
    const fp = { nodeGroups: [{ name: 'gpu', role: 'gpu' as const, platform: 'gpu-h100-sxm', preset: '1gpu-16vcpu-200gb', count: 2, bootDiskGib: 0 }] };
    const e = estimateScenario({ name: 's', recipe: 'custom', region: 'eu-north1', currency: 'XTS', rateBookId: LIVE_LIST_BOOK_ID, capacityType: 'on-demand', asOf: '2026-10-12', runtime: { activeHours: 1 }, footprints: { min: fp, expected: fp, max: fp } }, book);
    expect(e.footprints[1].hourly.amount).toBe('5.9');
  });
});

describe('rate book CSV: template and upload (W1-P7)', () => {
  const meta = { id: 'negotiated-q4', name: 'Negotiated Q4', kind: 'negotiated' as const, classification: 'confidential' as const, currency: 'XTS' };

  it('the template parses back into a valid rate book', () => {
    const r = rateBookFromCsv(rateBookCsvTemplate(), meta);
    expect(r.errors).toEqual([]);
    expect(r.book!.entries.length).toBeGreaterThan(1);
    expect(r.book!.entries[0]).toMatchObject({ region: 'eu-north1', component: 'gpu', currency: 'XTS' });
  });

  it('names each wrong row and field, and builds no book when any row is wrong', () => {
    const csv = [
      'id,region,service,platform,preset,component,quantity,per,capacity_type,price,effective_from,effective_to,source,bundles,note',
      'gpu,eu-north1,compute,gpu-h100-sxm,,gpu,gpu,hour,on-demand,2.95,2026-10-01,,Order form 12,vcpu;ram,',
      'bad,eu-north1,compute,,,disk-ssd,storage_gib,week,any,1e3,2026-10-01,,Order form 12,,',
    ].join('\n');
    const r = rateBookFromCsv(csv, meta);
    expect(r.book).toBeUndefined();
    expect(r.errors).toEqual(['row 3: per: must be one of second, hour, month730', 'row 3: price: must be a plain decimal string (no exponent, no separators)']);
    expect(rateBookFromCsv('region,price\neu-north1,1', meta).errors[0]).toMatch(/^missing columns: id, service/);
  });
});
