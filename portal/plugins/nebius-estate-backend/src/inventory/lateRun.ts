import { connect } from 'net';

/**
 * A scheduled sync that starts long after it was due (F1.45). On 2026-10-12 the Mac woke from a battery-exhaustion
 * sleep and the overdue sync fired in the same second, before Wi-Fi and DNS were back: every call failed. A run that
 * starts more than twice its interval after the previous one probes the API first, waits a bounded time for it,
 * and is deferred to the next run when it stays unreachable: nothing is called, so no failed run is recorded and the
 * last good data stands. Lateness is measured on the wall clock (Date.now): the monotonic clock does not advance
 * while a Mac sleeps.
 */
export interface LateRunDeps {
  intervalMs: number;
  /** Whether the API answers a connection now (tcpReachable). A throw counts as unreachable. */
  probe: () => Promise<boolean>;
  /** Wall clock, ms. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long a late run waits for the API before it is deferred (default 2 min, within the task's 10 min timeout). */
  maxWaitMs?: number;
  /** Probe spacing while waiting (default 10 s). */
  probeEveryMs?: number;
}

export interface LateRunCheck {
  run: boolean;
  late: boolean;
  /** How long after its due time the run started (0 when on time). */
  lateByMs: number;
  /** Why a late run was deferred, or how long it waited for the network. */
  reason?: string;
}

export class LateRunGuard {
  private last: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: LateRunDeps) {
    this.now = d.now ?? (() => Date.now());
    this.sleep = d.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.last = this.now();
  }

  /** At the start of each scheduled run: whether to run it now. */
  async check(): Promise<LateRunCheck> {
    const started = this.now();
    const since = started - this.last;
    this.last = started;
    if (since <= 2 * this.d.intervalMs) return { run: true, late: false, lateByMs: 0 };
    const lateByMs = since - this.d.intervalMs;
    const maxWait = this.d.maxWaitMs ?? 120_000;
    const every = this.d.probeEveryMs ?? 10_000;
    for (;;) {
      if (await this.d.probe().catch(() => false)) {
        const waited = this.now() - started;
        return { run: true, late: true, lateByMs, reason: waited > 0 ? `the API answered ${Math.round(waited / 1000)} s after the late start` : undefined };
      }
      if (this.now() - started >= maxWait) break;
      await this.sleep(every);
    }
    this.last = this.now();
    const minutes = Math.round(lateByMs / 60_000);
    return {
      run: false,
      late: true,
      lateByMs,
      reason: `Scheduled sync started ${minutes} min after it was due and the Nebius API was not reachable for ${Math.round(maxWait / 1000)} s: deferred to the next run; the last data stands.`,
    };
  }
}

/** Opens and closes a TCP connection to the origin's host and port (DNS included); sends nothing. */
export function tcpReachable(origin: string, timeoutMs = 5_000): Promise<boolean> {
  const u = new URL(origin);
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  return new Promise(resolve => {
    const socket = connect({ host: u.hostname, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
