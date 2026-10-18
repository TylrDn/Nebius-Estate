import { ObservedResource } from '@internal/nebius-domain';

/**
 * Lifecycle-aware fast re-sync. While a cluster, node group or VM in the last snapshot is changing state,
 * one extra sync of the fast tier runs after a short interval (nebius.fastSyncSeconds), so a cluster that
 * reaches RUNNING is connected within minutes and a cluster being deleted is shown as such before it is gone.
 */

/** "Sync now" is not repeated within this long of the connector's last attempt; a fast re-sync waits it out too. */
export const MANUAL_SYNC_COOLDOWN_MS = 60_000;

/** The only lists a fast re-sync reads (plus each configured project by id, and the discovered clusters' Kubernetes API). */
export const FAST_SYNC_LISTS: ReadonlySet<string> = new Set(['compute.instances', 'mk8s.clusters', 'mk8s.node-groups']);

/** Documented transitional states (api.nebius.cloud openapi enums; mk8s has no UPDATING today, kept as equivalent). */
const TRANSITIONAL: Partial<Record<ObservedResource['type'], readonly string[]>> = {
  'mk8s-cluster': ['PROVISIONING', 'UPDATING', 'DELETING'],
  'mk8s-node-group': ['PROVISIONING', 'UPDATING', 'DELETING'],
  'compute-instance': ['CREATING', 'STARTING', 'UPDATING', 'STOPPING', 'DELETING'],
};
const TYPE_ORDER: ObservedResource['type'][] = ['mk8s-cluster', 'mk8s-node-group', 'compute-instance'];
const NOUN: Partial<Record<ObservedResource['type'], [string, string]>> = { 'mk8s-cluster': ['cluster', 'clusters'], 'mk8s-node-group': ['node group', 'node groups'], 'compute-instance': ['VM', 'VMs'] };
const VERB: Record<string, string> = { PROVISIONING: 'provisioning', CREATING: 'being created', STARTING: 'starting', UPDATING: 'updating', STOPPING: 'stopping', DELETING: 'being deleted' };

export interface Transitional {
  uid: string;
  type: ObservedResource['type'];
  name: string;
  state: string;
}

/** Nebius inventory items in a transitional state, clusters first. */
export function transitionalResources(resources: ObservedResource[]): Transitional[] {
  const out = resources
    .filter(r => r.source.connector === 'nebius-inventory' && r.apiState && TRANSITIONAL[r.type]?.includes(r.apiState))
    .map(r => ({ uid: r.uid, type: r.type, name: r.name, state: r.apiState! }));
  const rank = (t: Transitional) => TYPE_ORDER.indexOf(t.type) * 10 + TRANSITIONAL[t.type]!.indexOf(t.state);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** "a cluster is provisioning", "2 VMs are starting", "a cluster is being deleted, a node group is provisioning and 1 more". */
export function transitionalReason(ts: Transitional[]): string | undefined {
  const groups = new Map<string, { type: Transitional['type']; state: string; n: number }>();
  for (const t of ts) {
    const k = `${t.type}|${t.state}`;
    const g = groups.get(k) ?? { type: t.type, state: t.state, n: 0 };
    g.n++;
    groups.set(k, g);
  }
  const parts = [...groups.values()].map(g => {
    const [one, many] = NOUN[g.type] ?? [g.type, `${g.type}s`];
    return g.n === 1 ? `a ${one} is ${VERB[g.state] ?? g.state.toLowerCase()}` : `${g.n} ${many} are ${VERB[g.state] ?? g.state.toLowerCase()}`;
  });
  if (!parts.length) return undefined;
  const more = parts.length - 2;
  return more > 0 ? `${parts.slice(0, 2).join(', ')} and ${more} more` : parts.join(' and ');
}

export interface FastSyncStatus {
  /** When the pending fast re-sync runs; absent when none is pending. */
  dueAt?: string;
  /** What is changing, while fast re-syncs run. */
  reason?: string;
  /** Set once the cap is reached: the normal cadence applies until nothing is transitional. */
  capped?: { after: number; reason: string };
  /** Fast re-syncs in a row so far. */
  streak: number;
}

export interface FastSyncDeps {
  /** 0 turns fast re-syncs off. */
  intervalMs: number;
  /** Fast re-syncs in a row before falling back to the normal cadence. */
  max: number;
  /** The "Sync now" cooldown: no fast re-sync starts sooner than this after the inventory's last attempt. */
  cooldownMs: number;
  /** Starts a fast-tier sync through the single-sync lock (joins a sync already running). */
  run: () => Promise<void>;
  /** Start of the inventory's latest sync attempt (epoch ms). */
  lastAttemptAt: () => number | undefined;
  logger?: { warn(message: string): void };
}

/** One pending fast re-sync at most; re-armed from the end of every sync that read the inventory. */
export class FastSync {
  private timer?: ReturnType<typeof setTimeout>;
  private dueAt?: number;
  private streak = 0;
  private reason?: string;
  private capped?: { after: number; reason: string };
  private stopped = false;

  constructor(private readonly d: FastSyncDeps) {}

  /** Called after every sync that read the inventory, with what is transitional in the fresh snapshot. */
  settle(transitional: Transitional[], wasFast: boolean) {
    this.clear();
    if (wasFast) this.streak++;
    const reason = transitionalReason(transitional);
    if (!reason || this.d.intervalMs <= 0 || this.stopped) {
      this.streak = 0;
      this.reason = undefined;
      this.capped = undefined;
      return;
    }
    if (this.streak >= this.d.max) {
      this.reason = undefined;
      this.capped = { after: this.streak, reason };
      return;
    }
    this.reason = reason;
    this.capped = undefined;
    this.arm(this.d.intervalMs);
  }

  status(): FastSyncStatus {
    return {
      ...(this.dueAt !== undefined ? { dueAt: new Date(this.dueAt).toISOString() } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.capped ? { capped: this.capped } : {}),
      streak: this.streak,
    };
  }

  stop() {
    this.stopped = true;
    this.clear();
    this.reason = undefined;
  }

  private clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.dueAt = undefined;
  }

  private arm(ms: number) {
    this.dueAt = Date.now() + ms;
    this.timer = setTimeout(() => void this.fire(), ms);
    // Never keeps the process alive on shutdown.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async fire() {
    this.timer = undefined;
    this.dueAt = undefined;
    const last = this.d.lastAttemptAt();
    const wait = last === undefined ? 0 : last + this.d.cooldownMs - Date.now();
    if (wait > 0) {
      this.arm(wait);
      return;
    }
    try {
      // The sync settles this scheduler when it finishes (and re-arms it while something still changes).
      await this.d.run();
    } catch (e) {
      this.d.logger?.warn(`nebius-estate: fast re-sync failed: ${(e as Error).message}`);
    }
    // Joined a sync that did not read the inventory (e.g. "Sync now" of another connector): nothing settled, so try again later.
    if (!this.timer && this.reason && !this.capped && !this.stopped) this.arm(this.d.intervalMs);
  }
}
