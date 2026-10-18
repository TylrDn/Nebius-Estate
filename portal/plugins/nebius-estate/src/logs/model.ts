import { buildLogQuery, LOG_PRESETS } from '@internal/nebius-domain';
import type { LogBucketsResponse, LogBucketStatus } from '@internal/nebius-domain';
import { fmtTime } from '../ui/format';

/** View helpers for the Logs page: the initial query from a deep link, time ranges and list windowing. */

export const LOG_RANGES = [
  { id: '15m', label: '15 min', ms: 15 * 60_000 },
  { id: '1h', label: '1 h', ms: 3_600_000 },
  { id: '6h', label: '6 h', ms: 6 * 3_600_000 },
  { id: '24h', label: '24 h', ms: 86_400_000 },
  { id: '7d', label: '7 d', ms: 7 * 86_400_000 },
] as const;
export type LogRange = (typeof LOG_RANGES)[number]['id'];

/** The query a URL asks for: an explicit `q`, a preset, or a bucket (narrowed to one resource), else serial-console errors. */
export function initialQuery(p: { q?: string | null; preset?: string | null; bucket?: string | null; resource?: string | null }): string {
  if (p.q) return p.q;
  const preset = LOG_PRESETS.find(x => x.id === p.preset);
  if (preset) return preset.query;
  if (p.bucket) return buildLogQuery({ bucket: p.bucket, resourceId: p.resource ?? undefined });
  return LOG_PRESETS[0].query;
}

/**
 * The query the page opens on when its link names none: the serial-console errors preset while that bucket has lines
 * in the last 7 days, else the bucket that wrote last (all its lines, with why), never a bucket with no lines when
 * another has some (Wave 1 verification). A bucket "has lines" by its newest line; when no newest line could be read,
 * by being listed.
 */
export function defaultQuery(buckets: Pick<LogBucketStatus, 'id' | 'service' | 'state' | 'newest'>[]): { query: string; note?: string } {
  const preset = LOG_PRESETS[0];
  const read = buckets.some(b => b.newest);
  const hasLines = (b: (typeof buckets)[number]) => (read ? Boolean(b.newest) : b.state === 'present');
  const presetBucket = buckets.find(b => b.id === preset.bucket);
  const withLines = buckets.filter(hasLines);
  if (!withLines.length || (presetBucket && hasLines(presetBucket))) return { query: preset.query };
  // Newest first; a tie keeps the bucket order.
  const last = withLines.reduce((a, b) => ((b.newest ?? '') > (a.newest ?? '') ? b : a));
  const from = presetBucket?.service ?? preset.bucket;
  return {
    query: buildLogQuery({ bucket: last.id }),
    note: `${from} has no lines in the last 7 days; showing ${last.service}${last.newest ? `, the bucket that wrote last (${fmtTime(last.newest)})` : ''}`,
  };
}

/** Rows to render for a scroll position: the visible window plus `overscan` rows each side. */
export function visibleWindow(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 10): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return { start, end: Math.max(start, end) };
}

/** The line list's height: its lines, up to the viewport (3 lines no longer sit in a 460 px box, F1.24). */
export function listHeight(count: number, rowHeight: number, viewport: number): number {
  return Math.min(viewport, count * rowHeight);
}

/**
 * "08:15:02.123" — the time of a line in UTC, to the millisecond; "10-07 08:15:02.123" with `withDate`, for a
 * result whose range spans more than one UTC day (G3.7: a 7 d result mixed days with no date on the rows).
 */
export const lineTime = (iso: string, withDate = false) => (withDate ? `${iso.slice(5, 10)} ${iso.slice(11, 23)}` : iso.slice(11, 23));

/** Whether a time range covers more than one UTC calendar day. */
export const spansDays = (startIso: string, endIso: string) => startIso.slice(0, 10) !== endIso.slice(0, 10);

/** A line as shown: control bytes (C0 except tab, DEL, C1) and replacement characters from undecodable bytes removed. */
// eslint-disable-next-line no-control-regex
export const displayLine = (line: string) => line.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\ufffd]/g, '');

/**
 * Why the page shows this project when none was chosen: the one that wrote last (#31: the backend picks by the newest
 * line when it could read it), the one with logs, or the first. Empty when one was chosen.
 */
export function projectNote(b: Pick<LogBucketsResponse, 'project' | 'projectsWithLogs'>, chosen: boolean): string {
  if (chosen) return '';
  const pick = 'pick another with the project filter above';
  const w = b.projectsWithLogs;
  if (!w) return `the first in your scope; ${pick}`;
  if (!w.length) return 'no project in your scope has log buckets in the last 7 days; showing the first';
  if (w.length === 1) return `the project in your scope with log buckets in the last 7 days; ${pick}`;
  const names = w.map(p => p.name ?? p.id).join(', ');
  const newest = w.find(p => p.id === b.project.id)?.newest;
  if (newest) return `the one that wrote last (${newest.slice(0, 10)} ${newest.slice(11, 16)} UTC) of ${w.length} projects with log buckets in the last 7 days (${names}); ${pick}`;
  if (w.find(p => p.id === b.project.id)?.recent && w.some(p => !p.recent)) return `the one with logs in the last 24 h of ${w.length} projects with log buckets in the last 7 days (${names}); ${pick}`;
  return `the first of ${w.length} projects with log buckets in the last 7 days (${names}); ${pick}`;
}
