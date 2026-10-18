import type { CapabilityRow, CapabilityStatus, ConnectorStatus, HealthStats } from '@internal/nebius-domain';
import { verifiedOf, connectorOf, gapText, observedState, describeRuns, docHref, isFlaky, needsAttentionOrFlaky, rateTone, sharedOutages, syncIncidents, incidentTitle, ownFailures, rowConnectors, fmtDuration, fmtRate, groupCapabilities, matrixPaths, matrixView, parseHint } from './model';

const cap = (over: Partial<CapabilityStatus>): CapabilityStatus => ({
  id: 'compute.instances',
  title: 'VMs',
  service: 'compute',
  connector: 'nebius-inventory',
  scope: 'project',
  path: '/compute/v1/instances',
  method: 'GET',
  state: 'ok',
  ...over,
});

describe('groupCapabilities', () => {
  it('groups by service area in a fixed order, most urgent first inside a group', () => {
    const groups = groupCapabilities([
      cap({ id: 'vpc.networks', service: 'vpc', title: 'Networks' }),
      cap({ id: 'compute.disks', title: 'Disks' }),
      cap({ id: 'compute.instances', title: 'VMs', state: 'permission-denied' }),
      cap({ id: 'x.y', service: 'zzz', title: 'Unknown' }),
    ]);
    expect(groups.map(g => g.label)).toEqual(['Compute', 'VPC networking', 'zzz']);
    expect(groups[0].items.map(c => c.title)).toEqual(['VMs', 'Disks']);
    expect(groups[0].counts).toEqual([['permission-denied', 1], ['ok', 1]]);
  });
});

describe('connectorOf', () => {
  it('uses the connector the backend reports for each call', () => {
    expect(connectorOf(cap({ id: 'monitoring.gpu', service: 'monitoring', connector: 'nebius-monitoring' }))).toBe('nebius-monitoring');
    expect(connectorOf(cap({ id: 'billing.calculator.contract', service: 'billing', connector: 'nebius-pricing' }))).toBe('nebius-pricing');
    expect(connectorOf(cap({ id: 'billing.pricing-policies', service: 'billing' }))).toBe('nebius-inventory');
  });
});

describe('matrixPaths / matrixView', () => {
  it('expands brace lists, drops methods, queries and host notes, and normalises placeholders', () => {
    expect(matrixPaths('GET /capacity/v1/{capacity-block-groups,resource-advice}?parentId=<tenant>')).toEqual(['/capacity/v1/capacity-block-groups', '/capacity/v1/resource-advice']);
    expect(matrixPaths('GET /mk8s/v1/clusters, /mk8s/v1/node-groups?parentId=<cluster>')).toEqual(['/mk8s/v1/clusters', '/mk8s/v1/node-groups']);
    expect(matrixPaths('GET /projects/<project>/service-provider/prometheus/api/v1/query (read.monitoring.api.nebius.cloud)')).toEqual(['/projects/{}/service-provider/prometheus/api/v1/query']);
    expect(matrixPaths(undefined)).toEqual([]);
  });

  it('joins rows with live capabilities and connectors, and takes the verified date from the data', () => {
    const row = (over: Partial<CapabilityRow>): CapabilityRow => ({ service: 's', documentedApi: 'a', implemented: true, permissions: 'p', tested: 'contract-tested', fallback: 'f', freshness: 'x', limitations: '', ...over });
    const statuses = [{ id: 'kubernetes:prod', title: 'Kubernetes — prod', state: 'ok' } as ConnectorStatus];
    const [mon, k8s, none] = matrixView(
      [
        row({ service: 'mon', restPath: 'GET /projects/<project>/service-provider/prometheus/api/v1/query (host)', connector: 'nebius-monitoring' }),
        row({ service: 'k8s', connector: 'kubernetes' }),
        row({ service: 'slurm', implemented: false, tested: 'not-implemented' }),
      ],
      [cap({ id: 'monitoring.gpu', service: 'monitoring', path: '/projects/{project}/service-provider/prometheus/api/v1/query', state: 'permission-denied', verified: '2026-10-11' })],
      statuses,
    );
    expect(mon.capabilities).toHaveLength(1);
    expect(mon.verified).toBe('2026-10-11');
    expect(k8s.connectors.map(s => s.id)).toEqual(['kubernetes:prod']);
    expect(none.capabilities).toEqual([]);
    expect(none.connectors).toEqual([]);
  });
});

describe('parseHint', () => {
  it('splits role names as code and repository docs as links', () => {
    expect(parseHint('Refused for this identity: grant a `viewer` access permit (docs/credentials.md).')).toEqual([
      { kind: 'text', text: 'Refused for this identity: grant a ' },
      { kind: 'code', text: 'viewer' },
      { kind: 'text', text: ' access permit (' },
      { kind: 'doc', text: 'docs/credentials.md', path: 'docs/credentials.md' },
      { kind: 'text', text: ').' },
    ]);
  });
  it('links docs in sub-folders at their section ("Set up: docs/portal/…#kubernetes")', () => {
    expect(parseHint('docs/portal/nebius-setup.md#kubernetes')).toEqual([{ kind: 'doc', text: 'docs/portal/nebius-setup.md#kubernetes', path: 'docs/portal/nebius-setup.md', anchor: 'kubernetes' }]);
    expect(docHref('docs/portal/nebius-setup.md', 'kubernetes')).toBe(`/evidence?doc=${encodeURIComponent('docs/portal/nebius-setup.md')}#kubernetes`);
  });

  it('does not link docs outside the document viewer allowlist', () => {
    expect(parseHint('docs/evidence/raw/README.md').every(p => p.kind === 'text')).toBe(true);
  });
});

describe('health formatting', () => {
  const h = { runs24h: 40, successRate24h: 0.975, p50Ms: 820, p95Ms: 2450, consecutiveFailures: 0, recentRuns: [] };

  it('formats rates and durations, and never shows 0 % for no runs', () => {
    expect(fmtRate(h)).toBe('97.5 %');
    expect(fmtRate({ ...h, runs24h: 0, successRate24h: null })).toBe('no run in 24 h');
    expect(fmtDuration(820)).toBe('820 ms');
    expect(fmtDuration(2450)).toBe('2.5 s');
    expect(fmtDuration(null)).toBe('n/a');
  });

  it('describes recent runs for screen readers', () => {
    expect(
      describeRuns([
        { at: '2026-10-11T10:00:00Z', ok: false, durationMs: 30000, errorClass: 'unreachable' },
        { at: '2026-10-11T09:45:00Z', ok: true, durationMs: 900 },
      ]),
    ).toBe('Last 2 runs: 1 succeeded, 1 failed; newest failed (unreachable) in 30.0 s');
  });
});

describe('matrix rows for Kubernetes', () => {
  it('joins the MK8s row to discovered clusters (mk8s:*) and promotes it once a cluster answered', () => {
    const row: CapabilityRow = { service: 'Kubernetes workloads', documentedApi: 'k8s', restPath: 'GET https://<pu|pr>.<cluster>.mk8s.<region>.nebius.cloud/api/v1/…', implemented: true, connector: 'mk8s:<cluster id> (configured clusters: kubernetes:<name>)', permissions: 'p', tested: 'contract-tested', fallback: 'kubectl', freshness: 'x', limitations: '' };
    expect(rowConnectors(row.connector).prefixes).toEqual(expect.arrayContaining(['mk8s:', 'kubernetes:']));
    const k8sCap = cap({ id: 'k8s.cluster:mk8scluster-e00x', service: 'mk8s', connector: 'mk8s:mk8scluster-e00x', path: 'https://pu.mk8scluster-e00x.mk8s.eu-north1.nebius.cloud/api/v1', items: 6, lastSuccess: '2026-10-11T06:30:00Z' });
    const [v] = matrixView([row], [k8sCap], [{ id: 'mk8s:mk8scluster-e00x', title: 'Kubernetes — c', state: 'ok' } as ConnectorStatus]);
    expect(v.capabilities.map(c => c.id)).toEqual(['k8s.cluster:mk8scluster-e00x']);
    expect(v.verified).toBe('2026-10-11');
    // The legacy connector name "kubernetes" means the same clusters.
    const [w] = matrixView([{ ...row, restPath: undefined, connector: 'kubernetes' }], [], [{ id: 'mk8s:mk8scluster-e00x', title: 'Kubernetes — c', state: 'ok' } as ConnectorStatus]);
    expect(w.connectors.map(s => s.id)).toEqual(['mk8s:mk8scluster-e00x']);
  });
});

describe('flaky capabilities', () => {
  it('a call that answers now but failed runs in 24 h needs attention as flaky', () => {
    const h = { runs24h: 38, successRate24h: 0.763, p50Ms: 1, p95Ms: 2, consecutiveFailures: 0, recentRuns: [] };
    expect(isFlaky(cap({ health: h }))).toBe(true);
    expect(needsAttentionOrFlaky(cap({ health: h }))).toBe(true);
    expect(needsAttentionOrFlaky(cap({ health: { ...h, successRate24h: 1 } }))).toBe(false);
    expect(isFlaky(cap({ health: { ...h, runs24h: 0, successRate24h: null } }))).toBe(false);
  });
});

describe('one failed sync for every call is an outage, not flaky calls (G1.6)', () => {
  const OUT = '2026-10-12T04:20:17.000Z';
  const h = (runs24h: number, failures24h: number, lastFailureAt?: string) => ({ runs24h, failures24h, successRate24h: (runs24h - failures24h) / runs24h, p50Ms: 1, p95Ms: 2, consecutiveFailures: 0, lastFailureAt, recentRuns: [] });
  const slow = Array.from({ length: 16 }, (_, i) => cap({ id: `slow${i}`, health: h(55, 1, OUT) }));
  const fast = Array.from({ length: 30 }, (_, i) => cap({ id: `fast${i}`, health: h(124, 1, OUT) }));

  it('finds the attempt most calls failed together', () => {
    expect([...sharedOutages([], [...slow, ...fast])]).toEqual([OUT]);
    // Two calls failing at once are not an outage of the host.
    expect([...sharedOutages([], [cap({ health: h(55, 1, OUT) }), cap({ health: h(55, 1, OUT) }), ...fast.map(c => cap({ ...c, health: h(124, 0) }))])]).toEqual([]);
  });

  it('a single shared failure flags no call and keeps the rate green; a call that failed on its own twice is flaky', () => {
    const outages = sharedOutages([], [...slow, ...fast]);
    expect(slow.filter(c => isFlaky(c, outages))).toEqual([]);
    expect(needsAttentionOrFlaky(slow[0], outages)).toBe(false);
    expect(rateTone(slow[0].health!, outages)).toBe('ok');
    const own = cap({ health: h(55, 3, '2026-10-12T09:00:00.000Z') });
    expect(isFlaky(own, outages)).toBe(true);
    expect(rateTone(own.health!, outages)).toBe('warn');
    // One failure of its own is one blip, not a pattern.
    expect(isFlaky(cap({ health: h(55, 1, '2026-10-12T09:00:00.000Z') }), outages)).toBe(false);
  });

  it('one failure of its own below 99 % is a blip in every view: rate tone, flaky bucket and attention agree', () => {
    const outages = sharedOutages([], [...slow, ...fast]);
    // 54 of 55 = 98.2 %, one failure not at the shared outage.
    const blip = cap({ health: h(55, 1, '2026-10-12T09:00:00.000Z') });
    expect(isFlaky(blip, outages)).toBe(false);
    expect(needsAttentionOrFlaky(blip, outages)).toBe(false);
    expect(rateTone(blip.health!, outages)).toBe('ok');
    // A single run that failed and has not answered since is not a blip.
    expect(rateTone({ ...h(1, 1, '2026-10-12T09:00:00.000Z'), consecutiveFailures: 1 }, outages)).toBe('danger');
    // Two of its own: flaky, and the rate is amber too.
    const twice = cap({ health: h(55, 2, '2026-10-12T09:00:00.000Z') });
    expect(isFlaky(twice, outages)).toBe(true);
    expect(rateTone(twice.health!, outages)).toBe('warn');
  });
});

describe('incidents: one connector\'s failed sync is its own, and every failure at one is shared (#28, #35, W1-P27)', () => {
  const T1 = '2026-10-12T16:23:00.000Z';
  const T2 = '2026-10-12T16:38:00.000Z';
  const T0 = '2026-10-12T08:00:00.000Z';
  const OWN = '2026-10-12T11:00:00.000Z';
  const run = (at: string, ok: boolean) => ({ at, ok, durationMs: 10 });
  const health = (runs: { at: string; ok: boolean; durationMs: number }[], over: Partial<HealthStats> = {}): HealthStats => {
    const failed = runs.filter(r => !r.ok);
    return { runs24h: runs.length, failures24h: failed.length, successRate24h: (runs.length - failed.length) / runs.length, p50Ms: 1, p95Ms: 2, consecutiveFailures: runs[0].ok ? 0 : 1, lastFailureAt: failed[0]?.at, recentRuns: runs, ...over };
  };
  // 35 inventory calls failed in the 16:23 sync and answered at 16:38; Monitoring and pricing answered throughout.
  const inventory = Array.from({ length: 35 }, (_, i) => cap({ id: `inv${i}`, health: health([run(T2, true), run(T1, false), run(T0, true)]) }));
  const monitoring = cap({ id: 'monitoring.gpu', connector: 'nebius-monitoring', health: health([run(T2, true), run(T1, true)]) });
  const statuses = [
    { id: 'nebius-inventory', health: health([run(T2, true), run(T1, false)]) },
    { id: 'nebius-monitoring', health: health([run(T2, true), run(T1, true)]) },
    { id: 'nebius-pricing', health: health([run(T2, true), run(T1, true)]) },
  ];

  it('one connector\'s failed sync is one incident of that connector, with its call count and recovery, never "every connector"', () => {
    const [i, ...rest] = syncIncidents(statuses, [...inventory, monitoring]);
    expect(rest).toEqual([]);
    expect(i).toEqual({ at: T1, connectors: ['nebius-inventory'], calls: 35, recoveredAt: T2 });
    expect(incidentTitle(i, id => (id === 'nebius-inventory' ? 'Nebius inventory' : id))).toBe('Nebius inventory: one sync failed across 35 calls');
    expect(incidentTitle(i)).not.toMatch(/every connector/);
  });

  it('two connectors failing in the same sync are said as such', () => {
    const mon = Array.from({ length: 3 }, (_, k) => cap({ id: `mon${k}`, connector: 'nebius-monitoring', health: health([run(T2, true), run(T1, false)]) }));
    const [i] = syncIncidents(statuses, [...inventory, ...mon]);
    expect(i.connectors).toEqual(['nebius-inventory', 'nebius-monitoring']);
    expect(incidentTitle(i)).toBe('One sync failed for 2 connectors at once (38 calls)');
  });

  it('an older shared failure is not the call\'s own (#28): only the newest was left out before', () => {
    // 16:23 newest shared failure, 08:00 an older shared one, 11:00 its own: one failure of its own, a blip.
    const older = [...Array.from({ length: 10 }, (_, k) => cap({ id: `o${k}`, health: health([run(T2, true), run(T1, false), run(OWN, true), run(T0, false)]) }))];
    const call = cap({ id: 'x', health: health([run(T2, true), run(T1, false), run(OWN, false), run(T0, false)]) });
    const outages = sharedOutages(statuses, [...older, call]);
    expect([...outages].sort()).toEqual([T0, T1]);
    expect(ownFailures(call.health!, outages)).toBe(1);
    expect(isFlaky(call, outages)).toBe(false);
  });

  it('a shared failure older than the 24 h window is not taken off the 24 h failures', () => {
    const DAY_BEFORE = '2026-10-11T08:00:00.000Z';
    // Two failures of its own today, and one at a shared outage the day before (outside failures24h).
    const call = cap({ id: 'x', health: health([run(T2, true), run(T1, false), run(OWN, false), run(DAY_BEFORE, false)], { failures24h: 2, runs24h: 3 }) });
    expect(ownFailures(call.health!, new Set([DAY_BEFORE]))).toBe(2);
    expect(isFlaky(call, new Set([DAY_BEFORE]))).toBe(true);
    // Inside the window it is still left out.
    expect(ownFailures(call.health!, new Set([T1]))).toBe(1);
  });
});

describe('one verification date for a call, on its row and in the matrix (G1.16)', () => {
  it('takes the later of the catalog check and the last live answer', () => {
    const c = cap({ verified: '2026-10-11', state: 'ok', lastSuccess: '2026-10-12T15:45:00Z' });
    expect(verifiedOf(c)).toEqual({ date: '2026-10-12', checked: '2026-10-11', answered: '2026-10-12' });
    expect(verifiedOf(cap({ verified: '2026-10-11', state: 'permission-denied', lastSuccess: undefined }))).toEqual({ date: '2026-10-11', checked: '2026-10-11', answered: undefined });
    expect(verifiedOf(cap({ verified: undefined, lastSuccess: undefined }))).toBeUndefined();
  });
});

describe('Kubernetes matrix row without a cluster', () => {
  it('reads idle (not "no call") and keeps the hand-verified date', () => {
    const row: CapabilityRow = { service: 'Kubernetes workloads', documentedApi: 'k8s', implemented: true, connector: 'mk8s:<cluster id> (configured clusters: kubernetes:<name>)', permissions: 'p', tested: 'live-verified', verifiedOn: '2026-10-11', fallback: 'kubectl', freshness: 'x', limitations: '' };
    const [v] = matrixView([row], [], [{ id: 'kubernetes', title: 'Kubernetes workloads (optional)', state: 'optional' } as ConnectorStatus]);
    expect(v.idle).toMatch(/^idle: no Managed Kubernetes cluster/);
    expect(v.verified).toBe('2026-10-11');
    // A configured cluster that was not called is not idle.
    const [w] = matrixView([row], [], [{ id: 'kubernetes:prod', title: 'Kubernetes — prod', state: 'stale' } as ConnectorStatus]);
    expect(w.idle).toBeUndefined();
    expect(w.connectors.map(s => s.id)).toEqual(['kubernetes:prod']);
  });
});


describe('observedState', () => {
  const runs = [{ at: '2026-10-11T10:25:17Z', ok: true, durationMs: 700, items: 9 }];
  it('a call skipped by the quick sync that answered on the full sync reads as answered, not "not configured"', () => {
    const c = observedState(cap({ id: 'iam.projects.list', state: 'not-configured', health: { runs24h: 119, successRate24h: 1, consecutiveFailures: 0, failures24h: 0, recentRuns: runs } as any }));
    expect(c.state).toBe('ok');
    expect(c.hint).toMatch(/full sync/);
  });
  it('leaves a call that never answered alone', () => {
    expect(observedState(cap({ state: 'not-configured' })).state).toBe('not-configured');
    expect(observedState(cap({ state: 'permission-denied', health: { recentRuns: runs } as any })).state).toBe('permission-denied');
  });
});

describe('a call that failed without an answer (F1.30)', () => {
  it('names its cause in full on the card, not cut to "fetch fa"', () => {
    const error = 'https://api.nebius.cloud/compute/v1/instances: fetch failed (ECONNRESET: read ECONNRESET) after 9 attempts in 28 s';
    const c = { state: 'unreachable' as const, perProject: [{ id: 'project-e00mocklab', name: 'lab', state: 'unreachable' as const, items: 0, error }, { id: 'project-e00mocksandbox', name: 'sandbox', state: 'ok' as const, items: 3 }] };
    expect(gapText(c)).toBe('unreachable in lab (fetch failed (ECONNRESET: read ECONNRESET) after 9 attempts in 28 s)');
    // An HTTP failure still reads by its status.
    expect(gapText({ ...c, perProject: [{ ...c.perProject[0], error: 'https://api.nebius.cloud/x → 503 after 4 attempts' }] })).toBe('unreachable in lab (503)');
  });
});
