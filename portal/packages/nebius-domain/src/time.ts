/**
 * "How long ago", one rounding rule everywhere: whole elapsed units (floor). An export lag of 1 h 59 min is
 * "1 h" on every page, and the same timestamp reads "1 h ago"; a connector last answered 90 s ago is "1 min"
 * in Freshness and "1 min ago" in Last attempt. Never rounded up to a time that has not yet passed.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function elapsedMs(iso: string | undefined, now: Date): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : now.getTime() - t;
}

/** Whole minutes since `iso` (0 for the future), or undefined without a valid time. */
export function wholeMinutesSince(iso: string | undefined, now: Date): number | undefined {
  const ms = elapsedMs(iso, now);
  return ms === undefined ? undefined : Math.max(0, Math.floor(ms / MINUTE));
}

/** Whole hours since `iso` (0 for the future): the export lag shown on Overview, Costs and Budgets. */
export function lagHours(iso: string | undefined, now: Date): number | undefined {
  const ms = elapsedMs(iso, now);
  return ms === undefined ? undefined : Math.max(0, Math.floor(ms / HOUR));
}

/** Whole units of a duration: minutes under an hour, hours under 48 h, then days (floor). */
function wholeUnits(ms: number): { n: number; unit: string } {
  const abs = Math.abs(ms);
  const [size, unit] = abs < HOUR ? [MINUTE, 'min'] : abs < 2 * DAY ? [HOUR, 'h'] : [DAY, 'd'];
  return { n: Math.floor(abs / size), unit };
}

/** "35 min", "47 h", "49 d": the one duration formatter, the same units as agoText; "under 1 min" below a minute. */
export function durationText(ms: number): string {
  const { n, unit } = wholeUnits(ms);
  return n === 0 ? 'under 1 min' : `${n} ${unit}`;
}

/** An export lag of whole hours (lagHours) in durationText's units: "5 d" for 124 h, as "5 d ago" beside it. */
export function lagText(hours: number): string {
  return hours < 1 ? 'under 1 h' : durationText(hours * HOUR);
}

/** A time ahead, "in 49 d", from the milliseconds until it: the same text agoText gives for that timestamp; "now" once due. */
export function untilText(ms: number): string {
  if (!(ms > 0) || wholeUnits(ms).n === 0) return 'now';
  return `in ${durationText(ms)}`;
}

/** "just now", "6 min ago", "1 h ago", "3 d ago", "in 8 h": minutes under an hour, hours under 48 h, then days. */
export function agoText(iso: string | undefined, now: Date): string {
  if (!iso) return '—';
  const ms = elapsedMs(iso, now);
  if (ms === undefined) return iso;
  const { n } = wholeUnits(ms);
  if (n === 0) return 'just now';
  return ms >= 0 ? `${durationText(ms)} ago` : untilText(-ms);
}
