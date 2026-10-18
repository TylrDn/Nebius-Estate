import type { AvailabilityCheck, FitsInRegion, QuotaCheck, QuotaCheckLine, QuotaNeeds, ReservationCheck } from '@internal/nebius-domain';
import { quotaLineAmount } from '@internal/nebius-domain';
import { Badge, Callout, Card, DataTable, fmtGib, fmtNumber, fmtTime } from '../../ui';
import { QUOTA_CONSOLE_URL } from '../capacity/EstateBlockers';
import { QUOTA_REQUEST } from '../capacity/QuotaSections';

type Line = QuotaCheckLine & { description?: string };

const ADVICE_TONE: Record<string, 'ok' | 'info' | 'warn' | 'danger' | 'neutral'> = { high: 'ok', medium: 'info', low: 'warn', 'limit-reached': 'danger' };

/** The docs/capacity.md arithmetic of the whole footprint, as one line (the table above checks each part that has an allowance). */
function arithmetic(n: QuotaNeeds): string {
  return `GPUs ${n.gpus} · GPU VMs ${n.gpuVms} · Non-GPU vCPU ${n.nonGpuVcpus} · Network SSD ${fmtGib(n.networkSsdGib)} · Filesystems ${fmtGib(n.filesystemGib)} · GPU clusters ${n.gpuClusters} · Managed Kubernetes clusters ${n.mk8sClusters}`;
}

/**
 * What the previewed footprint needs, against the live tenant limit and usage of its region (what enforcement
 * checks): blocked (limit 0) or short by N per quota, with where to request more. A quota that stops the plan
 * disables Prepare unless "Prepare anyway: quota request pending" is ticked (W1-P3); the regions where the same request
 * fits by the quota API are one click away. Stamped with the tenant list's own read time (#13).
 */
export function QuotaNeedsCard({
  check,
  needs,
  fitsIn,
  onUseRegion,
  pending,
}: {
  check: QuotaCheck | undefined;
  needs: QuotaNeeds;
  fitsIn?: FitsInRegion[];
  onUseRegion?: (region: string, platform: string) => void;
  pending?: { checked: boolean; onChange: (v: boolean) => void };
}) {
  const bad = check?.lines.filter(l => l.state !== 'ok') ?? [];
  return (
    <Card title={`Quota needs vs limits${check ? ` · ${check.region}` : ''}`} icon="lock" flush>
      <div className="ne-card-body ne-stack" style={{ gap: 10 }}>
        {!check || check.source === 'none' ? (
          <Callout tone="info" title="Quotas not checked">
            {check?.reason ?? 'No quota allowances were read.'} Request quota before the first apply.
          </Callout>
        ) : bad.length ? (
          <Callout tone="danger" title={`${bad.length} quota${bad.length === 1 ? '' : 's'} would stop this plan`}>
            Prepare stays disabled until it fits:{' '}
            <a href={QUOTA_CONSOLE_URL} target="_blank" rel="noreferrer">
              request quota in the console
            </a>{' '}
            ({QUOTA_REQUEST}), switch to a region where it fits, or prepare it anyway with a quota request pending.
          </Callout>
        ) : (
          <Callout tone="info" title="Within the tenant allowances">
            A quota is a ceiling, never a guarantee of GPU availability.
          </Callout>
        )}
        {bad.length && fitsIn ? (
          fitsIn.length ? (
            <div className="ne-row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }} data-testid="fits-in">
              <span style={{ fontSize: '0.8125rem' }}>
                <strong>Fits in:</strong> {fitsIn.map(f => `${f.region} (${f.platform})`).join(', ')}, by the tenant allowances listed there.
              </span>
              {onUseRegion
                ? fitsIn.map(f => (
                    <button key={f.region} type="button" className="ne-btn ne-btn-sm" onClick={() => onUseRegion(f.region, f.platform)}>
                      Use {f.region}
                    </button>
                  ))
                : null}
            </div>
          ) : (
            <div className="ne-faint" style={{ fontSize: '0.8125rem' }} data-testid="fits-in">
              Fits in: no other region confirmed by the quota API (a region counts only where its compute VM quotas are listed and every line fits).
            </div>
          )
        ) : null}
        {pending ? (
          <label htmlFor="pv-quota-pending" className="ne-row ne-cap-check" style={{ fontSize: '0.8125rem' }}>
            <input id="pv-quota-pending" type="checkbox" checked={pending.checked} onChange={e => pending.onChange(e.target.checked)} />
            Prepare anyway: quota request pending
          </label>
        ) : null}
      </div>
      {check && check.source !== 'none' ? (
        <DataTable<Line>
          caption="Quota needs vs limits"
          compact
          rows={check.lines}
          rowKey={l => l.quota}
          columns={[
            {
              key: 'q',
              header: 'Quota',
              render: l => (
                <div>
                  <div style={{ fontWeight: 600 }}>{l.description ?? l.quota}</div>
                  <div className="ne-mono ne-faint ne-cap-wrap" style={{ fontSize: 'var(--ne-fs-caption)' }}>
                    {l.quota} · {l.what}
                  </div>
                </div>
              ),
            },
            { key: 'n', header: 'Needs', align: 'right', render: l => quotaLineAmount(l.quota, l.need) },
            { key: 'l', header: 'Limit', align: 'right', render: l => quotaLineAmount(l.quota, l.limit) },
            { key: 'u', header: 'Used', align: 'right', render: l => quotaLineAmount(l.quota, l.usage) },
            {
              key: 's',
              header: 'Status',
              render: l =>
                l.state === 'ok' ? (
                  <Badge tone="ok">fits</Badge>
                ) : (
                  <a href={QUOTA_CONSOLE_URL} target="_blank" rel="noreferrer" title={`Request quota (${QUOTA_REQUEST})`}>
                    <Badge tone="danger" wrap>{l.state === 'blocked' ? 'blocked (limit 0)' : `short by ${quotaLineAmount(l.quota, l.short)}`}</Badge>
                  </a>
                ),
            },
          ]}
        />
      ) : null}
      {/* Quota ids (compute.instance.non-gpu.vcpu) are one word to the browser: they break anywhere at 390 px and 200 % text. */}
      <div className="ne-card-body ne-faint" style={{ fontSize: 'var(--ne-fs-caption)', overflowWrap: 'anywhere' }}>
        {check?.unchecked.length ? <div>Not checked (no such allowance listed): {check.unchecked.map(u => u.quota).join(', ')}.</div> : null}
        <div>Arithmetic: {arithmetic(needs)}. A quota does not guarantee GPU availability.</div>
        {check?.observedAt ? <div data-testid="quota-read-at">Tenant allowances read {fmtTime(check.observedAt)}.{check.note ? ` ${check.note}` : ''}</div> : null}
      </div>
    </Card>
  );
}

/**
 * The capacity advisor's view of the requested GPU nodes: level, available vs requested, and options with room, each a
 * one-click switch where platform/regions.yaml offers it (W1-P4). An advisor that was not read is "availability
 * unknown", never a fit.
 */
export function AvailabilityCard({ a, switches = [] }: { a: AvailabilityCheck; switches?: { key: string; label: string; onClick: () => void }[] }) {
  const short = a.state === 'short' || a.state === 'limit-reached';
  return (
    <Card title="Availability (capacity advisor)" icon="info">
      <div className="ne-stack" style={{ gap: 8 }}>
        <div className="ne-row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {a.level ? <Badge tone={ADVICE_TONE[a.level] ?? 'neutral'}>{a.level.replace('-', ' ')}</Badge> : null}
          {a.stale ? <Badge tone="warn">stale</Badge> : null}
          {a.state === 'no-advice' ? <Badge tone="neutral">no advice</Badge> : null}
          {a.state === 'unknown' ? <Badge tone="warn">availability unknown</Badge> : null}
        </div>
        {short ? <Callout tone="warn" title="Fewer available than requested">{a.message}</Callout> : <div style={{ fontSize: '0.8125rem' }}>{a.message}</div>}
        {a.alternatives.length ? (
          <div>
            <div className="ne-label">Where there is room now</div>
            <ul className="ne-discovery-list" aria-label="Where there is room now">
              {a.alternatives.map(o => (
                <li key={`${o.region}/${o.fabric}/${o.capacityType}`}>
                  {o.region}
                  {o.fabric ? ` ${o.fabric}` : ''} · {o.capacityType} · {o.level} · {fmtNumber(o.available)} available
                </li>
              ))}
            </ul>
            {switches.length ? (
              <div className="ne-row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {switches.map(x => (
                  <button key={x.key} type="button" className="ne-btn ne-btn-sm" onClick={x.onClick}>
                    {x.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <p className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)', margin: 0 }}>
          Tenant-level advice (capacity.v1), read at the last sync. It changes minute to minute; it is not a reservation.
        </p>
      </div>
    </Card>
  );
}

const RESERVATION_TONE = { matching: 'ok', none: 'danger', unknown: 'warn' } as const;

/** A reserved request against the tenant's capacity block groups (capacity.v1, W1-P4): the matching ones, or why none. */
export function ReservationsCard({ r }: { r: ReservationCheck }) {
  return (
    <Card title={`Reservations · ${r.policy}`} icon="lock">
      <div className="ne-stack" style={{ gap: 8 }}>
        <div>
          <Badge tone={r.state === 'none' && r.policy === 'AUTO' ? 'warn' : RESERVATION_TONE[r.state]}>
            {r.state === 'matching' ? `${r.groups.length} matching` : r.state === 'none' ? 'none matching' : 'unknown'}
          </Badge>
        </div>
        <div style={{ fontSize: '0.8125rem' }}>{r.message}</div>
        {r.groups.length ? (
          <ul className="ne-discovery-list" aria-label="Matching capacity block groups">
            {r.groups.map(g => (
              <li key={g.id}>
                {g.name} · {g.fabric ?? 'no fabric stated'} · {g.usage ?? '?'} of {g.limit ?? '?'} in use
              </li>
            ))}
          </ul>
        ) : null}
        <p className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)', margin: 0 }}>
          Capacity block groups of {r.platform} in {r.region}, read at tenant level{r.observedAt ? ` ${fmtTime(r.observedAt)}` : ''}.
        </p>
      </div>
    </Card>
  );
}
