import { bucketize, bucketizeHourly, bucketStarts, distinctNames, GpuSample, heatLevel, meanUtilisation, rollupHourly, rollupRows, seriesOf, utilisationTitle, windowText } from './telemetry';

const T0 = Date.parse('2026-10-11T08:00:00Z') / 1000;

describe('GPU series identity', () => {
  it('uses the VM id and the GPU uuid Nebius Monitoring labels (verified live), with the MK8s placement', () => {
    const s = seriesOf('project-a', { instance_id: 'computeinstance-1', instance: 'computeinstance-1', uuid: 'GPU-07ca', mk8s_cluster_id: 'mk8scluster-1', mk8s_node_group_id: 'mk8snodegroup-1' });
    expect(s).toEqual({ key: 'project-a|computeinstance-1|GPU-07ca', projectId: 'project-a', instanceId: 'computeinstance-1', node: 'computeinstance-1', gpu: 'GPU-07ca', clusterId: 'mk8scluster-1', nodeGroupId: 'mk8snodegroup-1' });
  });
  it('keeps a series without a VM id under its host', () => {
    expect(seriesOf('p', { Hostname: 'bench-1', gpu: '0' }).key).toBe('p|bench-1|0');
  });
});

describe('hourly roll-ups', () => {
  it('average, max and idle minutes per GPU and hour; hours without samples are absent, not zero', () => {
    const samples: GpuSample[] = [
      { key: 'g', ts: T0, util: 0, temp: 40, power: 100, memUsed: 10, memTotal: 100 },
      { key: 'g', ts: T0 + 60, util: 4, temp: 50, power: 200 },
      { key: 'g', ts: T0 + 120, util: 80, temp: 60, power: 300 },
      { key: 'g', ts: T0 + 7200, util: 50 },
    ];
    const rows = rollupHourly(samples).sort((a, b) => a.hour - b.hour);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ hour: T0, samples: 3, idleSamples: 2, utilAvg: 28, utilMax: 80, tempAvg: 50, tempMax: 60, powerAvg: 200, memUsedAvg: 10, memTotal: 100 });
    expect(rows[1]).toMatchObject({ hour: T0 + 7200, samples: 1, idleSamples: 0, tempAvg: null });
  });
});

describe('Fleet buckets', () => {
  it('cover the range ending at the current bucket', () => {
    const starts = bucketStarts('1h', T0 + 59);
    expect(starts).toHaveLength(60);
    expect(starts[59]).toBe(T0);
    expect(starts[0]).toBe(T0 - 59 * 60);
    expect(bucketStarts('7d', T0)).toHaveLength(168);
  });

  it('average samples per bucket, leave unobserved buckets null and count idle minutes', () => {
    const starts = bucketStarts('6h', T0);
    const last = starts[starts.length - 1];
    const b = bucketize(
      [
        { key: 'g', ts: last, util: 2, temp: 40, memUsed: 50, memTotal: 100 },
        { key: 'g', ts: last + 60, util: 6, temp: 42 },
        { key: 'g', ts: last - 3 * 3600, util: 90 },
        { key: 'g', ts: last - 30 * 3600, util: 90 }, // outside the range
      ],
      starts,
      300,
    );
    expect(b.util[starts.length - 1]).toBe(4);
    expect(b.temp[starts.length - 1]).toBe(41);
    expect(b.mem[starts.length - 1]).toBe(50);
    expect(b.util[0]).toBeNull();
    expect(b.idleMinutes).toBe(1);
    expect(b.samples).toBe(3);
  });

  it('read the 7-day range from hourly roll-ups', () => {
    const starts = bucketStarts('7d', T0);
    const b = bucketizeHourly(
      [{ key: 'g', hour: T0, samples: 60, idleSamples: 30, utilAvg: 10, utilMax: 50, tempAvg: 40, tempMax: 45, powerAvg: 100, memUsedAvg: 20, memTotal: 80 }],
      starts,
    );
    expect(b.util[starts.length - 1]).toBe(10);
    expect(b.mem[starts.length - 1]).toBe(25);
    expect(b.util[0]).toBeNull();
    expect(b.idleMinutes).toBe(30);
  });

  it('roll rows up per node group with idle GPU-hours; no samples is null, not 0', () => {
    const row = (idleMinutes: number, util: (number | null)[]) => ({ key: String(Math.random()), projectId: 'p', node: 'n', idleMinutes, samples: 10, runningNow: true, values: { util, temp: [70], power: [], mem: [] } });
    const r = rollupRows([row(90, [10, 20]), row(30, [null])], 'ng', 'gpu', 'node-group');
    expect(r).toEqual({ id: 'ng', name: 'gpu', kind: 'node-group', gpus: 2, meanUtil: 15, maxTemp: 70, idleGpuHours: 2 });
    expect(rollupRows([row(0, [null])], 'x', 'x', 'cluster').meanUtil).toBeNull();
  });

  it('map values to colour levels per metric; unknown stays unknown', () => {
    expect(heatLevel('util', 50)).toBe(0.5);
    expect(heatLevel('temp', 90)).toBe(1);
    expect(heatLevel('temp', 20)).toBe(0);
    expect(heatLevel('power', 350, 700)).toBe(0.5);
    expect(heatLevel('util', null)).toBeNull();
  });
});

describe('GPU utilisation: one name, the window in every title, one mean (F1.1)', () => {
  it('names the figure the same way everywhere and says which window it covers', () => {
    expect(utilisationTitle('latest')).toBe('GPU utilisation · latest sample');
    expect(utilisationTitle('daily')).toBe('GPU utilisation · daily mean');
    expect(utilisationTitle('24h')).toBe('GPU utilisation · mean, last 24 h');
    expect(utilisationTitle('7d')).toBe('GPU utilisation · mean, last 7 d');
    for (const w of ['latest', 'daily', '1h', '6h', '24h', '7d'] as const) expect(utilisationTitle(w)).toMatch(/^GPU utilisation · /);
  });

  it('computes the mean one way: unobserved is left out, never zero; one decimal', () => {
    expect(meanUtilisation([63.5, 12])).toBe(37.8);
    expect(meanUtilisation([10, null, 20, undefined])).toBe(15);
    expect(meanUtilisation([null])).toBeNull();
    expect(meanUtilisation([])).toBeNull();
  });

  it('words the window once, so a column header and a card title over the same window read alike', () => {
    expect(windowText('latest')).toBe('latest sample');
    expect(windowText('24h')).toBe('mean, last 24 h');
    for (const w of ['latest', 'daily', '1h', '6h', '24h', '7d'] as const) expect(utilisationTitle(w)).toBe(`GPU utilisation · ${windowText(w)}`);
  });
});

describe('labels that read the same (W1F.N4)', () => {
  it('tells runs of one name apart by their last sample, then by id; unique names stay as they are', () => {
    const out = distinctNames([
      { id: 'computeinstance-e00mockrunaaa', name: 'nip-sandbox-gpu-vm (standalone VM, deleted)', lastSampleAt: '2026-10-11T14:20:00Z' },
      { id: 'computeinstance-e00mockrunbbb', name: 'nip-sandbox-gpu-vm (standalone VM, deleted)', lastSampleAt: '2026-10-12T09:05:00Z' },
      { id: 'computeinstance-e00mockrunccc', name: 'nip-sandbox-gpu-vm (standalone VM, deleted)', lastSampleAt: '2026-10-12T09:05:00Z' },
      { id: 'x', name: 'nip-lab-gpu (standalone VM)', lastSampleAt: '2026-10-12T09:05:00Z' },
    ]);
    expect(out.map(o => o.name)).toEqual([
      'nip-sandbox-gpu-vm (standalone VM, deleted) · last sample 10-11 14:20 UTC',
      'nip-sandbox-gpu-vm (standalone VM, deleted) · last sample 10-12 09:05 UTC · …runbbb',
      'nip-sandbox-gpu-vm (standalone VM, deleted) · last sample 10-12 09:05 UTC · …runccc',
      'nip-lab-gpu (standalone VM)',
    ]);
    expect(new Set(out.map(o => o.name)).size).toBe(4);
  });
});
