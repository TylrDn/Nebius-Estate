import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { reservationElsewhereText, reservationGapText } from '@internal/nebius-domain';
import type { AdviceAvailability, CapacityBlockGroupView, CapacityResponse, ReservationEvidence, ResourceAdviceView } from '@internal/nebius-domain';
import { Badge, Card, type Tone, DataTable, EmptyState, fmtAgo, fmtNumber, fmtTime, StatusPill } from '../../ui';
import { prettyEnum, SourceLine, Unavailable, UsageCell } from './parts';

const ADVICE_TONE: Record<string, Tone> = { high: 'ok', medium: 'info', low: 'warn', 'limit-reached': 'danger', unspecified: 'neutral', unknown: 'neutral' };

/** Reservations (capacity block groups), read at tenant level. */
export function BlockGroupsCard({ metric, now, evidence }: { metric: CapacityResponse['capacityBlockGroups']; now: Date; evidence?: ReservationEvidence }) {
  // An empty list beside an allowance on a block group, or a reserved node group, is reconciled in words (F1.10).
  const gap = evidence ? reservationGapText(evidence) : undefined;
  // Under a region filter, reservations an allowance names in another region are said with their region (F1.10).
  const elsewhere = evidence ? reservationElsewhereText(evidence) : undefined;
  const region = evidence?.region;
  return (
    <Card title="Reservations (capacity block groups)" icon="lock" flush footer={<SourceLine metric={metric} now={now} />}>
      {metric.value === null ? (
        <div className="ne-card-body">
          <Unavailable what="Reservations" metric={metric} tenant />
        </div>
      ) : (
        <DataTable<CapacityBlockGroupView>
          caption="Capacity block groups"
          compact
          rows={metric.value}
          rowKey={g => g.id}
          empty={
            gap ? (
              <EmptyState title="Reservation in use, not listed" icon="info">
                {gap}
                {elsewhere ? <> {elsewhere}</> : null}
              </EmptyState>
            ) : region ? (
              <EmptyState title={`No reservations in ${region}`}>
                The tenant answered and holds no capacity block group in {region}.{elsewhere ? <> {elsewhere}</> : null} <ReservationNext />
              </EmptyState>
            ) : (
              <EmptyState title="No reservations in this tenant">
                The tenant answered and holds no capacity block group. <ReservationNext />
              </EmptyState>
            )
          }
          columns={[
            {
              key: 'n',
              header: 'Reservation',
              sortValue: g => g.name,
              render: g => (
                <div>
                  <div style={{ fontWeight: 600 }} className="ne-cap-wrap">{g.name}</div>
                  <div className="ne-mono ne-faint ne-cap-wrap" style={{ fontSize: 'var(--ne-fs-caption)' }}>{g.id}</div>
                </div>
              ),
            },
            { key: 'r', header: 'Region · fabric', render: g => <span className="ne-mono">{g.region ?? 'region not stated'} · {g.fabric ?? 'no fabric'}</span> },
            { key: 'p', header: 'Platform', render: g => <span className="ne-mono">{g.platform ?? 'not stated'}</span> },
            { key: 'u', header: 'Usage / limit', render: g => <UsageCell usage={g.usage} limit={g.limit} label={`${g.name} reservation usage`} /> },
            { key: 's', header: 'State', render: g => (g.state ? <StatusPill state={prettyEnum(g.state) === 'active' ? 'ok' : 'unknown'} label={prettyEnum(g.state)} /> : <span className="ne-faint">not reported</span>) },
            { key: 'c', header: 'Next change', sortValue: g => g.nextChangeAt ?? '', render: g => (g.nextChangeAt ? fmtTime(g.nextChangeAt) : <span className="ne-faint">none scheduled</span>) },
          ]}
        />
      )}
    </Card>
  );
}

/** The capacity request runbook's reservation step, opened in the portal's document viewer. */
export const RESERVATION_RUNBOOK = `/evidence?doc=${encodeURIComponent('runbooks/capacity-request.md')}#3-reservation-staging-optional-prod-training-required`;
/** docs.nebius.com: VM reservations (capacity block groups), as runbooks/capacity-request.md cites them. */
export const RESERVATIONS_DOC = 'https://docs.nebius.com/compute/virtual-machines/reservations';

/** Where an empty reservation list leads (W1-P18): the request steps and the Nebius docs, not a dead end. */
function ReservationNext() {
  return (
    <span>
      Reserved capacity needs one: <Link to={RESERVATION_RUNBOOK}>How to request a reservation (runbooks/capacity-request.md)</Link> ·{' '}
      <a href={RESERVATIONS_DOC} target="_blank" rel="noreferrer">
        Reservations in the Nebius docs
      </a>
    </span>
  );
}

type CapacityKind = 'onDemand' | 'preemptible' | 'reserved';
const KINDS: { key: CapacityKind; label: string }[] = [
  { key: 'onDemand', label: 'On-demand' },
  { key: 'preemptible', label: 'Preemptible' },
  { key: 'reserved', label: 'Reserved' },
];
const LEVEL_RANK: Record<string, number> = { high: 4, medium: 3, low: 2, 'limit-reached': 1 };

/** Ranks one availability: level first, fresh data before stale, then the number available. */
export function adviceScore(a: AdviceAvailability | undefined): number {
  if (!a?.level) return -1;
  const rank = LEVEL_RANK[a.level.toLowerCase()] ?? 0;
  const fresh = a.dataState?.toLowerCase() === 'stale' ? 0 : 1;
  return rank * 10_000 + fresh * 1_000 + Math.min(a.available ?? 0, 999);
}

/**
 * The region with the best advice of one capacity type for each platform and preset (G2.4: the selected type;
 * on-demand under "All types", preemptible breaking its ties, on-demand breaking the others'). Presets are judged
 * apart: room for 1-GPU VMs says nothing about 8-GPU ones on a fabric.
 */
export function bestRegions(rows: ResourceAdviceView[], kind: CapacityKind = 'onDemand'): { platform: string; region: string; preset?: string; level: string; stale: boolean }[] {
  const best = new Map<string, { row: ResourceAdviceView; score: number }>();
  const tie: CapacityKind = kind === 'onDemand' ? 'preemptible' : 'onDemand';
  for (const row of rows) {
    if (!row.platform || !row.region) continue;
    const score = adviceScore(row[kind]) * 100_000 + Math.max(adviceScore(row[tie]), 0);
    const key = `${row.platform}|${row.preset ?? ''}`;
    const cur = best.get(key);
    if (!cur || score > cur.score) best.set(key, { row, score });
  }
  return [...best.entries()]
    .filter(([, b]) => (LEVEL_RANK[b.row[kind]?.level?.toLowerCase() ?? ''] ?? 0) > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, b]) => ({
      platform: b.row.platform!,
      region: b.row.region!,
      preset: b.row.preset,
      level: b.row[kind]!.level!.toLowerCase(),
      stale: b.row[kind]?.dataState?.toLowerCase() === 'stale',
    }));
}

/** Lines shown before the rest of the best-region summary folds (G2.4: about 35 lines under "All"). */
const BEST_SHOWN = 6;

function BestRegions({ best, kindWord }: { best: ReturnType<typeof bestRegions>; kindWord: string }) {
  const line = (b: (typeof best)[number]) => (
    <li key={`${b.platform}|${b.preset ?? ''}`}>
      Best region for <span className="ne-mono">{b.platform}{b.preset ? ` · ${b.preset}` : ''}</span>: <strong className="ne-mono">{b.region}</strong>{' '}
      <Badge tone={ADVICE_TONE[b.level] ?? 'neutral'}>{`${b.level.replace('-', ' ')} ${kindWord}`}</Badge>
      {b.stale ? <> <Badge tone="warn">stale</Badge></> : null}
    </li>
  );
  return (
    <div className="ne-stack" style={{ gap: 4 }}>
      <ul className="ne-advice-best" aria-label="Best region per platform">
        {best.length ? best.slice(0, BEST_SHOWN).map(line) : <li className="ne-muted">No region currently advises {kindWord} capacity for this selection.</li>}
      </ul>
      {best.length > BEST_SHOWN ? (
        <details className="ne-ov-details">
          <summary>{best.length - BEST_SHOWN} more platform presets</summary>
          <ul className="ne-advice-best" aria-label="More best regions">{best.slice(BEST_SHOWN).map(line)}</ul>
        </details>
      ) : null}
    </div>
  );
}

function AvailabilityCell({ a, now }: { a?: AdviceAvailability; now: Date }) {
  if (!a?.level) return <span className="ne-faint">not stated</span>;
  const level = a.level.toLowerCase();
  const stale = a.dataState?.toLowerCase() === 'stale';

  return (
    <div className="ne-advice-cell">
      <span className="ne-row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <Badge tone={ADVICE_TONE[level] ?? 'neutral'}>{level.replace('-', ' ')}</Badge>
        {stale ? <Badge tone="warn" title="The API marks this advice as stale">stale</Badge> : null}
      </span>
      <div className="ne-num ne-faint" style={{ fontSize: '0.75rem' }}>
        {/* proto3 JSON omits zeros: within a reported availability, an absent number is 0. */}
        {`${fmtNumber(a.available ?? 0)} available / ${fmtNumber(a.limit ?? 0)} limit`}
      </div>
      {a.effectiveAt ? (
        <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }} title={fmtTime(a.effectiveAt)}>
          as of {fmtAgo(a.effectiveAt, now)}
        </div>
      ) : null}
    </div>
  );
}

/** A capacity type filter keeps the rows where that type is offered: a level other than "limit reached", or room. */
const offered = (a: AdviceAvailability | undefined) => !!a?.level && (a.level.toLowerCase() !== 'limit-reached' || (a.available ?? 0) > 0);

/** Availability matrix: region × platform/preset × capacity type, read at tenant level. */
export function ResourceAdviceCard({ metric, now, reservations }: { metric: CapacityResponse['resourceAdvice']; now: Date; reservations?: ReservationEvidence }) {
  const [platform, setPlatform] = useState('');
  const [kind, setKind] = useState<'' | CapacityKind>('');
  const rows = useMemo(() => metric.value ?? [], [metric.value]);
  const platforms = useMemo(() => [...new Set(rows.map(r => r.platform).filter((p): p is string => !!p))].sort(), [rows]);
  const shown = useMemo(
    () => rows.filter(r => (!platform || r.platform === platform) && (!kind || offered(r[kind]))),
    [rows, platform, kind],
  );
  const bestKind: CapacityKind = kind || 'onDemand';
  const kindWord = KINDS.find(k => k.key === bestKind)!.label.toLowerCase();
  const best = useMemo(() => bestRegions(shown, bestKind), [shown, bestKind]);
  // Without a capacity block group the reserved column is "limit reached, 0 of 0" on every row: one line says it
  // instead. Not when something uses a reservation the list does not show (F1.10).
  const noReservations = reservations?.listed === 0 && !reservations.inUse;
  const kinds = (kind ? KINDS.filter(k => k.key === kind) : KINDS).filter(k => !(noReservations && k.key === 'reserved' && kind !== 'reserved'));
  return (
    <Card title="Capacity availability" icon="info" flush footer={<SourceLine metric={metric} now={now} />}>
      {metric.value === null ? (
        <div className="ne-card-body">
          <Unavailable what="Capacity advice" metric={metric} tenant />
        </div>
      ) : (
        <>
          {rows.length ? (
            <div className="ne-card-body ne-stack" style={{ gap: 12 }}>
              {/* The selects keep their row; the best-region list (which unfolds) is a row of its own below them (#58). */}
              <div className="ne-row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label className="ne-field">
                <span className="ne-label">Platform</span>
                <select className="ne-select" aria-label="Advice platform" value={platform} onChange={e => setPlatform(e.target.value)}>
                  <option value="">All platforms</option>
                  {platforms.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label className="ne-field">
                <span className="ne-label">Capacity type</span>
                <select className="ne-select" aria-label="Advice capacity type" value={kind} onChange={e => setKind(e.target.value as '' | CapacityKind)}>
                  <option value="">All types</option>
                  {KINDS.map(k => (
                    <option key={k.key} value={k.key}>{k.label}</option>
                  ))}
                </select>
              </label>
              </div>
              <BestRegions best={best} kindWord={kindWord} />
            </div>
          ) : null}
          {noReservations && rows.length ? (
            <p className="ne-card-body ne-faint" style={{ fontSize: '0.78125rem', margin: 0, paddingTop: 0 }}>
              No reservations in this tenant; reserved capacity needs a capacity block group. The Reserved column is hidden.
            </p>
          ) : null}
          <DataTable<ResourceAdviceView>
            caption="Capacity availability matrix"
            compact
            rows={shown}
            rowKey={a => `${a.region}/${a.fabric}/${a.platform}/${a.preset}`}
            empty={<EmptyState title="No capacity advice for this selection">The tenant answered with no advice for the selected region and filters.</EmptyState>}
            columns={[
              { key: 'r', header: 'Region · fabric', sortValue: a => a.region ?? '', render: a => <span className="ne-mono">{a.region ?? 'region not stated'}{a.fabric ? ` · ${a.fabric}` : ''}</span> },
              {
                key: 'p',
                header: 'Platform · preset',
                sortValue: a => `${a.platform}/${a.preset}`,
                render: a => (
                  <span className="ne-mono ne-cap-wrap">
                    {a.platform ?? 'platform not stated'} · {a.preset ?? 'preset not stated'}
                    {a.gpus ? <span className="ne-faint"> ({a.gpus} GPU)</span> : null}
                  </span>
                ),
              },
              ...kinds.map(k => ({
                key: k.key,
                header: k.label,
                sortValue: (a: ResourceAdviceView) => adviceScore(a[k.key]),
                render: (a: ResourceAdviceView) => <AvailabilityCell a={a[k.key]} now={now} />,
              })),
            ]}
          />
        </>
      )}
    </Card>
  );
}
