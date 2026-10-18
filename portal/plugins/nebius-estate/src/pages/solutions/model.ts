import type { EvidenceItem, EvidenceKind, Footprint, RecipeProofLevel, RecipeView, SolutionFootprintView } from '@internal/nebius-domain';
import { fmtMoney } from '../../ui/format';
import { estimateOf, LivePriceState, priceBasisText } from '../pricing/livePrice';

/** One live-price request of a solution footprint: the body POST /pricing/footprint takes. */
export interface PriceRequest {
  key: 'on-demand' | 'preemptible';
  label: string;
  runHours?: number;
  lineHours?: Record<string, number>;
  body: { footprint: Footprint; region?: string; capacityType: 'on-demand' | 'preemptible' };
}

const LABELS: Record<PriceRequest['key'], string> = { 'on-demand': 'On-demand', preemptible: 'Preemptible (spot now)' };

/** A row's label with the price basis of the answer (the shared "contract price (= list)" / "list price" wording). */
export function priceRowLabel(r: Pick<PriceRequest, 'key' | 'label'>, state: LivePriceState): string {
  const est = r.key === 'on-demand' ? estimateOf(state) : undefined;
  return est ? `${r.label} · ${priceBasisText(est, fmtMoney)}` : r.label;
}

/** The calculator requests for one footprint file: one per capacity type it asks to compare. */
export function priceRequests(fp: SolutionFootprintView): PriceRequest[] {
  if (!fp.footprint) return [];
  return fp.capacityTypes.map(k => ({ key: k, label: LABELS[k], runHours: fp.runHours, lineHours: fp.lineHours, body: { footprint: fp.footprint!, region: fp.region, capacityType: k } }));
}

export function footprintLabel(fp: SolutionFootprintView): string {
  return [fp.path.split('/').pop(), fp.region, fp.runHours !== undefined ? `${fp.runHours} h` : undefined].filter(Boolean).join(' · ');
}

/** Tone of a proof level: measured and live runs are proof, a plan is a read, the rest is not run yet; nothing backing it is a warning. */
export const PROOF_TONE: Record<RecipeProofLevel, 'ok' | 'info' | 'accent' | 'warn' | 'neutral'> = {
  Measured: 'ok',
  'Live run': 'ok',
  'Live read / plan': 'info',
  'Offline-ready': 'accent',
  'Mocked only': 'neutral',
  'Not measured': 'warn',
};

/** Strongest evidence first; unmeasured claims before the static checks so they are not missed. */
export const EVIDENCE_ORDER: EvidenceKind[] = ['repo-live', 'upstream-live', 'not-measured', 'mocked-plan-test', 'static-validation'];

/**
 * A recipe card's evidence: the strongest, newest `n` rows lead and the rest fold, so a card does not grow with every
 * live session. A not-measured claim always leads: it is shown so that nothing is mistaken for proven. With
 * `recipeId`, rows whose primary recipe is that one come first (#48: R1's own validation run was folded under
 * "5 more" behind the R8 and R14 runs that also cover R1), then by kind and date.
 */
export function leadEvidence(rows: EvidenceItem[], n: number, recipeId?: string): { lead: EvidenceItem[]; rest: EvidenceItem[] } {
  const own = (r: EvidenceItem) => (recipeId && r.recipe !== recipeId ? 1 : 0);
  const sorted = rows
    .map((r, at) => ({ r, at }))
    .sort((a, b) => own(a.r) - own(b.r) || EVIDENCE_ORDER.indexOf(a.r.kind) - EVIDENCE_ORDER.indexOf(b.r.kind) || (b.r.date ?? '').localeCompare(a.r.date ?? '') || a.at - b.at)
    .map(x => x.r);
  const lead = sorted.filter((r, i) => i < n || r.kind === 'not-measured');
  return { lead, rest: sorted.filter(r => !lead.includes(r)) };
}

/** Evidence rows (runs and not-measured claims) tied to a recipe. */
export function recipeEvidence(items: EvidenceItem[], recipeId: string): EvidenceItem[] {
  return items.filter(i => i.recipe === recipeId || !!i.recipes?.includes(recipeId));
}

export function capsText(caps: Record<string, number> | undefined): string | undefined {
  return caps ? Object.entries(caps).map(([s, n]) => `${s} ${n}`).join(' · ') : undefined;
}

export function provisioningText(r: Pick<RecipeView, 'provisioning' | 'liveRoots'>): string {
  if (r.provisioning === 'form') return 'Form on the Provisioning page';
  if (r.provisioning === 'live-root') return `Read-only live roots: ${r.liveRoots.map(p => p.split('/')[2]).join(', ') || 'none in this checkout'} (no form)`;
  return 'Documentation and runbook';
}

/**
 * README amounts ("$9,127.34", "$32.40–$1,800") written the way the rest of the portal writes money: the amount, then
 * "USD". A range keeps one unit at its end. Only the display changes; the README stays as written.
 */
export function usdText(text: string): string {
  return text
    .replace(/\$(\d[\d,]*(?:\.\d+)?)\s*([–-])\s*\$(\d[\d,]*(?:\.\d+)?)/g, '$1$2$3 USD')
    .replace(/\$(\d[\d,]*(?:\.\d+)?)/g, '$1 USD');
}
