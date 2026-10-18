import type { HealthStats } from '@internal/nebius-domain';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, fmtAgo, fmtTime, KeyValue } from '../../ui';
import { describeRuns, docHref, failuresText, fmtDuration, fmtRate, isNeutralRun, parseHint, rateTone } from './model';

/** A backend hint with role names as code and repository docs as links into the document viewer. */
export function HintText({ hint }: { hint: string }) {
  return (
    <>
      {parseHint(hint).map((p, i) =>
        p.kind === 'code' ? (
          <code key={i}>{p.text}</code>
        ) : p.kind === 'doc' ? (
          <Link key={i} to={docHref(p.path, p.anchor)}>
            {p.text}
          </Link>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Recent runs, oldest left: bar height is the run's duration; a failed run is a full-height
 * bar with a gap marker, so success and failure differ by shape as well as colour.
 */
export function RunSparkline({ runs }: { runs: HealthStats['recentRuns'] }) {
  if (!runs.length) return <span className="ne-faint">no runs recorded</span>;
  const ordered = [...runs].reverse();
  const max = Math.max(1, ...ordered.map(r => r.durationMs));
  const w = 5;
  const gap = 2;
  const h = 20;
  const label = describeRuns(runs);
  return (
    <svg className="ne-u1-spark" width={ordered.length * (w + gap)} height={h} viewBox={`0 0 ${ordered.length * (w + gap)} ${h}`} role="img" aria-label={label}>
      <title>{label}</title>
      {ordered.map((r, i) => {
        const x = i * (w + gap);
        if (isNeutralRun(r)) {
          // Not set up or waiting: a short neutral tick, neither success nor failure.
          return <rect key={`${r.at}-${i}`} className="ne-u1-spark-neutral" x={x} y={h - 3} width={w} height={3} rx={1} />;
        }
        if (!r.ok) {
          return (
            <g key={`${r.at}-${i}`} className="ne-u1-spark-fail">
              <rect x={x} y={0} width={w} height={h - 7} rx={1} />
              <rect x={x} y={h - 4} width={w} height={4} rx={1} />
            </g>
          );
        }
        const bh = Math.max(3, Math.round((r.durationMs / max) * h));
        return <rect key={`${r.at}-${i}`} className="ne-u1-spark-ok" x={x} y={h - bh} width={w} height={bh} rx={1} />;
      })}
    </svg>
  );
}

/** Connector health from recorded runs; each field is optional on the wire and shown only when known. */
export function HealthSummary({ health, now, outages }: { health: HealthStats; now: Date; outages?: ReadonlySet<string> }) {
  const items: [string, ReactNode][] = [
    [
      'Runs (24 h)',
      <span key="r" className="ne-row" style={{ gap: 6 }}>
        <span className="ne-num">{health.runs24h ?? 0}</span>
        <Badge tone={rateTone(health, outages)} wrap>{health.runs24h ? `${fmtRate(health)} succeeded` : fmtRate(health)}</Badge>
      </span>,
    ],
    ['Duration p50 · p95', <span key="d" className="ne-num">{`${fmtDuration(health.p50Ms)} · ${fmtDuration(health.p95Ms)}`}</span>],
    [
      'Consecutive failures',
      health.consecutiveFailures === undefined ? (
        <span key="f" className="ne-faint">
          not recorded
        </span>
      ) : health.consecutiveFailures > 0 ? (
        <Badge key="f" tone="danger">
          {health.consecutiveFailures}
        </Badge>
      ) : (
        <span key="f" className="ne-num">
          0
        </span>
      ),
    ],
  ];
  const failures = failuresText(health);
  if (failures) {
    items.push([
      'Failures (24 h)',
      <span key="x" title={health.lastFailureAt ? fmtTime(health.lastFailureAt) : undefined}>
        {failures}
        {health.lastFailureAt ? ` · last failure ${fmtAgo(health.lastFailureAt, now)}` : ''}
      </span>,
    ]);
  }
  if (health.nextRunAt) {
    // A fast re-sync while something is changing state says why: "in 2 min (a cluster is provisioning)".
    const when = fmtAgo(health.nextRunAt, now);
    items.push(['Next run', <span key="n" title={fmtTime(health.nextRunAt)}>{health.nextRunReason ? `${when} (${health.nextRunReason})` : when}</span>]);
  }
  items.push(['Recent runs', <RunSparkline key="s" runs={health.recentRuns ?? []} />]);
  return <KeyValue items={items} />;
}

/** One line of capability health for a table cell. */
export function HealthCell({ health, latencyMs, outages }: { health?: HealthStats; latencyMs?: number; outages?: ReadonlySet<string> }) {
  if (!health) return latencyMs !== undefined ? <span className="ne-num">{`last call ${fmtDuration(latencyMs)}`}</span> : <span className="ne-faint">no runs recorded</span>;
  return (
    <div className="ne-u1-health">
      <div className="ne-row" style={{ gap: 4 }}>
        {/* A full success rate is the normal state: plain text; a badge only when runs failed. */}
        {rateTone(health, outages) === 'ok' ? <span className="ne-num">{fmtRate(health)}</span> : <Badge tone={rateTone(health, outages)}>{fmtRate(health)}</Badge>}
        {health.consecutiveFailures > 0 ? <Badge tone="danger">{`${health.consecutiveFailures} failed in a row`}</Badge> : null}
      </div>
      {failuresText(health) ? (
        <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>
          {failuresText(health)}
          {health.lastFailureAt ? ` · last ${fmtTime(health.lastFailureAt)}` : ''}
        </div>
      ) : null}
      <div className="ne-faint ne-num" style={{ fontSize: 'var(--ne-fs-caption)' }}>
        {`p50 ${fmtDuration(health.p50Ms)} · p95 ${fmtDuration(health.p95Ms)}`}
      </div>
      <RunSparkline runs={health.recentRuns ?? []} />
    </div>
  );
}
