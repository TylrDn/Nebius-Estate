export type StepState = 'done' | 'current' | undefined;

/**
 * The seven provisioning steps' states. Estimate (step 4) is done once the request is priced: a rate-book
 * estimate, a live price, or an estimate known to be unavailable (no rate book, no permission) — Prepare is
 * enabled then, so the stepper does not hold at Estimate (G5.6). Steps 6 and 7 happen outside the form.
 */
export function stepStates(s: { valid: boolean; estimate: boolean; livePriced: boolean; estimateUnavailable: boolean; created: boolean }): StepState[] {
  const done = [true, s.valid, s.valid, s.valid && (s.estimate || s.livePriced || s.estimateUnavailable), s.created, false, false];
  const first = done.findIndex(d => !d);
  return done.map((d, i) => (d ? 'done' : i === first ? 'current' : undefined));
}
