import type { NodeGroupCapacity, QuotaAllowanceView } from '@internal/nebius-domain';
import { Badge, Callout, fmtNumber } from '../../ui';
import { nodeGroupQuotaStatus, NodeGroupQuotaStatus } from './helpers';
import { QUOTA_REQUEST } from './QuotaSections';

/** Where quota requests are made (console). */
export const QUOTA_CONSOLE_URL = 'https://console.nebius.com/quota';

const STATUS_TONE = { complete: 'ok', 'scaled-to-zero': 'neutral', above: 'warn', ok: 'info', blocked: 'danger', exhausted: 'danger', 'not-checked': 'neutral' } as const;

const nodes = (n: number) => `${fmtNumber(n)} node${n === 1 ? '' : 's'}`;

/** The full sentence: the badge's tooltip, and what a screen reader hears. */
export function statusText(s: NodeGroupQuotaStatus, g: Pick<NodeGroupCapacity, 'nodes' | 'fixedNodeCount' | 'autoscaling'>): string {
  switch (s.state) {
    case 'complete':
      return 'all nodes up';
    case 'scaled-to-zero':
      // A fixed size of 0 does not autoscale: said as configured, not as an autoscaling minimum.
      return g.fixedNodeCount !== undefined
        ? `No node running: the spec fixes ${nodes(g.fixedNodeCount)}. Nothing is missing; nothing is up.`
        : `No node running: autoscaling ${g.autoscaling?.min ?? 0}–${g.autoscaling?.max ?? 0} is at its minimum of 0. Nothing is missing; nothing is up.`;
    case 'above': {
      // Observed facts only: the API gives no cause, and the portal does not guess one.
      const spec = g.fixedNodeCount !== undefined ? `the spec fixes ${fmtNumber(g.fixedNodeCount)}` : `autoscaling allows at most ${fmtNumber(s.ceiling ?? 0)}`;
      return `${nodes(g.nodes)} observed; ${spec}; the API does not say why.`;
    }
    case 'blocked':
      return `blocked: ${s.description ?? s.quota} limit 0`;
    case 'exhausted':
      return `quota exhausted: ${s.description ?? s.quota} ${fmtNumber(s.usage ?? 0)} / ${fmtNumber(s.limit ?? 0)} used, needs ${fmtNumber(s.need ?? 0)}`;
    case 'ok':
      return `${nodes(s.missing)} short; quota has room (${s.description ?? s.quota})`;
    default:
      return `${nodes(s.missing)} short; quota not checked${s.reason ? ` (${s.reason})` : ''}`;
  }
}

/** The badge: a few words that fit one line of the table (F1.12); statusText is the tooltip. */
export function shortStatusText(s: NodeGroupQuotaStatus, g: Pick<NodeGroupCapacity, 'fixedNodeCount' | 'autoscaling'>): string {
  switch (s.state) {
    case 'complete':
      return 'all nodes up';
    case 'scaled-to-zero':
      return g.fixedNodeCount !== undefined ? '0 nodes (fixed 0)' : '0 nodes (min 0)';
    case 'above':
      return `${fmtNumber(s.extra ?? 0)} above ${g.fixedNodeCount !== undefined ? 'fixed' : 'max'} ${fmtNumber(s.ceiling ?? 0)}`;
    case 'blocked':
      return 'blocked: limit 0';
    case 'exhausted':
      return 'quota used up';
    case 'ok':
      return `${fmtNumber(s.missing)} short · quota has room`;
    default:
      return `${fmtNumber(s.missing)} short · not checked`;
  }
}

/** The quota check of one node group, for the Node groups table: a short badge, the full sentence on hover and for screen readers. */
export function NodeGroupQuotaCell({ g, quotas }: { g: NodeGroupCapacity; quotas: QuotaAllowanceView[] | null }) {
  const s = nodeGroupQuotaStatus(g, quotas);
  const full = statusText(s, g);
  return (
    <span className="ne-nowrap">
      <Badge tone={STATUS_TONE[s.state]} title={full}>
        <span aria-hidden="true">{shortStatusText(s, g)}</span>
      </Badge>
      <span className="ne-sr-only">{full}</span>
    </span>
  );
}

/**
 * "Blocking your estate": node groups with fewer nodes than configured, joined to the regional quota their
 * preset consumes, when that quota is 0 or used up. Shown only when something is blocked.
 */
export function EstateBlockers({ nodeGroups, quotas }: { nodeGroups: NodeGroupCapacity[]; quotas: QuotaAllowanceView[] | null }) {
  const rows = nodeGroups.map(g => ({ g, s: nodeGroupQuotaStatus(g, quotas) })).filter(x => x.s.state === 'blocked' || x.s.state === 'exhausted');
  if (!rows.length) return null;
  return (
    <Callout tone="danger" title={`Blocking your estate: ${rows.length} node group${rows.length === 1 ? '' : 's'} short of nodes by quota`}>
      <ul className="ne-discovery-list" aria-label="Blocking your estate">
        {rows.map(({ g, s }) => (
          <li key={g.uid}>
            <strong>
              {g.cluster} / {g.name}
            </strong>{' '}
            ({g.preset ?? 'preset not stated'}, {g.region ?? 'region not stated'}): {fmtNumber(g.nodes)} of {fmtNumber(g.nodes + s.missing)} nodes up.{' '}
            {s.state === 'blocked' ? (
              <>
                <span className="ne-mono">{s.quota}</span> ({s.description ?? 'quota'}) has limit 0; {fmtNumber(s.need ?? 0)} needed.
              </>
            ) : (
              <>
                <span className="ne-mono">{s.quota}</span> ({s.description ?? 'quota'}): {fmtNumber(s.usage ?? 0)} of {fmtNumber(s.limit ?? 0)} used, {fmtNumber(s.need ?? 0)} more needed.
              </>
            )}{' '}
            <a href={QUOTA_CONSOLE_URL} target="_blank" rel="noreferrer">
              Request quota
            </a>{' '}
            <span className="ne-faint">({QUOTA_REQUEST})</span>
          </li>
        ))}
      </ul>
    </Callout>
  );
}
