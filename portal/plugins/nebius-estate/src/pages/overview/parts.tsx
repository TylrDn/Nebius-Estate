import { CSSProperties, ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AlertsResponse, BudgetsResponse, ConnectorStatus, GlobalFilter, LivePriceResponse, OverviewResponse, RunRateResponse, SourcedMetric } from '@internal/nebius-domain';
import { budgetGlance, connectorHealthLine, connectorState, creditGlance, cutsProject, errorSummary, plainError } from '@internal/nebius-domain';
import {
  Badge,
  Callout,
  Column,
  DataTable,
  fmtAgo,
  fmtMoney,
  fmtMoneyList,
  fmtNumber,
  fmtTime,
  filterQuery,
  Icon,
  IconName,
  Loadable,
  Meter,
  NARROW_QUERY,
  ProjectNames,
  Quiet,
  StatusPill,
  TileSource,
  Tone,
  useGlobalFilter,
  useMediaQuery,
} from '../../ui';
import { priceBasisText } from '../pricing/livePrice';
import { blockedPlans, fmtQuotaAmount } from '../capacity/helpers';
import { alertsAttentionRow } from '../../alerts/attention';
import { rateTone, RateTone } from '../integrations/model';

const RATE_COLOR: Record<RateTone, CSSProperties | undefined> = { ok: undefined, neutral: undefined, warn: { color: 'var(--ne-warn)' }, danger: { color: 'var(--ne-danger)' } };
import { countOf, filterNotApplied, fixFor, runRateCountText, fmtDuration, liveRunRateMetric, missingSummary, SETUP, setupDocHref, successPercent, summariseTelemetry, upcomingMaintenance } from './model';

/** One primary Fix for an Unavailable, to the page where the fix happens (W1-P24); `fixFor` picks it. */
export function SetupHint({ reason, setup }: { reason?: string; setup: string }) {
  const [filter] = useGlobalFilter();
  const fix = fixFor(reason, setup, filterQuery(filter));
  return (
    <div className="ne-ov-setup">
      <Link to={fix.to} data-fix>
        Fix: {fix.label} →
      </Link>
    </div>
  );
}

/**
 * A stat tile like the shared StatTile, plus the setup doc when the source is
 * unavailable and content shown in both states (`always`).
 */
export function SourcedTile<T>({
  label,
  metric,
  render,
  now,
  tone,
  icon,
  extra,
  always,
  setup,
}: {
  label: string;
  metric: SourcedMetric<T>;
  render: (value: T) => ReactNode;
  now: Date;
  tone?: Tone;
  icon?: IconName;
  extra?: ReactNode;
  always?: ReactNode;
  setup?: string;
}) {
  const color = tone ? `var(--ne-${tone === 'neutral' ? 'border-strong' : tone})` : undefined;
  const missing = metric.value === null || metric.value === undefined;
  return (
    <section className="ne-card ne-tile" aria-label={label}>
      {color ? <span className="ne-tile-accent" style={{ background: color }} /> : null}
      <div className="ne-tile-label">
        {icon ? <Icon name={icon} size={14} /> : null}
        {label}
      </div>
      {missing && metric.empty ? (
        // The source answered and there is nothing: not a gap to set up.
        <>
          <div className="ne-tile-value ne-ov-small">{metric.empty}</div>
          {metric.unavailableReason ? <div className="ne-tile-reason ne-ov-break">{metric.unavailableReason}</div> : null}
        </>
      ) : missing ? (
        <>
          <div className="ne-tile-unavailable">
            <Icon name="unavailable" size={15} /> Unavailable
          </div>
          <div className="ne-tile-reason ne-ov-break">{metric.unavailableReason}</div>
          {setup && metric.unavailableReason !== 'Loading…' ? <SetupHint reason={metric.unavailableReason} setup={setup} /> : null}
        </>
      ) : (
        <>
          <div className="ne-tile-value">
            {render(metric.value as T)}
            {metric.unit ? <span className="ne-tile-unit">{' '}{metric.unit}</span> : null}
          </div>
          {metric.note ? <div className="ne-tile-reason">{metric.note}</div> : null}
          {extra}
        </>
      )}
      {always}
      <TileSource source={metric.source} observedAt={metric.observedAt} now={now} />
    </section>
  );
}

/* --------------------------------------------------------- GPU telemetry */

/**
 * Temperature and power from the per-GPU telemetry in the overview response, each with its source. The source line
 * is left out when it is the tile's own (`tileSource`), which the tile already prints.
 */
export function TelemetryLines({ metric: m, now, tileSource, setup }: { metric: OverviewResponse['gpuTelemetry'] | undefined; now: Date; tileSource?: string; setup?: string }) {
  if (!m) return null;
  const s = summariseTelemetry(m.value);
  if (!s) {
    // `setup`: the tile shows a value, so this Unavailable carries its own Fix (W1-P24); an Unavailable tile has one already.
    return (
      <div className="ne-ov-sub">
        <div className="ne-tile-reason ne-ov-break">Temperature and power unavailable: {m.unavailableReason}</div>
        {setup && m.unavailableReason !== 'Loading…' ? <SetupHint reason={m.unavailableReason} setup={setup} /> : null}
      </div>
    );
  }
  const source = s.sources.length ? s.sources.join(' + ') : m.source;
  if (!s.gpus) return null; // nothing reports: the tile says so already
  return (
    <div className="ne-ov-sub">
      <dl className="ne-ov-kv">
        <dt>Temperature</dt>
        <dd>
          {s.temp ? (
            <>
              mean {fmtNumber(s.temp.mean, 0)} °C · max {fmtNumber(s.temp.max, 0)} °C <span className="ne-faint">({s.temp.reporting} of {s.gpus} GPUs)</span>
            </>
          ) : (
            <span className="ne-faint">not reported</span>
          )}
        </dd>
        <dt>Power</dt>
        <dd>
          {s.power ? (
            <>
              {fmtNumber(s.power.total, 0)} W total · max {fmtNumber(s.power.max, 0)} W <span className="ne-faint">({s.power.reporting} of {s.gpus} GPUs)</span>
            </>
          ) : (
            <span className="ne-faint">not reported</span>
          )}
        </dd>
      </dl>
      {source === tileSource ? null : (
        <div className="ne-ov-source" title={m.observedAt ? fmtTime(m.observedAt) : undefined}>
          {source}
          {m.observedAt ? ` · ${fmtAgo(m.observedAt, now)}` : ''}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- run-rate */

/** Run-rate of the running inventory in scope at the Nebius calculator's price; the user rate book is the labelled fallback. */
export function LiveRunRateTile({ live, book, now }: { live: Loadable<LivePriceResponse>; book: Loadable<RunRateResponse>; now: Date }) {
  const metric = liveRunRateMetric(live);
  const fallback = book.data?.value;
  const nothing = metric.value === null && metric.empty !== undefined;
  return (
    <SourcedTile
      // One label whatever the basis; the basis (contract or list) is the badge below.
      label="Run-rate (live)"
      icon="commercial"
      metric={metric}
      now={now}
      setup={SETUP.livePrices}
      render={v => (v.hourly ? <>{fmtMoney(v.hourly, 2)}<span className="ne-tile-unit">{' '}/ h</span></> : <span className="ne-ov-small">Not priced per hour</span>)}
      extra={
        metric.value ? (
          <>
            <div className="ne-tile-reason ne-ov-break">
              <Badge tone={metric.value.offer === 'contract' ? 'ok' : 'neutral'}>{priceBasisText(metric.value, m => fmtMoney(m))}</Badge>
            </div>
            {metric.value.contractNote ? (
              <div className="ne-tile-reason ne-ov-break">
                <Badge tone="warn">list price</Badge> Contract price not used: {metric.value.contractNote}
              </div>
            ) : null}
            <div className="ne-tile-reason" data-testid="live-runrate-count">{runRateCountText({ priced: metric.value.lines.reduce((a, l) => a + l.count, 0), unpriced: metric.value.unpriced.length })}</div>
            {metric.value.unpriced.length ? (
              <details className="ne-ov-details">
                <summary>{metric.value.unpriced.length} without a price (not in the total)</summary>
                <ul>
                  {metric.value.unpriced.map(u => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {metric.value.lines.length ? (
              <details className="ne-ov-details">
                <summary>Price breakdown by kind of resource</summary>
                <ul>
                  {metric.value.lines.map(l => (
                    <li key={l.key} className="ne-between" style={{ gap: 8 }}>
                      <span className="ne-ov-break">
                        {l.description} × {l.count}
                      </span>
                      <span className="ne-num ne-nowrap">{l.hourly ? `${fmtMoney(l.hourly, 2)} / h` : (l.note ?? 'usage-based')}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <div className="ne-tile-reason">Calculator estimate of running VMs, disks, filesystems and managed PostgreSQL. Not billed cost, not a quote.</div>
          </>
        ) : null
      }
      always={
        metric.value === null && !nothing && metric.unavailableReason !== 'Loading…' ? (
          <div className="ne-ov-sub">
            <div className="ne-tile-reason">
              Fallback, user rate book{fallback ? ` "${fallback.rateBook.name}"` : ''} (negotiated / what-if):{' '}
              {fallback ? (
                <strong className="ne-num">{fallback.hourly.length ? `${fmtMoneyList(fallback.hourly, 2)} / h` : 'no resource has a rate'}</strong>
              ) : (
                <span className="ne-faint">
                  {book.data?.rateBookOptional ? 'not set (optional)' : `unavailable${book.data?.unavailableReason ? ` (${book.data.unavailableReason})` : book.error ? ` (${book.error.message})` : ''}`}
                </span>
              )}
            </div>
          </div>
        ) : null
      }
    />
  );
}

/** The rate-book estimate, labelled as the user's rate book. */
export function RateBookRunRateTile({ book, now }: { book: Loadable<RunRateResponse>; now: Date }) {
  const v = book.data?.value;
  return (
    <SourcedTile
      label="Run-rate at user rate book"
      icon="commercial"
      setup={SETUP.rateBook}
      metric={
        v
          ? {
              value: v,
              source: `Inventory × user rate book "${v.rateBook.name}"${book.data?.rateBookChoice?.how === 'portal-default' ? ' (portal default)' : ''}`,
              observedAt: book.data?.observedAt,
              // The same count and words as the live tile (W1-P10); what has no rate is named below.
              note: `${runRateCountText({ priced: v.pricedResources, unpriced: v.unpricedResources.length })}${v.variablePrice ? ', includes spot prices' : ''}. Negotiated or what-if rates; estimate, not billed cost.`,
            }
          : book.data?.rateBookOptional
            ? // No book while the live list price answers: optional, as the Integrations setup step says, not a gap to fix.
              {
                value: null,
                source: 'Inventory × user rate book',
                empty: 'Not set (optional)',
                unavailableReason: `${book.data.unavailableReason ?? 'No rate book is in use.'} The live run-rate is priced at the Nebius list price; a rate book adds negotiated or what-if rates.`,
              }
            : { value: null, source: 'Inventory × user rate book', unavailableReason: book.error?.message ?? book.data?.unavailableReason ?? 'Loading…' }
      }
      now={now}
      render={x => (x.hourly.length ? <>{fmtMoneyList(x.hourly, 2)}<span className="ne-tile-unit">{' '}/ h</span></> : <span className="ne-ov-small">No resource has a rate</span>)}
      extra={
        <>
        {/* A book picked as the first by id is a guess: warned on the tile, with where to set a default (W1-P8); the long
            reason (with the configuration key, which would not wrap at 200 % text) is the badge's hover text. */}
        {book.data?.rateBookChoice?.how === 'first-by-id' ? (
          <div className="ne-tile-reason">
            <Badge tone="warn" title={book.data.rateBookChoice.text}>first rate book by id</Badge> <Link to="/commercial?tab=ratebooks">Set a portal default →</Link>
          </div>
        ) : null}
        {v?.unpricedResources.length ? (
          <details className="ne-ov-details">
            <summary>{v.unpricedResources.length} without a price (not in the total)</summary>
            <ul>
              {v.unpricedResources.map(u => (
                <li key={u.uid}>
                  {u.name}: {u.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        </>
      }
    />
  );
}

/* --------------------------------------------------------- needs attention */

export interface AttentionRow {
  label: string;
  metric: SourcedMetric;
  to: string;
  tone: 'danger' | 'warn' | 'info';
  setup: string;
  detail?: ReactNode;
  /** A zero that covers only part of the data: shown neutral with this text, never as a green "0". */
  zeroLabel?: string;
  zeroTitle?: string;
}

/** `alerts`: the open alerts (alerts/attention.tsx), fetched by the page so this tile renders without API calls of its own. */
/** `projectName`: id → name (the filter options), so a project-cap row names its project (#2). */
export function AttentionTile({ o, now, alerts, projectName }: { o: OverviewResponse; now: Date; alerts?: { data?: AlertsResponse; error?: Error }; projectName?: (id: string) => string | undefined }) {
  const [filter] = useGlobalFilter();
  // A phone folds the list to a short summary, so the numbers below start above the fold (F1.15); a wide screen has
  // no fold at all, so a narrow-to-wide flip can never leave it closed with its toggle hidden (#44).
  const narrow = useMediaQuery(NARROW_QUERY);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (narrow) setOpen(false);
  }, [narrow]);
  const quotas = o.quotasNearLimit.value;
  const maint = upcomingMaintenance(o.maintenances);
  // Roots, not quota lines: the Capacity header counts the same.
  const roots = blockedPlans(o.plannedQuotaIssues.value);
  // Shown only when a real project cap cuts below the tenant limit (or is 0); caps above it change nothing.
  const cuts = o.allowanceCheck?.value?.filter(cutsProject);
  // In use above the limit (a limit of 0 included): the worst quota state, a danger row of its own when there is one (F1.11).
  const above = o.quotasAboveLimit?.value;
  const rows: AttentionRow[] = [
    // Project-cap alerts are left out of the alerts count while the caps row below lists them (G1.4).
    ...(alerts ? [alertsAttentionRow(alerts, filter, cuts?.length ?? 0)] : []),
    { label: 'TTL expired', metric: o.ttlExpired, to: `/estate${filterQuery(filter, { view: 'ttl' })}`, tone: 'danger', setup: SETUP.inventory },
    { label: 'Orphan candidates', metric: o.orphanCandidates, to: `/estate${filterQuery(filter, { view: 'orphans' })}`, tone: 'warn', setup: SETUP.inventory },
    ...(above?.length
      ? [
          {
            label: 'Quotas in use above the limit',
            metric: { ...o.quotasAboveLimit!, value: above.length },
            to: `/capacity${filterQuery(filter)}#quotas`,
            tone: 'danger' as const,
            setup: SETUP.inventory,
            detail: (
              <ul className="ne-ov-mini">
                {above.slice(0, 3).map(q => (
                  <li key={`${q.scope}/${q.projectId}/${q.name}/${q.region ?? ''}`}>
                    <span className="ne-ov-break">{q.description ?? q.name}</span>
                    {q.region ? <span className="ne-faint"> · {q.region}</span> : null}{' '}
                    <span className="ne-num ne-nowrap">
                      {fmtQuotaAmount(q.usage, q.unit)} / {q.limit === null ? 'no limit' : fmtQuotaAmount(q.limit, q.unit)}
                    </span>
                  </li>
                ))}
                {above.length > 3 ? <li className="ne-faint">+{above.length - 3} more on Capacity</li> : null}
              </ul>
            ),
          },
        ]
      : []),
    {
      // The threshold is in the badge ("0 at ≥ 80 % · …", the same words as Capacity): said once (F1.39 review).
      label: 'Quotas near their limit',
      metric: countOf(o.quotasNearLimit),
      to: `/capacity${filterQuery(filter)}#quotas`,
      tone: 'warn',
      setup: SETUP.inventory,
      // The same words and count as the Capacity Quotas header (nearLimitText).
      zeroLabel: o.quotasNearLimit.coverage?.summary,
      zeroTitle: o.quotasNearLimit.note,
      detail: quotas?.length ? (
        <ul className="ne-ov-mini">
          {quotas.slice(0, 3).map(q => (
            <li key={`${q.projectId}/${q.name}/${q.region ?? ''}`}>
              <span className="ne-ov-break">{q.description ?? q.name}</span>
              {q.region ? <span className="ne-faint"> · {q.region}</span> : null}{' '}
              <span className="ne-num ne-nowrap">{q.usagePercent === null ? 'use unknown' : `${fmtNumber(q.usagePercent, 0)} %`}</span>
            </li>
          ))}
          {quotas.length > 3 ? <li className="ne-faint">+{quotas.length - 3} more on Capacity</li> : null}
        </ul>
      ) : null,
    },
    {
      label: 'Planned resources blocked by quota',
      metric: { ...o.plannedQuotaIssues, value: roots === null ? null : roots.length },
      to: `/capacity${filterQuery(filter)}#planned-quota`,
      // Not applied yet: something to act on before an apply, not an outage.
      tone: 'warn',
      setup: SETUP.inventory,
      detail: roots?.length ? (
        <ul className="ne-ov-mini">
          {roots.slice(0, 3).map(plan => {
            const lines = o.plannedQuotaIssues.value!.filter(i => i.plan === plan);
            return (
              <li key={plan}>
                <span className="ne-ov-break">{plan.replace(/^terraform\/live\//, '')}</span>{' '}
                <span className="ne-faint">
                  {lines.map(i => `${i.description ?? i.quota} · ${i.state === 'blocked' ? 'limit 0' : i.regionBasis === 'observed' ? `${fmtNumber(i.need)} > ${fmtNumber(i.limit)}` : `${fmtNumber(i.usage)} + ${fmtNumber(i.need)} > ${fmtNumber(i.limit)}`}`).join('; ')} · {lines[0].region}
                  {lines[0].profile ? ` · profile ${[...new Set(lines.map(i => i.profile).filter(Boolean))].join(', ')}` : ''}
                </span>
              </li>
            );
          })}
          {roots.length > 3 ? <li className="ne-faint">+{roots.length - 3} more on Capacity</li> : null}
          <li className="ne-faint">Request quota: Administration → Limits → Quotas</li>
        </ul>
      ) : null,
    },
    ...(cuts?.length
      ? [
          {
            label: 'Project quota caps below the tenant limit',
            metric: { ...o.allowanceCheck!, value: cuts.length },
            to: `/capacity${filterQuery(filter)}#allowance-check`,
            tone: 'warn' as const,
            setup: SETUP.inventory,
            detail: (
              <ul className="ne-ov-mini">
                {cuts.slice(0, 3).map(f => (
                  <li key={`${f.projectId}/${f.region ?? ''}/${f.name}`}>
                    {/* The project first: the alert names it, and so does Capacity (#2). */}
                    <span className="ne-ov-break">
                      {projectName?.(f.projectId) ?? f.projectId} · {f.description ?? f.name}
                    </span>
                    <span className="ne-faint"> · {f.name} · {f.region ?? 'region not stated'}</span>{' '}
                    <span className="ne-num ne-nowrap">{f.kind === 'zero-cap' ? 'cap 0' : `${fmtQuotaAmount(f.projectLimit, f.unit)} of ${fmtQuotaAmount(f.tenantLimit, f.unit)}`}</span>
                  </li>
                ))}
                {cuts.length > 3 ? <li className="ne-faint">+{cuts.length - 3} more on Capacity</li> : null}
                {/* A cap is often a default kept on purpose: the expected action is to say so, not to raise it (#4). */}
                <li className="ne-faint">
                  Intended (a project kept small on purpose)? Acknowledge its alert with a note, so the next reader knows: <Link to={`/alerts${filterQuery(filter)}`}>Acknowledge on Alerts</Link>
                </li>
              </ul>
            ),
          },
        ]
      : []),
    {
      label: 'Scheduled maintenance',
      metric: { ...o.maintenances, value: maint === null ? null : maint.length },
      to: `/capacity${filterQuery(filter)}#maintenance`,
      tone: 'info',
      setup: SETUP.inventory,
      detail: maint?.length ? (
        <ul className="ne-ov-mini">
          {maint.slice(0, 3).map(m => (
            <li key={m.id}>
              <span className="ne-ov-break">{m.name}</span>{' '}
              <span className="ne-faint" title={fmtTime(m.scheduledAt ?? m.startedAt)}>
                {m.startedAt && !m.scheduledAt ? `started ${fmtAgo(m.startedAt, now)}` : m.scheduledAt ? fmtAgo(m.scheduledAt, now) : 'time not given'}
                {m.affected.length ? ` · ${m.affected.length} affected` : ''}
              </span>
            </li>
          ))}
          {maint.length > 3 ? <li className="ne-faint">+{maint.length - 3} more</li> : null}
        </ul>
      ) : null,
    },
    { label: 'Open provisioning requests', metric: o.pendingProvisioningRequests, to: `/provisioning${filterQuery(filter)}`, tone: 'info', setup: SETUP.access },
  ];
  // Counts first, one cell per row, so the strip reads at a glance; each item's list is one click away. On a phone the
  // strip folds to one wrapping line of what needs a look, so the numbers below start above the fold (F1.15).
  const active = rows.filter(r => r.metric.value === null || r.metric.value > 0);
  const list = (
    <ul className="ne-ov-attention ne-attn-grid">
      {rows.map(r => (
        <li key={r.label} data-active={r.metric.value !== null && r.metric.value > 0 ? 'true' : undefined}>
          <div className={`ne-between ne-attn-row${r.metric.value === 0 && r.zeroLabel ? ' ne-attn-row-wide' : ''}`}>
            <Link to={r.to}>{r.label}</Link>
            {r.metric.value === null ? (
              <span className="ne-faint">Unavailable</span>
            ) : r.metric.value > 0 ? (
              <Badge tone={r.tone}>{fmtNumber(r.metric.value)}</Badge>
            ) : r.zeroLabel ? (
              <Badge tone="neutral" title={r.zeroTitle} wrap>
                {r.zeroLabel}
              </Badge>
            ) : (
              <Quiet>0</Quiet>
            )}
          </div>
          {r.metric.value === null && r.metric.unavailableReason ? (
            <>
              <div className="ne-tile-reason ne-ov-break">{r.metric.unavailableReason}</div>
              <SetupHint reason={r.metric.unavailableReason} setup={r.setup} />
            </>
          ) : r.detail ? (
            <details className="ne-ov-details">
              <summary>Show the list</summary>
              {r.detail}
            </details>
          ) : null}
        </li>
      ))}
    </ul>
  );
  return (
    <section className="ne-card ne-tile ne-attn" aria-label="Needs attention">
      <div className="ne-tile-label">
        <Icon name="warn" size={14} /> Needs attention
      </div>
      {narrow ? (
        <details className="ne-attn-fold" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
          {/* One short row per item that needs a look, count first (#25); the full list opens on a tap. */}
          <summary className="ne-attn-summary">
            {active.length ? (
              active.map(r => (
                <span key={r.label} className="ne-attn-sum-row">
                  {r.metric.value === null ? <span className="ne-faint">unavailable</span> : <Badge tone={r.tone}>{fmtNumber(r.metric.value)}</Badge>} {r.label}
                </span>
              ))
            ) : (
              <span className="ne-attn-sum-row">Nothing needs a look</span>
            )}
            {/* What "all" covers: the checks, not more problems (#25, G1.4). */}
            <span className="ne-attn-more">{open ? 'Hide the list' : `Show all ${rows.length} checks`}</span>
          </summary>
          {list}
        </details>
      ) : (
        list
      )}
      <div className="ne-tile-source">
        Inventory labels; quota allowances (quotas.v1); maintenance (maintenance.v1alpha1); portal database. Nothing is deleted automatically.
      </div>
    </section>
  );
}

/* -------------------------------------------------------- connector health */

const notRecorded = <span className="ne-faint">not recorded</span>;

/** Connectors that are not set up, optional or not needed: their run columns do not apply. */
const NOT_APPLICABLE: Partial<Record<ConnectorStatus['state'], string>> = {
  optional: 'not applicable: an optional connector',
  'not-needed': 'not applicable: not needed',
  'not-configured': 'not applicable: not set up',
};

/** The Integrations link that lists only the connectors in `state` (W1-P29): the chip and the filter share one count. */
export const connectorFilterHref = (filter: GlobalFilter, state?: string) => `/integrations${filterQuery(filter, { connectors: state })}#connector-summary`;

/**
 * Every connector state as a count chip that is also its filter (W1-P29): "10 ok · 1 partial (…) · 2 waiting ·
 * 1 optional · 1 not needed". Only what needs a look is a coloured badge; a not-applicable state is grey (W1-P28).
 * `active`: the state the Integrations table is filtered by (aria-current on its chip).
 */
export function ConnectorStateChips({ statuses, active }: { statuses: ConnectorStatus[]; active?: string }) {
  const [filter] = useGlobalFilter();
  const line = connectorHealthLine(statuses);
  return (
    <span className="ne-ov-connectors-line">
      <span className="ne-faint">{line.head}</span>{' '}
      {line.segments.map((x, i) => (
        <span key={x.state}>
          {i ? ' · ' : null}
          <Link
            to={connectorFilterHref(filter, active === x.state ? undefined : x.state)}
            className={`ne-chip-link${x.notApplicable ? ' ne-chip-link-na' : ''}`}
            aria-current={active === x.state ? 'true' : undefined}
            title={active === x.state ? 'Show every connector' : `List the ${x.count} ${x.state.replace(/-/g, ' ')} on Integrations`}
          >
            {x.tone ? (
              <Badge tone={x.tone} dot wrap>
                {x.text}
              </Badge>
            ) : (
              x.text
            )}
          </Link>
        </span>
      ))}
    </span>
  );
}

/**
 * The Overview's connector health: one line of count chips (each a filter on Integrations) and the link to the table
 * on Integrations, instead of a second copy of that table (F1.15).
 */
export function ConnectorSummary({ statuses }: { statuses: ConnectorStatus[] }) {
  const [filter] = useGlobalFilter();
  return (
    <section className="ne-card ne-ov-connectors" aria-label="Connector health">
      <span className="ne-ov-connectors-title">
        <Icon name="integrations" size={15} /> Connector health
      </span>
      <ConnectorStateChips statuses={statuses} />
      <Link to={`/integrations${filterQuery(filter)}`}>All integrations →</Link>
    </section>
  );
}

/** `onIntegrations`: the table sits on Integrations itself, so it points at the cards below instead of linking to its own page (F1.14). */
/**
 * `narrow`: a phone keeps the connector with its state, and its issue (two columns that fit, not stacked); the health figures are
 * in each connector's card below. Stacked, fourteen rows of nine fields were 8,000 px (W1F.N5).
 */
/** `outages`: sync attempts every call failed at (sharedOutages), not counted against a connector's rate (G1.6). */
export function ConnectorTable({ statuses, now, onIntegrations, narrow, outages }: { statuses: ConnectorStatus[]; now: Date; onIntegrations?: boolean; narrow?: boolean; outages?: ReadonlySet<string> }) {
  const details = onIntegrations ? <span> — in its card below</span> : <> — <Link to="/integrations">see Integrations</Link></>;
  const columns: Column<ConnectorStatus>[] = [
    { key: 'title', header: 'Connector', render: s => <strong style={{ fontWeight: 600 }}>{s.title}</strong>, sortValue: s => s.title },
    {
      key: 'state',
      header: 'State',
      render: s => (
        <span className="ne-ov-pills">
          {s.state === 'disabled' && s.id.startsWith('mk8s:') ? <StatusPill state={s.state} label="retired" /> : <StatusPill state={connectorState(s).state} label={connectorState(s).label} />}
          {s.running ? <Badge tone="info" title={s.runningSince ? `since ${fmtTime(s.runningSince)}` : undefined}>syncing</Badge> : null}
        </span>
      ),
      sortValue: s => s.state,
    },
    {
      key: 'last',
      header: 'Last success',
      render: s =>
        s.lastSuccess ? (
          <span title={fmtTime(s.lastSuccess)}>{fmtAgo(s.lastSuccess, now)}</span>
        ) : (
          <span className="ne-faint" title={NOT_APPLICABLE[s.state]}>{NOT_APPLICABLE[s.state] ? 'n/a' : s.state === 'starting' ? 'syncing' : 'never'}</span>
        ),
      sortValue: s => s.lastSuccess ?? '',
    },
    {
      key: 'rate',
      header: 'Success 24 h',
      align: 'right',
      render: s => {
        if (!s.health) return notRecorded;
        const p = successPercent(s.health);
        if (p === null) return <span className="ne-faint">no runs</span>;
        return (
          // The same tone as the connector cards (rateTone: 99 % and up is fine), so the two never disagree (G1.8).
          <span className="ne-num" style={RATE_COLOR[rateTone(s.health, outages)]}>
            {fmtNumber(p, 1)} %<span className="ne-faint"> of {s.health.runs24h}</span>
          </span>
        );
      },
      sortValue: s => successPercent(s.health) ?? -1,
    },
    {
      key: 'duration',
      header: 'Sync p50 / p95',
      align: 'right',
      render: s => {
        if (!s.health) return notRecorded;
        const p50 = fmtDuration(s.health.p50Ms);
        const p95 = fmtDuration(s.health.p95Ms);
        if (!p50 && !p95) return <span className="ne-faint">no runs</span>;
        return <span className="ne-num ne-nowrap">{p50 ?? 'n/a'} / {p95 ?? 'n/a'}</span>;
      },
      sortValue: s => s.health?.p95Ms ?? -1,
    },
    {
      key: 'failures',
      header: 'Failures in a row',
      align: 'right',
      render: s =>
        !s.health ? notRecorded : s.health.consecutiveFailures > 0 ? <Badge tone={s.health.consecutiveFailures >= 3 ? 'danger' : 'warn'}>{fmtNumber(s.health.consecutiveFailures)}</Badge> : <span className="ne-num">0</span>,
      sortValue: s => s.health?.consecutiveFailures ?? -1,
    },
    {
      key: 'next',
      header: 'Next run',
      render: s =>
        NOT_APPLICABLE[s.state] ? (
          <span className="ne-faint" title={NOT_APPLICABLE[s.state]}>
            n/a
          </span>
        ) : !s.health ? (
          notRecorded
        ) : s.health.nextRunAt ? (
          <span title={s.health.nextRunReason ? `${fmtTime(s.health.nextRunAt)}: sooner than usual because ${s.health.nextRunReason}` : fmtTime(s.health.nextRunAt)}>{fmtAgo(s.health.nextRunAt, now)}</span>
        ) : (
          <span className="ne-faint">not scheduled</span>
        ),
      sortValue: s => s.health?.nextRunAt ?? '',
    },
    { key: 'scope', header: 'Scope', render: s => <span className="ne-muted">{s.scope === '—' || !s.scope ? <span title="not applicable">n/a</span> : <ProjectNames summary={s.scope} projects={s.projects} />}</span> },
    {
      key: 'issue',
      header: 'Issue',
      // Short, wrapping summaries; the details live on Integrations.
      render: s => (
        <div className="ne-ov-issue">
          {s.id === 'nebius-inventory' && s.state === 'permission-denied' ? (
            // Partial: the counts are in the State column, in the words the card uses (W1F.S3); here, where to read them.
            <span className="ne-muted" title={s.error ? plainError(s.error, s.projects) : undefined}>
              Which project refused which call
              {details}
            </span>
          ) : s.state === 'not-configured' ? (
            <span className="ne-muted">
              Not set up{s.error ? ` (${s.error})` : ''}. Set up: <Link to={setupDocHref(s.setup)}>{s.setup}</Link>
            </span>
          ) : s.error ? (
            <span style={{ color: s.state === 'degraded' ? 'var(--ne-warn)' : 'var(--ne-danger)' }} title={plainError(s.error, s.projects)}>
              {errorSummary(s.error, s.errorCount, s.projects)}
            </span>
          ) : s.state === 'waiting' ? (
            <span className="ne-muted">{s.notes?.join(' ') ?? 'Waiting.'}</span>
          ) : s.notes?.length ? (
            <span className="ne-muted">{s.notes.join(' ')}</span>
          ) : s.state === 'not-needed' ? (
            <span className="ne-muted">{s.missingCoverage.join(' ')}</span>
          ) : s.state === 'optional' ? (
            <span className="ne-faint">Optional. {s.missingCoverage.join(' ')}</span>
          ) : s.id === 'nebius-inventory' && s.missingCoverage.length ? (
            <span className="ne-muted">
              {missingSummary(s.missingCoverage)}
              {details}
            </span>
          ) : s.missingCoverage.length ? (
            <span className="ne-muted">Not covered: {s.missingCoverage.join('; ')}</span>
          ) : (
            <span className="ne-faint">No issue</span>
          )}
        </div>
      ),
    },
  ];
  const col = (key: string) => columns.find(c => c.key === key)!;
  const shown: Column<ConnectorStatus>[] = narrow
    ? [
        {
          ...col('title'),
          header: 'Connector and state',
          // Half the width each: the issue column was ~75 px and broke words.
          width: '50%',
          render: s => (
            <>
              {col('title').render(s)}
              <div style={{ marginTop: 4 }}>{col('state').render(s)}</div>
            </>
          ),
        },
        col('issue'),
      ]
    : columns;
  return <DataTable caption="Connector health" rows={statuses} rowKey={s => s.id} compact columns={shown} />;
}

/* ------------------------------------------------- GPU scheduling checks */

/** Where Nebius documents GPU node groups for Managed Kubernetes (drivers preset, device plugin). */
export const MK8S_GPU_DOC = 'https://docs.nebius.com/kubernetes/gpu/set-up';

/**
 * Clusters whose running GPU VMs advertise fewer allocatable GPUs than they have. Phrased as checks: the
 * portal sees the numbers, not the cause.
 */
export function GpuSchedulingChecks({ checks }: { checks: OverviewResponse['gpuSchedulingChecks'] }) {
  if (!checks?.length) return null;
  return (
    <div className="ne-section">
      <Callout tone="warn" title="Check: GPUs not advertised to Kubernetes">
        <ul className="ne-discovery-list" aria-label="GPU scheduling checks">
          {checks.map(c => (
            <li key={c.clusterId}>
              {fmtNumber(c.gpuVms)} GPU VM{c.gpuVms === 1 ? '' : 's'} ({fmtNumber(c.gpus)} GPU{c.gpus === 1 ? '' : 's'}) in cluster <strong>{c.cluster}</strong>
              {c.nodeGroups.length ? ` (node group ${c.nodeGroups.join(', ')})` : ''} advertise{c.gpuVms === 1 ? 's' : ''} {fmtNumber(c.allocatable)} allocatable GPU{c.allocatable === 1 ? '' : 's'}. Check the node group&rsquo;s GPU drivers preset and that the NVIDIA device plugin (or GPU operator) is running (
              <a href={MK8S_GPU_DOC} target="_blank" rel="noreferrer">
                GPU set-up guide
              </a>
              ).
            </li>
          ))}
        </ul>
      </Callout>
    </div>
  );
}

/**
 * Budgets and tracked credits at a glance, from Budgets & credits (the single source); hidden when neither exists.
 * A credit shows without any budget (G1.18). Both are account-wide: an active filter is said not to apply (G1.1).
 */
export function BudgetsTile({ load, filter }: { load: { data?: BudgetsResponse }; filter: GlobalFilter }) {
  const d = load.data;
  const rows = d ? budgetGlance(d) : [];
  const credits = d ? creditGlance(d.credits) : [];
  if (!rows.length && !credits.length) return null;
  const ignored = filterNotApplied(filter, []);
  return (
    <section className="ne-card ne-tile" aria-label="Budgets (advisory)">
      <div className="ne-tile-label">
        <Icon name="lock" size={14} /> {rows.length ? 'Budgets (advisory, not caps)' : 'Credits'}
      </div>
      <div className="ne-stack" style={{ gap: 8, marginTop: 4 }}>
        {rows.slice(0, 4).map(b => (
          <div key={b.key}>
            <div className="ne-between" style={{ fontSize: 12.5 }}>
              <span>{b.name}</span>
              <span className="ne-num">{b.percent === null ? fmtMoney(b.amount, 0) : `${fmtNumber(b.percent, 1)} % of ${fmtMoney(b.amount, 0)}`}</span>
            </div>
            {/* No data reads the same as on Budgets & credits: the reason in grey, no meter (an empty bar would read as 0 % used). */}
            {b.percent === null ? <Badge tone="neutral" wrap>{b.reason}</Badge> : <Meter percent={Math.min(100, b.percent)} tone={b.tone === 'neutral' ? 'accent' : b.tone} label={`Budget ${b.name}`} />}
          </div>
        ))}
        {credits.slice(0, 3).map(c => (
          <div key={c.key} style={{ fontSize: 12.5 }}>
            {/* Amber when expiring or running out; grey otherwise, never green: a credit is not a health check (W1-P21, #36). */}
            <span>{c.name}:</span> {c.tone === 'warn' ? <Badge tone="warn" wrap>{c.text}</Badge> : <span className="ne-muted">{c.text}</span>}
          </div>
        ))}
        {ignored ? (
          <Badge tone="neutral" wrap>
            {ignored}
          </Badge>
        ) : null}
      </div>
      <div className="ne-tile-source">
        <Link to="/budgets">Budgets &amp; credits →</Link>
      </div>
    </section>
  );
}
