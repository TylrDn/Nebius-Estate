import { useEffect, useState } from 'react';

/**
 * Minimal, honest charts: drawn from response data only, with a labelled
 * y-axis, readable x ticks and a screen-reader table. No data → no chart.
 */

export const SERIES = ['var(--ne-chart-1)', 'var(--ne-chart-2)', 'var(--ne-chart-3)', 'var(--ne-chart-4)', 'var(--ne-chart-5)', 'var(--ne-chart-6)'];

export interface BarItem {
  key: string;
  label: string;
  value: number;
  display: string;
  color?: string;
  muted?: boolean;
}

export function BarList({ items, label, max }: { items: BarItem[]; label: string; max?: number }) {
  const top = max ?? Math.max(...items.map(i => Math.abs(i.value)), 0);
  return (
    <div className="ne-barlist" role="list" aria-label={label}>
      {items.map((it, idx) => (
        <div className="ne-barlist-row" role="listitem" key={it.key}>
          <span className="ne-barlist-label" title={it.label}>
            {it.label}
          </span>
          <div className="ne-bar-track" aria-hidden>
            <div
              className="ne-bar-fill"
              style={{
                width: `${top > 0 ? Math.max(1.5, (Math.abs(it.value) / top) * 100) : 0}%`,
                background: it.value < 0 ? 'var(--ne-ok)' : it.muted ? 'var(--ne-border-strong)' : it.color ?? SERIES[idx % SERIES.length],
              }}
            />
          </div>
          <span className="ne-num" style={{ fontSize: '0.78125rem', color: 'var(--ne-text-2)' }}>
            {it.display}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Meter({ percent, tone = 'accent', label }: { percent: number; tone?: 'accent' | 'ok' | 'warn' | 'danger'; label: string }) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <div className="ne-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
      <div style={{ width: `${p}%`, background: `var(--ne-${tone})` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ axes */

/** The drawing width before the chart is measured (and in tests without ResizeObserver). */
const W = 600;
const PAD = { top: 10, right: 8, bottom: 22, left: 52 };

/**
 * The chart's real width in px, so the SVG draws 1:1 and its 11 px labels stay 11 px on a phone instead of
 * shrinking with a 600-unit viewBox (G4.11).
 */
function useChartWidth(): [(el: HTMLElement | null) => void, number] {
  // A callback ref: the figure mounts only once there are points, possibly after the first render.
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(W);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(entries => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}

/** Day ticks that fit: about one per 100 px, at most six. */
const maxTicks = (w: number) => Math.max(2, Math.min(6, Math.floor(w / 100)));

/** Fraction digits that write every gridline exactly: 2.5 stays 2.5 and 12.5 never reads 13 (G4.4). */
export function axisFormat(values: number[]): (v: number) => string {
  const exact = (v: number) => {
    for (let d = 0; d <= 4; d++) if (Math.abs(Math.round(v * 10 ** d) - v * 10 ** d) < 1e-6) return d;
    return 4;
  };
  const digits = Math.max(0, ...values.map(exact));
  return v => v.toLocaleString('en-US', { maximumFractionDigits: digits });
}

/** Round axis maximum (1, 2, 2.5, 5 × 10^n) at or above `v`. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

function ticks(n: number, max = 6): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil((n - 1) / (max - 1));
  const out: number[] = [];
  for (let i = 0; i < n; i += step) out.push(i);
  if (out[out.length - 1] !== n - 1) out[out.length - 1] = n - 1;
  return out;
}

const shortDay = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5) : d);

function Axes({ w, height, min, max, fmt, labels, xAt, integer }: { w: number; height: number; min: number; max: number; fmt?: (v: number) => string; labels: string[]; xAt: (i: number) => number; integer?: boolean }) {
  const y = (v: number) => PAD.top + ((max - v) / (max - min || 1)) * (height - PAD.top - PAD.bottom);
  // Counts (#52): no gridline between whole numbers, so 1 GPU never shows a 0.5 tick.
  const lines = (min < 0 ? [min, 0, max] : [0, max / 2, max]).filter(v => !integer || Number.isInteger(v));
  const label = fmt ?? axisFormat(lines);
  return (
    <g aria-hidden fontSize={11} fill="var(--ne-faint)">
      {lines.map(v => (
        <g key={v}>
          <line x1={PAD.left} x2={w - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--ne-border)" strokeDasharray={v === 0 ? undefined : '3 3'} />
          <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end">
            {label(v)}
          </text>
        </g>
      ))}
      {ticks(labels.length, maxTicks(w)).map(i => (
        <text key={i} x={xAt(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}>
          {shortDay(labels[i])}
        </text>
      ))}
    </g>
  );
}

function SrTable({ label, valueLabel, rows }: { label: string; valueLabel: string; rows: { label: string; display: string }[] }) {
  return (
    <table className="ne-sr-only">
      <caption>{label}</caption>
      <thead>
        <tr>
          <th scope="col">Day</th>
          <th scope="col">{valueLabel}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td>{r.display}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Columns with a labelled y-axis; negative values (credits) drop below zero. */
export function ColumnChart({
  points,
  height = 170,
  label,
  valueLabel,
  fmtAxis,
}: {
  /** A null value is a gap: no rows that day, never zero. */
  points: { label: string; value: number | null; display: string }[];
  height?: number;
  label: string;
  valueLabel: string;
  /** Axis labels; by default exact for every gridline (axisFormat). */
  fmtAxis?: (v: number) => string;
}) {
  const [ref, w] = useChartWidth();
  if (!points.length) return null;
  const values = points.map(p => p.value).filter((v): v is number => v !== null);
  const max = niceMax(Math.max(...values, 0));
  const minRaw = Math.min(...values, 0);
  const min = minRaw < 0 ? -niceMax(-minRaw) : 0;
  const plotW = w - PAD.left - PAD.right;
  const band = plotW / points.length;
  const y = (v: number) => PAD.top + ((max - v) / (max - min)) * (height - PAD.top - PAD.bottom);
  return (
    <figure style={{ margin: 0 }} ref={ref}>
      <svg width="100%" viewBox={`0 0 ${w} ${height}`} role="img" aria-label={label}>
        <Axes w={w} height={height} min={min} max={max} fmt={fmtAxis} labels={points.map(p => p.label)} xAt={i => PAD.left + band * i + band / 2} />
        {points.map((p, i) => {
          if (p.value === null) return null;
          const top = y(Math.max(p.value, 0));
          const bottom = y(Math.min(p.value, 0));
          return (
            <rect key={p.label} x={PAD.left + band * i + band * 0.18} width={band * 0.64} y={top} height={Math.max(bottom - top, 1)} rx={2} fill={p.value < 0 ? 'var(--ne-ok)' : 'var(--ne-chart-1)'}>
              <title>{`${p.label}: ${p.display}`}</title>
            </rect>
          );
        })}
      </svg>
      <SrTable label={label} valueLabel={valueLabel} rows={points} />
    </figure>
  );
}

/**
 * Daily trend line. Days without data (null, or missing from `points`) break
 * the line: a gap means "not observed", never zero. A day with a `note` was recorded incompletely (#33): its point
 * is hollow, its reason is on the point and in the table, and a caption names the days. When no day has a value the
 * chart says so instead of drawing empty axes (#52); whole-number series get whole-number gridlines.
 */
export function TrendChart({
  points,
  height = 120,
  label,
  valueLabel,
  color = 'var(--ne-chart-1)',
  fmt = v => v.toLocaleString('en-US', { maximumFractionDigits: 1 }),
  max: fixedMax,
  empty = 'No samples in these days.',
}: {
  points: { day: string; value: number | null; note?: string }[];
  height?: number;
  label: string;
  valueLabel: string;
  color?: string;
  fmt?: (v: number) => string;
  max?: number;
  /** Said instead of the chart when no day has a value. */
  empty?: string;
}) {
  const [ref, w] = useChartWidth();
  if (!points.length) return null;
  if (points.every(p => p.value === null)) {
    return (
      <p className="ne-faint" style={{ margin: 0, fontSize: 'var(--ne-fs-caption)' }}>
        {empty}
      </p>
    );
  }
  // Lay out on a continuous day axis so missing days stay visible as gaps.
  const first = Date.parse(`${points[0].day}T00:00:00Z`);
  const last = Date.parse(`${points[points.length - 1].day}T00:00:00Z`);
  const nDays = Math.round((last - first) / 86_400_000) + 1;
  const byDay = new Map(points.map(p => [p.day, p.value]));
  const notes = new Map(points.filter(p => p.note && p.value !== null).map(p => [p.day, p.note as string]));
  const days = Array.from({ length: nDays }, (_, i) => new Date(first + i * 86_400_000).toISOString().slice(0, 10));
  const values = days.map(d => byDay.get(d) ?? null);
  const present = values.filter((v): v is number => v !== null);
  const max = fixedMax ?? niceMax(Math.max(...present, 0));
  const integer = fixedMax === undefined && present.every(v => Number.isInteger(v));
  const plotW = w - PAD.left - PAD.right;
  const x = (i: number) => PAD.left + (nDays === 1 ? plotW / 2 : (plotW * i) / (nDays - 1));
  const y = (v: number) => PAD.top + ((max - v) / max) * (height - PAD.top - PAD.bottom);
  const segments: string[] = [];
  let cur = '';
  values.forEach((v, i) => {
    if (v === null) {
      if (cur) segments.push(cur);
      cur = '';
      return;
    }
    cur += `${cur ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  if (cur) segments.push(cur);
  const lastIdx = values.map((v, i) => (v === null ? -1 : i)).filter(i => i >= 0).pop();
  return (
    <figure style={{ margin: 0 }} ref={ref}>
      <svg width="100%" viewBox={`0 0 ${w} ${height}`} role="img" aria-label={label}>
        <Axes w={w} height={height} min={0} max={max} fmt={fmt} labels={days} xAt={x} integer={integer} />
        {segments.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {values.map((v, i) => {
          if (v === null) return null;
          const note = notes.get(days[i]);
          return note ? (
            <circle key={days[i]} cx={x(i)} cy={y(v)} r={3.5} fill="var(--ne-surface)" stroke={color} strokeWidth={1.75} data-incomplete="true">
              <title>{`${days[i]}: ${fmt(v)} · ${note}`}</title>
            </circle>
          ) : (
            <circle key={days[i]} cx={x(i)} cy={y(v)} r={i === lastIdx ? 3.5 : 1.8} fill={color}>
              <title>{`${days[i]}: ${fmt(v)}`}</title>
            </circle>
          );
        })}
      </svg>
      {notes.size ? (
        <figcaption className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)', marginTop: 2 }}>
          {`Hollow point: ${notes.size === 1 ? 'a day' : 'days'} recorded incompletely (${[...notes.keys()].map(shortDay).join(', ')}).`}
        </figcaption>
      ) : null}
      <SrTable
        label={label}
        valueLabel={valueLabel}
        rows={days.map((d, i) => ({ label: d, display: values[i] === null ? 'not observed' : `${fmt(values[i] as number)}${notes.has(d) ? ' (recorded incompletely)' : ''}` }))}
      />
    </figure>
  );
}
