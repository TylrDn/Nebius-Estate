import { agoText, durationText, lagHours, lagText, untilText, wholeMinutesSince } from './time';

describe('one rounding rule for "how long ago" (walkthrough 3)', () => {
  const now = new Date('2026-10-11T12:00:00Z');

  it('counts whole elapsed units, the same for an export lag and for "N h ago"', () => {
    const through = '2026-10-11T10:01:00Z'; // 1 h 59 min ago
    expect(lagHours(through, now)).toBe(1);
    expect(agoText(through, now)).toBe('1 h ago');
    expect(agoText('2026-10-11T11:58:30Z', now)).toBe('1 min ago');
    expect(wholeMinutesSince('2026-10-11T11:58:30Z', now)).toBe(1);
  });

  it('says "just now" under a minute, switches to days after 48 h, and handles the future and bad input', () => {
    expect(agoText('2026-10-11T11:59:31Z', now)).toBe('just now');
    expect(agoText('2026-10-09T11:00:00Z', now)).toBe('2 d ago');
    expect(agoText('2026-10-10T11:00:00Z', now)).toBe('25 h ago');
    expect(agoText('2026-10-11T20:00:00Z', now)).toBe('in 8 h');
    expect(agoText(undefined, now)).toBe('—');
    expect(agoText('nope', now)).toBe('nope');
    expect(lagHours('2026-10-11T13:00:00Z', now)).toBe(0); // never negative
    expect(lagHours(undefined, now)).toBeUndefined();
  });
});

describe('one duration formatter for times ahead (F1.3)', () => {
  const now = new Date('2026-10-11T12:00:00Z');

  it('words a duration with the same units as "how long ago": minutes under an hour, hours under 48 h, then days', () => {
    expect(durationText(35 * 60_000)).toBe('35 min');
    expect(durationText(47.9 * 3_600_000)).toBe('47 h');
    expect(durationText(1198.3 * 3_600_000)).toBe('49 d');
    expect(durationText(20_000)).toBe('under 1 min');
  });

  it('says when a scheduled start comes, the same from a timestamp (Capacity) and from hours ahead (the alert)', () => {
    const at = new Date(now.getTime() + 1198.3 * 3_600_000).toISOString();
    expect(agoText(at, now)).toBe('in 49 d');
    expect(untilText(1198.3 * 3_600_000)).toBe('in 49 d');
    expect(untilText(8 * 3_600_000)).toBe(agoText('2026-10-11T20:00:00Z', now));
    expect(untilText(0)).toBe('now');
    expect(untilText(-5)).toBe('now');
  });
});

describe('the export lag in the same units as "N d ago" (F1.3)', () => {
  it('words whole lag hours with the one duration formatter', () => {
    expect(lagText(0)).toBe('under 1 h');
    expect(lagText(1)).toBe('1 h');
    expect(lagText(47)).toBe('47 h');
    expect(lagText(124)).toBe('5 d');
    const now = new Date('2026-10-11T12:00:00Z');
    const through = '2026-10-06T07:30:00Z';
    expect(`${lagText(lagHours(through, now)!)} ago`).toBe(agoText(through, now));
  });
});
