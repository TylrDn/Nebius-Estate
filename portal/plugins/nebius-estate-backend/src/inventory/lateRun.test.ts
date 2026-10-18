import { AddressInfo, createServer } from 'net';
import { LateRunGuard, tcpReachable } from './lateRun';

/**
 * F1.45: the Mac woke from a battery-exhaustion sleep and the overdue scheduled sync fired in the same second,
 * before Wi-Fi and DNS were back. A scheduled run that starts more than twice its interval late probes the API
 * first, waits a bounded time for it, and defers the run when it stays unreachable. Fake clock throughout.
 */
describe('a late scheduled run (F1.45)', () => {
  const INTERVAL = 15 * 60_000;
  beforeEach(() => jest.useFakeTimers({ now: Date.parse('2026-10-12T01:00:00Z') }));
  afterEach(() => jest.useRealTimers());

  const guard = (probe: () => Promise<boolean>) => new LateRunGuard({ intervalMs: INTERVAL, probe, now: () => Date.now(), maxWaitMs: 120_000, probeEveryMs: 10_000 });

  it('on time: runs without probing', async () => {
    const probe = jest.fn(async () => false);
    const g = guard(probe);
    jest.setSystemTime(Date.now() + INTERVAL + 5_000);
    await expect(g.check()).resolves.toMatchObject({ run: true, late: false });
    jest.setSystemTime(Date.now() + 2 * INTERVAL); // exactly 2x: not late
    await expect(g.check()).resolves.toMatchObject({ run: true, late: false });
    expect(probe).not.toHaveBeenCalled();
  });

  it('late, network back within the wait: probes, waits for it, then runs', async () => {
    const back = Date.now() + 9 * 3_600_000 + 25_000;
    const probe = jest.fn(async () => Date.now() >= back);
    const g = guard(probe);
    jest.setSystemTime(Date.now() + 9 * 3_600_000); // the laptop slept nine hours
    const result = g.check();
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(result).resolves.toMatchObject({ run: true, late: true });
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('late, network still down after the wait: defers the run (no sync, no failed run) and says why', async () => {
    const probe = jest.fn(async () => false);
    const g = guard(probe);
    jest.setSystemTime(Date.now() + 9 * 3_600_000);
    const result = g.check();
    await jest.advanceTimersByTimeAsync(121_000);
    const r = await result;
    expect(r).toMatchObject({ run: false, late: true, reason: expect.stringMatching(/not reachable.*deferred/) });
    expect(probe.mock.calls.length).toBe(13); // at once, then every 10 s for 2 min
    // The next run is measured from this one: on time again, no probe.
    probe.mockClear();
    jest.setSystemTime(Date.now() + INTERVAL);
    await expect(g.check()).resolves.toMatchObject({ run: true, late: false });
    expect(probe).not.toHaveBeenCalled();
  });

  it('a probe that throws counts as unreachable', async () => {
    const g = guard(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    jest.setSystemTime(Date.now() + 3 * INTERVAL);
    const result = g.check();
    await jest.advanceTimersByTimeAsync(121_000);
    await expect(result).resolves.toMatchObject({ run: false });
  });
});

describe('tcpReachable', () => {
  it('true when the endpoint accepts a connection, false when refused; it sends nothing', async () => {
    let received = 0;
    const server = createServer(s => {
      s.on('data', () => received++);
      s.end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    await expect(tcpReachable(`http://127.0.0.1:${port}`, 2000)).resolves.toBe(true);
    await new Promise(r => server.close(r));
    await expect(tcpReachable(`http://127.0.0.1:${port}`, 2000)).resolves.toBe(false);
    expect(received).toBe(0);
  });
});
