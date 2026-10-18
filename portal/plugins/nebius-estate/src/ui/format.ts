import { agoText, fmtMoney, fmtNumber, Money } from '@internal/nebius-domain';

/** The shared number formatters (nebius-domain format.ts, W1F.S6): one grouping and unit spacing everywhere. */
export { fmtCelsius, fmtMoney, fmtNumber, fmtPercent, fmtPerHour, fmtThreshold } from '@internal/nebius-domain';

export function fmtMoneyList(list: Money[] | undefined, digits = 2): string {
  if (!list || list.length === 0) return '—';
  return list.map(m => fmtMoney(m, digits)).join(' + ');
}

export function fmtGib(gib: number | undefined): string {
  if (gib === undefined) return '—';
  return gib >= 1024 ? `${fmtNumber(gib / 1024, 2)} TiB` : `${fmtNumber(gib)} GiB`;
}

/** "2026-10-10 11:54 UTC" — absolute, unambiguous. */
export function fmtTime(iso: string | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Relative to the portal clock (fixed in demo mode), e.g. "6 min ago", "in 8 h": the domain's one rounding rule (agoText). */
export function fmtAgo(iso: string | undefined, now: Date): string {
  return agoText(iso, now);
}
