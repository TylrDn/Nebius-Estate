import { observedCell, observedRow } from './observed';

describe('a resource shows its own read time', () => {
  const now = new Date('2026-10-12T20:18:00Z');
  it('"Observed" when the latest inventory sync read it', () => {
    expect(observedRow({ observedAt: '2026-10-12T20:15:00Z' }, now)).toEqual(['Observed', '2026-10-12 20:15 UTC (3 min ago)']);
    expect(observedCell({ observedAt: '2026-10-12T20:15:00Z' }, now)).toEqual({ text: '3 min ago', lastSeen: false });
  });
  it('"Last seen" with why when it did not (followup 23: a deleted PostgreSQL cluster read as running)', () => {
    const r = { observedAt: '2026-10-12T19:12:00Z', lastSeen: '2026-10-12T19:12:00Z' };
    const [label, text] = observedRow(r, now);
    expect(label).toBe('Last seen');
    expect(text).toMatch(/^2026-10-12 19:12 UTC \(.+ ago\): not read by the latest inventory sync .* never priced in the run-rate$/);
    expect(observedCell(r, now)).toEqual({ text: expect.stringMatching(/^last seen .+ ago$/), lastSeen: true });
  });
});
