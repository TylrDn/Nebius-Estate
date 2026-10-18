import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseRegions, parseStages, previewChange, ProvisioningRequestInput } from '@internal/nebius-domain';
import { availabilityFor, liveIssues, quotaCheckFor } from '../views';
import { fitsElsewhere, reservationCheck } from './checks';

/**
 * The live checks of a provisioning preview (W1-P3, W1-P4, #13): quota stops a plan unless a request is pending,
 * where else the request fits by the quota API, reservations against capacity.v1, and an advisor that was not read.
 */

const REPO = resolve(__dirname, '../../../../..');
const read = (p: string) => readFileSync(resolve(REPO, p), 'utf8');
const stages = parseStages(read('platform/stages.yaml')).value;
const regions = parseRegions(read('platform/regions.yaml')).value;
const ctx = { stages, regions, now: new Date('2026-10-10T12:00:00Z'), sizingText: read('terraform/live/sandbox/inference/sandbox.auto.tfvars') };

const input: ProvisioningRequestInput = {
  recipe: 'sandbox-inference', stage: 'sandbox', region: 'eu-north1', gpuNodeCount: 1, capacityType: 'preemptible',
  ttlExpires: '2026-10-10T20:00:00Z', runtimeHours: 8, owner: 'platform', requestRef: 'ticket-1',
};

const tenant = (name: string, region: string, limit: number, usage = 0) => ({ scope: 'tenant', name, region, limit, usage, usagePercent: null }) as any;
const cap = (id: string, state: string, lastSuccess?: string, stale?: boolean) => ({ id, title: id, service: 's', connector: 'nebius-inventory', scope: 'tenant', path: '/', method: 'GET', state, lastSuccess, stale }) as any;
// eu-north1: no non-GPU vCPU (the live account); eu-west1: room for everything the sandbox root needs.
const quotas = [
  tenant('compute.instance.non-gpu.vcpu', 'eu-north1', 0),
  tenant('compute.instance.preemptible.count', 'eu-north1', 8, 1),
  tenant('compute.instance.count', 'eu-north1', 12, 9),
  tenant('compute.instance.non-gpu.vcpu', 'eu-west1', 64),
  tenant('compute.instance.preemptible.count', 'eu-west1', 8),
  tenant('compute.instance.count', 'eu-west1', 12),
  tenant('compute.disk.size.network-ssd', 'eu-west1', 2 ** 40),
];
const footprint = () => previewChange(input, ctx);

describe('W1-P3: a quota that stops the plan disables Prepare unless a quota request is pending', () => {
  const check = () => quotaCheckFor(quotas, footprint().footprint, 'eu-north1', 'preemptible', false, [], 1);

  it('a limit of 0 is an error naming the quota and the way out', () => {
    const issues = liveIssues(check(), undefined, input);
    const q = issues.filter(i => i.field === 'quota');
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ severity: 'error' });
    expect(q[0].message).toMatch(/compute\.instance\.non-gpu\.vcpu\): limit 0, needs 16 vCPU/);
    expect(q[0].message).toMatch(/Prepare anyway: quota request pending/);
  });

  it('"prepare anyway: quota request pending" keeps it as a warning', () => {
    expect(liveIssues(check(), undefined, { ...input, quotaRequestPending: true }).filter(i => i.field === 'quota').map(i => i.severity)).toEqual(['warning']);
  });

  it('names the regions where the same request fits by the quota API, never one without compute allowances', () => {
    const fits = fitsElsewhere(quotas, input, ctx, []);
    expect(fits.map(f => f.region)).toEqual(['eu-west1']);
    expect(fits[0]).toMatchObject({ platform: 'gpu-h200-sxm' });
    // A run profile pins its region: no switch is offered.
    expect(fitsElsewhere(quotas, { ...input, runProfile: 'l40s-gpu-only' }, ctx, [])).toEqual([]);
  });
});

describe('#13: the Provisioning quota card carries the tenant list\'s own read time', () => {
  it('observedAt is the tenant allowances\' last success, and a failed latest read says so', () => {
    const fp = footprint().footprint;
    const ok = quotaCheckFor(quotas, fp, 'eu-north1', 'preemptible', false, [cap('quotas.allowances.tenant', 'ok', '2026-10-10T11:20:00Z')], 1);
    expect(ok.observedAt).toBe('2026-10-10T11:20:00Z');
    const stale = quotaCheckFor(quotas, fp, 'eu-north1', 'preemptible', false, [cap('quotas.allowances.tenant', 'unreachable', '2026-10-10T10:00:00Z', true)], 1);
    expect(stale.observedAt).toBe('2026-10-10T10:00:00Z');
    expect(stale.note).toMatch(/latest read failed/);
  });
});

describe('W1-P4: reservations and the advisor', () => {
  const training: ProvisioningRequestInput = { ...input, recipe: 'training-capacity', stage: 'prod', capacityType: 'reserved', reservationPolicy: 'STRICT', gpuNodeCount: 2, ttlExpires: undefined };
  const fp = previewChange(training, { ...ctx, sizingText: read('terraform/live/prod/training/prod.auto.tfvars') }).footprint;
  const group = (o: object) => ({ id: 'capacityblockgroup-e00mockh100', name: 'h100-fabric-3', region: 'eu-north1', platform: 'gpu-h100-sxm', fabric: 'fabric-3', limit: 16, usage: 8, state: 'STATE_ACTIVE', ...o });
  const seen = [cap('capacity.block-groups', 'ok', '2026-10-10T11:00:00Z')];

  it('STRICT with no matching capacity block group is an error; AUTO is a warning (on-demand burst)', () => {
    const r = reservationCheck([], fp, training, regions, seen)!;
    expect(r.state).toBe('none');
    const issues = liveIssues(undefined, undefined, training, r);
    expect(issues.find(i => i.field === 'reservationPolicy')).toMatchObject({ severity: 'error', message: expect.stringMatching(/no capacity block group for gpu-h100-sxm in eu-north1/) });
    const auto = reservationCheck([], fp, { ...training, reservationPolicy: 'AUTO' }, regions, seen)!;
    expect(liveIssues(undefined, undefined, { ...training, reservationPolicy: 'AUTO' }, auto).find(i => i.field === 'reservationPolicy')?.severity).toBe('warning');
  });

  it('lists the matching reservations; another region or platform does not match', () => {
    const r = reservationCheck([group({}), group({ id: 'x', region: 'eu-west1' }), group({ id: 'y', platform: 'gpu-h200-sxm' })], fp, training, regions, seen)!;
    expect(r.state).toBe('matching');
    expect(r.groups.map(g => g.id)).toEqual(['capacityblockgroup-e00mockh100']);
    expect(liveIssues(undefined, undefined, training, r).filter(i => i.severity === 'error')).toEqual([]);
  });

  it('block groups not read: unknown, never "no reservation"', () => {
    const r = reservationCheck([], fp, training, regions, [cap('capacity.block-groups', 'permission-denied')])!;
    expect(r.state).toBe('unknown');
    expect(liveIssues(undefined, undefined, training, r).find(i => i.field === 'reservationPolicy')?.severity).toBe('warning');
    expect(reservationCheck([], fp, { ...training, capacityType: 'on-demand', reservationPolicy: undefined }, regions, seen)).toBeUndefined();
  });

  it('advisor not read: "availability unknown", never fits', () => {
    const od = { ...training, stage: 'sandbox', capacityType: 'on-demand' as const, reservationPolicy: undefined };
    const a = availabilityFor([], fp, od, { regions }, [cap('capacity.resource-advice', 'unreachable')])!;
    expect(a.state).toBe('unknown');
    expect(a.message).toMatch(/Availability unknown/);
    expect(liveIssues(undefined, a, od).find(i => i.field === 'gpuNodeCount')).toMatchObject({ severity: 'warning', message: expect.stringMatching(/Availability unknown/) });
    // Read and answered with nothing for the shape: no advice, still not "fits".
    expect(availabilityFor([], fp, od, { regions }, [cap('capacity.resource-advice', 'ok')])!.state).toBe('no-advice');
  });

  it('the advisor judges the fabric the request names', () => {
    const od = { ...training, stage: 'sandbox', capacityType: 'on-demand' as const, reservationPolicy: undefined, fabric: 'fabric-4' };
    const advice = [
      { region: 'eu-north1', fabric: 'fabric-3', platform: 'gpu-h100-sxm', preset: '8gpu-128vcpu-1600gb', onDemand: { level: 'limit-reached', available: 0 } },
      { region: 'eu-north1', fabric: 'fabric-4', platform: 'gpu-h100-sxm', preset: '8gpu-128vcpu-1600gb', onDemand: { level: 'high', available: 6 } },
    ];
    expect(availabilityFor(advice, fp, od, { regions }, [cap('capacity.resource-advice', 'ok')])).toMatchObject({ state: 'ok', fabric: 'fabric-4' });
    const def = availabilityFor(advice, fp, { ...od, fabric: null }, { regions }, [cap('capacity.resource-advice', 'ok')])!;
    expect(def).toMatchObject({ state: 'limit-reached', fabric: 'fabric-3' });
    expect(def.alternatives[0]).toMatchObject({ region: 'eu-north1', fabric: 'fabric-4' });
  });
});
