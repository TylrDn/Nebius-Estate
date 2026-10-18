import { ReactNode, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { FleetGpuRow, FleetMetric, FleetRange, FleetResponse, FleetRollup, ServicePanel } from '@internal/nebius-domain';
import { FLEET_RANGES, meanUtilisation, utilisationTitle, windowText } from '@internal/nebius-domain';
import {
  Async,
  Badge,
  Callout,
  Card,
  Column,
  DataTable,
  Drawer,
  EmptyState,
  filterQuery,
  fmtAgo,
  fmtMoney,
  fmtNumber,
  fmtTime,
  Icon,
  KeyValue,
  PageShell,
  Segmented,
  StatTile,
  StatusPill,
  useGet,
  useGlobalFilter,
  usePortalNow,
} from '../ui';
import { bucketLabel, bucketWords, fmtGpuHours, fmtMetric, fmtRate, gpuLabel, groupByReason, groupRows, heatClass, lastOf, logsRangeFor, meanOf, METRICS, nodeGroupDrill, powerMax, RANGES, rowLabels, rowState } from './model';

/** A window in words as a column header: "Mean, last 24 h". */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const enc = encodeURIComponent;

/** Fleet: every GPU over time from the portal's sample store, roll-ups, idle cost and service health. */
export function FleetPage() {
  const [filter] = useGlobalFilter();
  const [params, setParams] = useSearchParams();
  const range = (FLEET_RANGES as readonly string[]).includes(params.get('range') ?? '') ? (params.get('range') as FleetRange) : '24h';
  const metric = (METRICS.find(m => m.id === params.get('metric'))?.id ?? 'util') as FleetMetric;
  const focus = params.get('focus') ?? undefined;
  const set = (k: string, v?: string) =>
    setParams(
      p => {
        const n = new URLSearchParams(p);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );
  const load = useGet<FleetResponse>(`/fleet${filterQuery(filter, { range })}`);
  const now = usePortalNow();

  return (
    <PageShell
      title="Fleet"
      subtitle="Every GPU over time from the portal's own sample store (Nebius Monitoring, read each sync), with roll-ups, the cost of idle GPUs and the health of storage services."
    >
      <div className="ne-row" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <Segmented label="Time range" options={RANGES} value={range} onChange={v => set('range', v === '24h' ? undefined : v)} />
        <Segmented label="Colour by" options={METRICS.map(m => ({ id: m.id, label: m.label }))} value={metric} onChange={v => set('metric', v === 'util' ? undefined : v)} />
      </div>
      <Async load={load} rows={8}>
        {f => (
          <>
            <Freshness f={f} now={now} />
            <div className="ne-grid ne-grid-tiles">
              <StatTile
                label="GPUs in the selected range"
                icon="gpu"
                now={now}
                metric={
                  f.rows.length
                    ? {
                        value: f.gpus?.inRange ?? f.rows.length,
                        source: f.freshness.source,
                        observedAt: f.freshness.lastSampleAt,
                        note: `${fmtNumber(f.gpus?.runningNow ?? f.rows.filter(r => r.runningNow).length)} running now · ${f.rollups.nodeGroups.length} node group(s) or standalone VM(s), ${f.rollups.clusters.length} cluster(s)`,
                      }
                    : { value: null, source: f.freshness.source, unavailableReason: f.freshness.reason ?? 'No GPU reported in this range.' }
                }
                render={v => fmtNumber(v)}
              />
              <StatTile
                label={utilisationTitle(range)}
                icon="gpu"
                now={now}
                metric={(() => {
                  const m = meanUtilisation(f.rows.flatMap(r => r.values.util));
                  return m === null ? { value: null, source: f.freshness.source, unavailableReason: 'No utilisation sample in this range.' } : { value: m, unit: '%', source: f.freshness.source, observedAt: f.freshness.lastSampleAt, note: `Mean of every sampled ${bucketWords(f.bucketSeconds)} bucket of every GPU in the range. Overview and Capacity show the latest sample.` };
                })()}
                render={v => fmtNumber(v, 1)}
              />
              <StatTile
                label="Idle GPU time (below 5 %)"
                icon="costs"
                tone={f.idle.value?.gpuHours ? 'warn' : undefined}
                now={now}
                metric={f.idle}
                render={v => (
                  <>
                    {fmtGpuHours(v.gpuHours)}
                    <span className="ne-tile-unit">{' '}GPU-hours</span>
                  </>
                )}
                extra={
                  f.idle.value ? (
                    <div className="ne-tile-reason">
                      {f.idle.value.cost ? (
                        <>
                          ≈ <strong>{fmtMoney(f.idle.value.cost)}</strong> estimated at the live price
                          {f.idle.value.pricedGpuHours < f.idle.value.gpuHours ? ` (${fmtGpuHours(f.idle.value.pricedGpuHours)} of ${fmtGpuHours(f.idle.value.gpuHours)} GPU-hours priced)` : ''}
                        </>
                      ) : f.idle.value.gpuHours ? (
                        'Not priced: see why below.'
                      ) : (
                        'No GPU was idle in this range.'
                      )}
                    </div>
                  ) : null
                }
              />
              <StatTile
                label="Hottest GPU"
                icon="warn"
                now={now}
                metric={(() => {
                  const max = f.rows.reduce<number | null>((a, r) => r.values.temp.reduce<number | null>((b, v) => (v !== null && (b === null || v > b) ? v : b), a), null);
                  return max === null ? { value: null, source: f.freshness.source, unavailableReason: 'No temperature sample in this range.' } : { value: max, unit: '°C', source: f.freshness.source, observedAt: f.freshness.lastSampleAt, note: 'Highest bucket mean in the range; GpuHot alerts at 85 °C for 5 min.' };
                })()}
                render={v => fmtNumber(v, 1)}
                tone={undefined}
              />
            </div>

            <div className="ne-section">
              <HeatMap f={f} metric={metric} focus={focus} now={now} onFocus={k => set('focus', k)} />
            </div>

            {f.idle.value?.unpriced.length ? (
              <div className="ne-section">
                <Callout tone="info" title="Idle hours not priced">
                  {/* One reason, said once, with the VMs it covers (the same sentence five times reads as five problems). */}
                  <ul className="ne-ov-mini">
                    {groupByReason(f.idle.value.unpriced).map(g => (
                      <li key={g.reason}>
                        {g.reason} ({g.names.length === 1 ? 'VM' : `${g.names.length} VMs`}: <strong>{g.names.join(', ')}</strong>)
                      </li>
                    ))}
                  </ul>
                </Callout>
              </div>
            ) : null}

            <div className="ne-section ne-grid ne-grid-2">
              <RollupCard title="Node groups and standalone VMs" rows={f.rollups.nodeGroups} range={range} empty="No GPU in this range." />
              <RollupCard title="Clusters" rows={f.rollups.clusters} range={range} empty="No GPU in this range belongs to a Managed Kubernetes cluster." />
            </div>

            <h2 className="ne-section-title ne-section">Service health</h2>
            <div className="ne-svc-grid">
              {f.services.map(s => (
                <ServiceCard key={s.id} s={s} now={now} />
              ))}
            </div>
            <p className="ne-faint" style={{ fontSize: 12, marginTop: 12 }}>
              {f.freshness.source}. {f.retention}
            </p>
          </>
        )}
      </Async>
    </PageShell>
  );
}

function Freshness({ f, now }: { f: FleetResponse; now: Date }) {
  const s = f.freshness;
  if (s.state === 'live') {
    return (
      <p className="ne-muted" style={{ marginTop: 0 }}>
        <StatusPill state="ok" label="live" /> Last sample {fmtAgo(s.lastSampleAt, now)} ({fmtTime(s.lastSampleAt)}); history since {fmtTime(s.oldestSampleAt)}.
      </p>
    );
  }
  const title =
    s.state === 'stale'
      ? `Stale: last sample ${fmtAgo(s.lastSampleAt, now)}`
      : s.state === 'not-reporting'
        ? `No GPU reporting now: last sample ${fmtAgo(s.lastSampleAt, now)} (${fmtTime(s.lastSampleAt)})`
        : s.state === 'waiting'
          ? 'Waiting for the first GPU samples'
          : 'GPU telemetry is not set up';
  return (
    <div style={{ marginBottom: 12 }}>
      <Callout tone={s.state === 'stale' ? 'warn' : 'info'} title={title}>
        {s.reason} {s.state !== 'not-configured' && s.state !== 'not-reporting' ? <Link to="/integrations">Connector state on Integrations →</Link> : null}
      </Callout>
    </div>
  );
}

function HeatMap({ f, metric, focus, now, onFocus }: { f: FleetResponse; metric: FleetMetric; focus?: string; now: Date; onFocus: (key?: string) => void }) {
  const [hover, setHover] = useState<string>();
  const pmax = useMemo(() => powerMax(f.rows), [f.rows]);
  const groups = useMemo(() => groupRows(f.rows), [f.rows]);
  const labels = useMemo(() => rowLabels(f.rows), [f.rows]);
  const m = METRICS.find(x => x.id === metric)!;
  const n = f.buckets.length;
  const range = f.range;
  const selected = f.rows.find(r => r.key === focus || (focus !== undefined && r.instanceId === focus));
  const legend = (
    <div className="ne-heat-legend" aria-hidden>
      <span>{m.scale[0]}</span>
      <span className="ne-heat-scale">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className={`ne-heat-swatch ne-heat-c${i}`} />
        ))}
      </span>
      <span>{m.scale[2]}</span>
      <span className="ne-heat-swatch ne-heat-cnone" style={{ border: '1px solid var(--ne-border)' }} />
      <span>not observed</span>
    </div>
  );
  return (
    <Card title={`GPU ${m.label.toLowerCase()} over time`} icon="fleet" actions={legend}>
      {!f.rows.length ? (
        <EmptyState title="No GPU samples in this range" icon="gpu">
          {f.freshness.reason ?? 'No GPU in scope reported DCGM metrics in this range. Choose a longer range, or clear the filter.'}
        </EmptyState>
      ) : (
        <>
          <div className="ne-heat-hover" aria-live="polite">
            {hover ?? `One row per GPU, one column per ${f.bucketSeconds >= 3600 ? 'hour' : `${f.bucketSeconds / 60} min`}. Select a GPU for its VM, node group and logs.`}
          </div>
          <div className="ne-heat" role="group" aria-label={`Heat map of GPU ${m.label.toLowerCase()}; the table below lists the same values`}>
            {groups.map(g => (
              <HeatGroup key={g.key} title={g.title}>
                {g.rows.map(r => (
                  <HeatRow
                    key={r.key}
                    r={r}
                    label={labels.get(r.key) ?? gpuLabel(r)}
                    metric={metric}
                    pmax={pmax}
                    n={n}
                    selected={selected?.key === r.key}
                    onSelect={() => onFocus(selected?.key === r.key ? undefined : r.key)}
                    onHover={i => setHover(i === undefined ? undefined : `${labels.get(r.key) ?? gpuLabel(r)} · ${bucketLabel(f.buckets[i], range)} UTC · ${fmtMetric(metric, r.values[metric][i])}`)}
                  />
                ))}
              </HeatGroup>
            ))}
            <div className="ne-heat-axis" aria-hidden>
              <span>{bucketLabel(f.buckets[0], range)}</span>
              <span>{bucketLabel(f.buckets[Math.floor(n / 2)], range)}</span>
              <span>{bucketLabel(f.buckets[n - 1], range)} UTC</span>
            </div>
          </div>
          <table className="ne-sr-only">
            <caption>GPU {m.label.toLowerCase()} per GPU in the selected range</caption>
            <thead>
              <tr>
                <th scope="col">GPU</th>
                <th scope="col">{metric === 'util' ? utilisationTitle(range) : sentence(windowText(range))}</th>
                <th scope="col">Last {bucketWords(f.bucketSeconds)} bucket</th>
                <th scope="col">Idle hours</th>
              </tr>
            </thead>
            <tbody>
              {f.rows.map(r => (
                <tr key={r.key}>
                  <th scope="row">{labels.get(r.key) ?? gpuLabel(r)}</th>
                  <td>{fmtMetric(metric, meanOf(r.values[metric]))}</td>
                  <td>{fmtMetric(metric, lastOf(r.values[metric]))}</td>
                  <td>{fmtGpuHours(r.idleMinutes / 60)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <GpuDrawer r={selected} f={f} metric={metric} now={now} onClose={() => onFocus(undefined)} />
    </Card>
  );
}

function HeatGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <div className="ne-heat-group">{title}</div>
      {children}
    </>
  );
}

function HeatRow({ r, label, metric, pmax, n, selected, onSelect, onHover }: { r: FleetGpuRow; label: string; metric: FleetMetric; pmax: number; n: number; selected: boolean; onSelect: () => void; onHover: (i?: number) => void }) {
  const vals = r.values[metric];
  return (
    <>
      <button type="button" className="ne-heat-label" aria-pressed={selected} onClick={onSelect} title={`${label} — ${r.instanceId ?? r.node}${r.notRunning ? ` — not running now: ${r.notRunning}` : ''}`}>
        {label}
        {rowState(r) ? <span className="ne-faint"> · {rowState(r)}</span> : null}
      </button>
      <svg
        className="ne-heat-row"
        data-selected={selected}
        viewBox={`0 0 ${n} 1`}
        preserveAspectRatio="none"
        aria-hidden
        onMouseMove={e => {
          const box = e.currentTarget.getBoundingClientRect();
          onHover(Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - box.left) / box.width) * n))));
        }}
        onMouseLeave={() => onHover(undefined)}
        onClick={onSelect}
      >
        {vals.map((v, i) => (
          <rect key={i} x={i} y={0} width={1.02} height={1} className={heatClass(metric, v, pmax)} />
        ))}
      </svg>
    </>
  );
}

function GpuDrawer({ r, f, metric, now, onClose }: { r?: FleetGpuRow; f: FleetResponse; metric: FleetMetric; now: Date; onClose: () => void }) {
  const project = r ? `project=${enc(r.projectId)}&` : '';
  return (
    <Drawer open={Boolean(r)} onClose={onClose} title={r ? gpuLabel(r) : ''} subtitle={r?.instanceId ?? r?.node} badges={r ? <Badge tone="accent">{RANGES.find(x => x.id === f.range)?.label}</Badge> : null}>
      {r ? (
        <div className="ne-stack" style={{ gap: 16 }}>
          <KeyValue
            items={[
              ['VM', r.instanceName ?? <span className="ne-faint">not in the current inventory ({r.node})</span>],
              ['Now', r.runningNow ? 'running, sampled within the last sync interval' : <span className="ne-faint">not running now{r.notRunning ? `: ${r.notRunning}` : ''}</span>],
              ['GPU', r.gpu ? (r.gpuName && r.gpuName !== r.gpu ? `${r.gpuName} (${r.gpu})` : r.gpu) : <span className="ne-faint">no GPU label on the series</span>],
              ['Node group', r.nodeGroupName ?? r.nodeGroupId ?? <span className="ne-faint">standalone VM (no node group label)</span>],
              ['Cluster', r.clusterName ?? r.clusterId ?? <span className="ne-faint">none</span>],
              ['Project', r.projectName ?? r.projectId],
              ['Last sample', r.lastSampleAt ? fmtTime(r.lastSampleAt) : <span className="ne-faint">hourly roll-ups in this range</span>],
              ['Idle in range', `${fmtGpuHours(r.idleMinutes / 60)} GPU-hours below 5 %`],
            ]}
          />
          <table className="ne-table ne-table-compact">
            <caption className="ne-sr-only">Mean and latest values in the range</caption>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col" className="ne-right">{sentence(windowText(f.range))}</th>
                <th scope="col" className="ne-right">Last {bucketWords(f.bucketSeconds)} bucket</th>
              </tr>
            </thead>
            <tbody>
              {METRICS.map(m => (
                <tr key={m.id}>
                  <td>{m.id === metric ? <strong>{m.label}</strong> : m.label}</td>
                  <td className="ne-right ne-num">{fmtMetric(m.id, meanOf(r.values[m.id]))}</td>
                  <td className="ne-right ne-num">{fmtMetric(m.id, lastOf(r.values[m.id]))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ne-stack" style={{ gap: 6 }}>
            <span className="ne-label">Drill down</span>
            {r.instanceUid ? (
              <Link to={`/estate?uid=${enc(r.instanceUid)}`}>
                <Icon name="explorer" size={14} /> VM in the Estate Explorer
              </Link>
            ) : (
              <span className="ne-faint">The VM is not in the current inventory, so the Explorer has nothing to open.</span>
            )}
            <NodeGroupDrill r={r} />
            {r.instanceId ? (
              <Link to={`/logs?${project}bucket=sp_serial&resource=${enc(r.instanceId)}&range=${logsRangeFor(r.lastSampleAt, f.range, now.getTime())}`}>
                <Icon name="logs" size={14} /> Serial-console logs of this VM
              </Link>
            ) : null}
            <Link to={`/alerts?${project.replace(/&$/, '')}`}>
              <Icon name="alert" size={14} /> Alerts in this project
            </Link>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}

function NodeGroupDrill({ r }: { r: FleetGpuRow }) {
  const d = nodeGroupDrill(r);
  if (!d) return null;
  return 'uid' in d ? <Link to={`/estate?uid=${enc(d.uid)}`}>Node group in the Explorer</Link> : <span className="ne-faint">{d.note}</span>;
}

/** The roll-up columns; utilisation is titled with its window, as on every page. */
const rollupColumns = (range: FleetRange): Column<FleetRollup>[] => [
  // The id on hover; at least 14 characters wide, so a name never wraps a letter at a time (W1F.N4).
  { key: 'name', header: 'Name', render: r => <span style={{ overflowWrap: 'anywhere', display: 'inline-block', minWidth: '14ch' }} title={r.id.replace(/^standalone\|/, '')}>{r.name}</span>, sortValue: r => r.name },
  { key: 'gpus', header: 'GPUs', align: 'right', render: r => fmtNumber(r.gpus), sortValue: r => r.gpus },
  { key: 'util', header: utilisationTitle(range), wrapHeader: true, align: 'right', render: r => (r.meanUtil === null ? <span className="ne-faint">not observed</span> : `${fmtNumber(r.meanUtil, 1)} %`), sortValue: r => r.meanUtil ?? -1 },
  { key: 'temp', header: 'Max temp.', align: 'right', render: r => (r.maxTemp === null ? <span className="ne-faint">not observed</span> : `${fmtNumber(r.maxTemp, 1)} °C`), sortValue: r => r.maxTemp ?? -1 },
  { key: 'idle', header: 'Idle GPU-h', align: 'right', render: r => fmtGpuHours(r.idleGpuHours), sortValue: r => r.idleGpuHours },
];

function RollupCard({ title, rows, range, empty }: { title: string; rows: FleetRollup[]; range: FleetRange; empty: string }) {
  return (
    <Card title={title} icon="workloads" flush>
      <DataTable caption={title} columns={rollupColumns(range)} rows={rows} rowKey={r => r.id} compact initialSort={{ key: 'idle', dir: 'desc' }} empty={<p className="ne-muted" style={{ padding: 16, margin: 0 }}>{empty}</p>} />
    </Card>
  );
}

const SVC_STATE: Record<ServicePanel['state'], { state: string; label: string }> = {
  live: { state: 'ok', label: 'live' },
  'none-in-scope': { state: 'not-configured', label: 'none in scope' },
  'no-metrics': { state: 'waiting', label: 'status only' },
  unavailable: { state: 'stale', label: 'unavailable' },
};

function ServiceCard({ s, now }: { s: ServicePanel; now: Date }) {
  const st = SVC_STATE[s.state];
  return (
    <Card title={s.title} actions={<StatusPill state={st.state} label={st.label} />} footer={`${s.source}${s.observedAt ? ` · ${fmtAgo(s.observedAt, now)}` : ''}`}>
      {s.reason ? <p className="ne-muted" style={{ marginTop: 0, fontSize: 12.5 }}>{s.reason}</p> : null}
      {s.items.length ? (
        <div>
          {s.items.slice(0, 12).map(it => (
            <div className="ne-svc-item" key={it.uid ?? it.name}>
              {it.uid ? (
                <Link to={`/estate?uid=${enc(it.uid)}`} style={{ overflowWrap: 'anywhere' }}>
                  {it.name}
                </Link>
              ) : (
                <span>{it.name}</span>
              )}
              <span className="ne-svc-figs">
                {it.figures.map(fg => (
                  <span key={fg.label} className="ne-num">
                    {fg.label} {fmtRate(fg.value, fg.unit)}
                  </span>
                ))}
                {it.status ? <span className="ne-faint">{it.status}</span> : null}
              </span>
            </div>
          ))}
          {s.items.length > 12 ? <p className="ne-faint" style={{ fontSize: 12 }}>+{s.items.length - 12} more in the Explorer</p> : null}
        </div>
      ) : null}
    </Card>
  );
}
