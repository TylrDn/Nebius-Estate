import { Fragment, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ALLOWANCE_VERDICT, cutsProject, docsHref, gpuQuotaModel, nearLimitCheck, nearLimitText, usageAboveLimitText } from '@internal/nebius-domain';
import type { AllowanceFinding, CapacityAllowanceView, CapacityResponse, PlannedQuotaIssue, PlatformView, QuotaAllowanceView, ReservationEvidence, SourcedMetric } from '@internal/nebius-domain';
import { Badge, Callout, Card, Chip, DataTable, EmptyState, fmtNumber, Icon, Meter, StatusPill } from '../../ui';
import { blockedPlans, byUrgency, fmtQuotaAmount, gpuModel, isComputeQuota, isGpuQuota, isUrgentQuota, matchesQuota, PREEMPTIBLE_QUOTA, quotaFigures, serviceLabel, unitLabel, urgencyRank, usageLevel } from './helpers';
import { LevelBadge, ProjectNamer, prettyEnum, SourceLine, Unavailable, UsageCell } from './parts';
import { gpuClusterBlock, k8sRecipeUsability, platformsWithoutQuota, tileLimit } from './effective';

const quotaKey = (q: QuotaAllowanceView) => `${q.scope}/${q.projectId}/${q.region ?? '-'}/${q.name}`;

/** Where to ask for more: the console path for quota requests. */
export const QUOTA_REQUEST = 'Administration → Limits → Quotas';

/** A tile per region: Compute GPU quotas (regular VMs) and the preemptible VM count. */
const isTileQuota = (q: QuotaAllowanceView) => isComputeQuota(q) && (isGpuQuota(q) || q.name === PREEMPTIBLE_QUOTA);

/**
 * Quota allowances. Tenant allowances are what enforcement checks, so they lead: Compute GPU and preemptible
 * VM quotas per region (regions the estate uses first), then the rest; other services' GPU quotas (Standalone
 * apps) sit apart; project allocations follow beneath. A limit of 0 means nothing can be created; it is an
 * alarm only for Compute in a region the estate uses (`targets`). A project placeholder is not a limit: the
 * project draws on the tenant quota.
 */
export function QuotasCard({
  metric,
  name,
  now,
  targets,
  planned,
  allowances,
  tenantGap,
  emptyScope,
  project,
  platforms,
}: {
  metric: CapacityResponse['quotas'];
  name: ProjectNamer;
  now: Date;
  targets?: Set<string>;
  /** Planned resources blocked by quota (the Overview's check): the header counts their roots. */
  planned?: SourcedMetric<PlannedQuotaIssue[]>;
  /** Real project caps against the tenant limit (the Overview's "caps below the tenant limit" row). */
  allowances?: SourcedMetric<AllowanceFinding[]>;
  /** Why no tenant allowance was read (CapacityResponse.tenantQuotasGap): no tenant id, a refusal, no answer. */
  tenantGap?: string;
  /** The filter selects no project (CapacityResponse.emptyScope): the empty tile list says that, not "no allowance". */
  emptyScope?: string;
  /** The project the global filter selects: cards lead with the limit that applies to it (W1-P14). */
  project?: string;
  /** GPU platforms the live API offers: a model without a quota gets a card (W1-P17); 8-GPU presets for the GPU cluster badge. */
  platforms?: PlatformView[] | null;
}) {
  const all = metric.value;
  const tenant = useMemo(() => (all ?? []).filter(q => q.scope === 'tenant'), [all]);
  const projects = useMemo(() => (all ?? []).filter(q => q.scope !== 'tenant'), [all]);
  const primary = tenant.length ? tenant : projects;
  const tiles = useMemo(() => primary.filter(isTileQuota), [primary]);
  const otherGpu = useMemo(() => primary.filter(q => isGpuQuota(q) && !isComputeQuota(q)).sort(byUrgency), [primary]);
  // Regions with a GPU quota tile, and those where the live API offers a GPU platform no quota names (W1-P17).
  const regions = useMemo(() => {
    const offered = tiles.length ? (platforms ?? []).flatMap(p => p.regions ?? []) : [];
    const rs = [...new Set([...tiles.map(q => q.region ?? ''), ...offered.filter(r => platformsWithoutQuota(platforms ?? null, all ?? [], r).length)])];
    return rs.sort((a, b) => Number(targets?.has(b) ?? 0) - Number(targets?.has(a) ?? 0) || a.localeCompare(b));
  }, [tiles, targets, platforms, all]);
  // The Overview's count, from the same function: the allowances enforcement checks.
  const check = useMemo(() => nearLimitCheck(all ?? []), [all]);
  const blockedRoots = blockedPlans(planned?.value);
  const inherits = projects.filter(q => q.allocation === 'inherits-tenant').length;
  return (
    <Card
      title="Quotas"
      icon="lock"
      actions={
        all ? (
          <span className="ne-row" style={{ gap: 6 }}>
            <Badge tone={check.aboveLimit.length ? 'danger' : check.near.length ? 'warn' : 'neutral'} wrap>{nearLimitText(check)}</Badge>
            {blockedRoots?.length ? (
              <a href="#planned-quota" className="ne-badge ne-tone-danger ne-badge-wrap" title={`Live roots whose own region has a limit 0 or too little quota (as on the Overview). Request quota in the console (${QUOTA_REQUEST}).`}>
                {`${blockedRoots.length} planned root${blockedRoots.length === 1 ? '' : 's'} blocked`}
              </a>
            ) : null}
          </span>
        ) : undefined
      }
      footer={
        <SourceLine
          metric={metric}
          now={now}
          extra={`${tenant.length ? 'Tenant allowances are enforced; an omitted tenant limit is 0 (the API leaves zero values out).' : `Only project allowances were read (${tenantGap ?? 'no tenant allowance list was read'}).`} A project entry without a limit of its own uses the tenant quota${inherits ? ` (${inherits} here)` : ''}; it is not a limit of 0. Request quota: ${QUOTA_REQUEST}.`}
        />
      }
    >
      {all === null ? (
        <Unavailable what="Quota allowances" metric={metric} />
      ) : (
        <div className="ne-stack" style={{ gap: 18 }}>
          <div>
            <h3 className="ne-cap-subhead">Compute GPU and preemptible VM quotas by region{tenant.length ? ' (tenant)' : ''}</h3>
            {tiles.length ? (
              <div className="ne-stack" style={{ gap: 12 }}>
                {regions.map(r => (
                  <section key={r || '-'} aria-label={`Quotas in ${r || 'region not stated'}`}>
                    <div className="ne-label" style={{ marginBottom: 6 }}>
                      {r || 'region not stated'}
                      {targets?.has(r) ? <span className="ne-faint"> · used by your estate</span> : null}
                    </div>
                    {r ? <K8sLine region={r} quotas={all} project={project} name={name} urgent={!targets?.size || targets.has(r)} /> : null}
                    <ul className="ne-cap-gpu-grid" aria-label={`GPU quotas · ${r || 'region not stated'}`}>
                      {tiles
                        .filter(q => (q.region ?? '') === r)
                        .sort((a, b) => Number(a.name === PREEMPTIBLE_QUOTA) - Number(b.name === PREEMPTIBLE_QUOTA) || byUrgency(a, b))
                        .map(q => (
                          <GpuQuotaTile key={quotaKey(q)} q={q} name={name} urgent={isUrgentQuota(q, targets)} quotas={all} project={project} platforms={platforms} />
                        ))}
                      {platformsWithoutQuota(platforms ?? null, all, r).map(pl => (
                        <PlatformTile key={pl.name} p={pl} region={r} />
                      ))}
                    </ul>
                  </section>
                ))}
                <p className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)', margin: 0 }}>
                  GPU quotas count regular (on-demand) VMs only. Preemptible VMs count against &ldquo;Preemptible VMs&rdquo;; reserved VMs against their reservation (capacity allowances below).
                </p>
              </div>
            ) : emptyScope ? (
              <EmptyState title={emptyScope} icon="info">
                No quota is shown because the filter matches no project. Change or clear the filter above.
              </EmptyState>
            ) : (
              <EmptyState title="No Compute GPU quota allowances in these projects" icon="gpu">
                The quota service answered, but listed no Compute GPU allowance for the projects in scope. Without one, no GPU VM can be created there; request quota in the console.
              </EmptyState>
            )}
          </div>
          {check.aboveLimit.length ? <AboveLimit rows={check.aboveLimit} /> : null}
          {allowances ? <AllowanceCheck metric={allowances} name={name} /> : null}
          {otherGpu.length ? (
            <details className="ne-ov-details">
              <summary>
                GPU quotas of other services ({otherGpu.length}): {[...new Set(otherGpu.map(serviceLabel))].join(', ')}
              </summary>
              <p className="ne-faint" style={{ fontSize: '0.75rem', margin: '6px 0 10px' }}>
                Not used by Compute VMs or Managed Kubernetes node groups. A limit of 0 here does not stop the estate.
              </p>
              <ul className="ne-cap-gpu-grid" aria-label="GPU quotas of other services">
                {otherGpu.map(q => (
                  <GpuQuotaTile key={quotaKey(q)} q={q} name={name} urgent={false} quotas={all} project={project} />
                ))}
              </ul>
            </details>
          ) : null}
          <OtherQuotas rows={primary} name={name} targets={targets} title={tenant.length ? 'All tenant quotas' : 'All quotas'} caption="All quota allowances" countLimits />
          {tenant.length && projects.length ? <OtherQuotas rows={projects} name={name} targets={targets} title="Project allocations" caption="Project quota allocations" /> : null}
        </div>
      )}
    </Card>
  );
}

/**
 * Quotas in use above their limit (a tenant allowance whose projects report more use than it does, against a limit
 * of 0): flagged where the card opens, not only in the folded table (F1.11).
 */
function AboveLimit({ rows }: { rows: QuotaAllowanceView[] }) {
  return (
    <Callout tone="danger" title={`In use above the limit: ${rows.length} quota${rows.length === 1 ? '' : 's'}`}>
      <ul className="ne-discovery-list" aria-label="Quotas in use above their limit">
        {rows.map(q => (
          <li key={quotaKey(q)}>
            <strong>{q.description ?? q.name}</strong> · {q.region ?? 'region not stated'}: {usageAboveLimitText(q)} <span className="ne-mono ne-faint">{q.name}</span>
          </li>
        ))}
      </ul>
    </Callout>
  );
}

const TONE: Record<AllowanceFinding['kind'], 'danger' | 'warn' | 'neutral'> = { 'zero-cap': 'danger', 'caps-below': 'warn', 'no-effect': 'neutral' };
const LABEL: Record<AllowanceFinding['kind'], string> = { 'zero-cap': 'cap 0', 'caps-below': 'below tenant', 'no-effect': 'no effect' };

/**
 * Allowance check: every project allowance with a limit of its own that differs from the tenant limit of the same
 * quota and region. Below it (or 0) the project gets less than it would inherit; above it nothing changes.
 */
export function AllowanceCheck({ metric, name }: { metric: SourcedMetric<AllowanceFinding[]>; name: ProjectNamer }) {
  const rows = metric.value;
  const cuts = rows?.filter(cutsProject).length ?? 0;
  return (
    <section id="allowance-check" aria-label="Allowance check">
      <div className="ne-between" style={{ marginBottom: 6 }}>
        <h3 className="ne-cap-subhead ne-cap-wrap" style={{ margin: 0, minWidth: 0 }}>
          Allowance check: project caps against the tenant quota
        </h3>
        {rows?.length ? <Badge tone={cuts ? 'warn' : 'neutral'}>{cuts ? `${cuts} cut a project` : 'none cut a project'}</Badge> : null}
      </div>
      {rows === null ? (
        <p className="ne-faint" style={{ margin: 0 }}>
          Not checked: {metric.unavailableReason ?? 'the tenant quota was not read.'}
        </p>
      ) : rows.length === 0 ? (
        <p className="ne-faint" style={{ margin: 0 }}>
          No project cap differs from its tenant limit. Projects without a cap of their own use the tenant quota.
        </p>
      ) : (
        <ul className="ne-stack" style={{ gap: 0, margin: 0, paddingLeft: 0, listStyle: 'none' }} aria-label="Project caps that differ from the tenant limit">
          {rows.map(f => (
            <li key={`${f.projectId}/${f.region ?? ''}/${f.name}`} className="ne-cap-allowance-row">
              {/* The badge stays on the title row at any width, so it never reads as the next item's (#59). */}
              <div className="ne-row ne-attn-row" style={{ justifyContent: 'space-between' }}>
                <span className="ne-cap-wrap" style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>{f.description ?? f.name}</span> <span className="ne-mono ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>{f.name}</span>
                </span>
                <Badge tone={TONE[f.kind]}>{LABEL[f.kind]}</Badge>
              </div>
              <div className="ne-cap-wrap" style={{ fontSize: '0.8125rem' }}>
                {name(f.projectId)} · {f.region ?? 'region not stated'}: project cap {fmtQuotaAmount(f.projectLimit, f.unit)}, tenant limit {fmtQuotaAmount(f.tenantLimit, f.unit)}. {ALLOWANCE_VERDICT[f.kind]}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="ne-faint ne-cap-wrap" style={{ fontSize: 'var(--ne-fs-caption)', margin: '6px 0 0' }}>
        The portal changes nothing. To set a cap to the tenant limit: <span className="ne-mono">scripts/quota-plan.py --plan-align</span>, then <span className="ne-mono">--apply</span> with CONFIRM=yes (runbooks/capacity-request.md). Nebius docs:{' '}
        <Link to={docsHref('/overview/quotas')}>Quotas in Nebius AI Cloud</Link>.
      </p>
    </section>
  );
}

function GpuQuotaTile({ q, name, urgent, quotas, project, platforms }: { q: QuotaAllowanceView; name: ProjectNamer; urgent: boolean; quotas: QuotaAllowanceView[]; project?: string; platforms?: PlatformView[] | null }) {
  const preemptible = q.name === PREEMPTIBLE_QUOTA;
  const model = preemptible ? 'Preemptible VMs' : gpuModel(q);
  const owner = q.scope === 'tenant' ? 'tenant' : name(q.projectId);
  const unit = preemptible ? 'VMs' : unitLabel(q.unit) || 'GPUs';
  // The limit that applies once project caps are counted: min(project cap, tenant) (W1-P14).
  const lim = tileLimit(q, quotas, project);
  const eff = lim.effective;
  const capped = eff?.by === 'project';
  // A capped project's figures set the card's level: "32 GPUs of headroom" is not what that project has.
  const shown: QuotaAllowanceView = capped ? { ...q, scope: 'project', projectId: eff.projectId, limit: eff.limit, usage: eff.usage, usagePercent: eff.limit > 0 ? (100 * eff.usage) / eff.limit : null } : q;
  const level = usageLevel(shown);
  // GPU clusters limited to 0 in the region: the model's 8-GPU presets cannot join an InfiniBand GPU cluster there
  // (they still run, without InfiniBand). Without the platform list, which models have an 8-GPU preset is not known.
  const block = preemptible ? null : gpuClusterBlock(q.region ?? '', quotas, project);
  const hasIbPreset = !!platforms && platforms.some(p => gpuQuotaModel(p.name) === /gpu\.([a-z0-9-]+)$/.exec(q.name)?.[1] && p.presets.some(s => s.gpus >= 8));
  return (
    <li className="ne-cap-gpu" data-level={level} data-urgent={urgent ? 'true' : 'false'}>
      <div className="ne-between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div className="ne-cap-gpu-model">{model}</div>
          <div className="ne-faint ne-cap-wrap" style={{ fontSize: '0.75rem' }}>
            {serviceLabel(q)} · {q.region ?? 'region not stated'} · {owner}
          </div>
        </div>
        <QuotaLevelBadge q={shown} urgent={urgent} />
      </div>
      {eff && capped ? (
        <div className="ne-cap-effective">
          <div className="ne-between" style={{ gap: 6 }}>
            <span className="ne-label">
              Effective limit for {name(eff.projectId)}: {fmtQuotaAmount(eff.usage, q.unit)} / {fmtQuotaAmount(eff.limit, q.unit)} {unit}
            </span>
            <Badge tone="warn">capped by project</Badge>
          </div>
        </div>
      ) : eff ? (
        <span className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>
          {name(eff.projectId)}: no project cap below the tenant limit, so the tenant limit applies.
        </span>
      ) : null}
      <div>
        {q.scope === 'tenant' ? (
          <>
            <span className="ne-label">Tenant</span>{' '}
          </>
        ) : null}
        <QuotaUsage q={q} label={`${model} quota in ${q.region ?? 'unknown region'}, ${owner}`} unit={unit} />
      </div>
      {!eff && lim.caps.length ? (
        <div className="ne-cap-caps ne-cap-wrap">
          Capped by project: {lim.caps.map(c => `${name(c.projectId)} ${fmtQuotaAmount(c.limit, q.unit)}`).join(' · ')}
        </div>
      ) : null}
      {lim.capsUnknown ? (
        <div className="ne-faint ne-cap-wrap" style={{ fontSize: 'var(--ne-fs-caption)' }}>
          Project cap unknown: {project ? `no quota allowance of ${name(project)} was read` : 'no project allowance was read'}, so a project may be capped below this tenant limit.
        </div>
      ) : null}
      {block && hasIbPreset ? (
        <Badge tone="warn" wrap>
          {`GPU clusters ${block.tenant ? 'limit 0 (tenant)' : `cap 0 (${block.projects.map(name).join(', ')})`}: 8-GPU presets cannot join an InfiniBand GPU cluster`}
        </Badge>
      ) : null}
      {level === 'zero-limit' && urgent ? <div className="ne-cap-blocked">Blocked: request quota ({QUOTA_REQUEST})</div> : null}
      <div className="ne-mono ne-faint ne-cap-id" style={{ fontSize: 'var(--ne-fs-caption)' }}>
        <QuotaId name={q.name} />
        {q.state ? ` · ${prettyEnum(q.state)}` : ''}
      </div>
    </li>
  );
}

/** A GPU platform the live API offers in a region where no quota names its model (W1-P17: GB300). */
function PlatformTile({ p, region }: { p: PlatformView; region: string }) {
  const model = (gpuQuotaModel(p.name) ?? p.name).toUpperCase();
  return (
    <li className="ne-cap-gpu" data-level="unknown" data-urgent="false">
      <div className="ne-between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div className="ne-cap-gpu-model">{model}</div>
          <div className="ne-faint ne-cap-wrap" style={{ fontSize: '0.75rem' }}>
            {p.humanName ?? p.name} · {region} · offered by the live API
          </div>
        </div>
        <Badge tone="neutral">no quota listed</Badge>
      </div>
      <div className="ne-cap-wrap" style={{ fontSize: '0.8125rem' }}>
        No GPU quota listed for {model} in {region}. The quota a run on it draws on is not documented; request it with the capacity request runbook before planning.
      </div>
      <div className="ne-mono ne-faint ne-cap-wrap" style={{ fontSize: 'var(--ne-fs-caption)' }}>
        {p.name} · {p.presets.filter(s => s.gpus > 0).map(s => s.name).join(', ')}
      </div>
    </li>
  );
}

/** Whether the Kubernetes recipes can start their CPU (system) node groups in a region: the non-GPU vCPU quota (W1-P15). */
function K8sLine({ region, quotas, project, name, urgent }: { region: string; quotas: QuotaAllowanceView[]; project?: string; name: ProjectNamer; urgent: boolean }) {
  const k = k8sRecipeUsability(region, quotas, project);
  const by = k.by === 'project' ? `${k.projectId ? name(k.projectId) : 'project'} cap` : 'tenant';
  const capped = k.projectsBlocked.length ? ` Capped at 0 for ${k.projectsBlocked.map(name).join(', ')}.` : '';
  const text =
    k.state === 'yes'
      ? `${fmtNumber((k.limit ?? 0) - (k.usage ?? 0))} of ${fmtNumber(k.limit ?? 0)} non-GPU vCPUs free (${by}) for their CPU node groups.`
      : k.state === 'full'
        ? `${fmtNumber(k.usage ?? 0)} of ${fmtNumber(k.limit ?? 0)} non-GPU vCPUs in use (${by}): no room for another CPU node group.`
        : k.state === 'cpu-blocked'
          ? `Non-GPU vCPU limit 0 (${by}): the recipes\u2019 CPU node groups cannot start; only a GPU-only run (cpu_node_count = 0) can. Request quota (${QUOTA_REQUEST}).`
          : `No non-GPU vCPU allowance is listed in ${region}, so whether their CPU node groups fit is not known.`;
  const badge = { yes: ['ok', 'yes'], full: ['warn', 'full'], 'cpu-blocked': [urgent ? 'danger' : 'neutral', 'no CPU nodes'], unknown: ['neutral', 'unknown'] }[k.state] as ['ok' | 'warn' | 'danger' | 'neutral', string];
  return (
    <p className="ne-cap-k8s ne-cap-wrap">
      <span className="ne-label">Usable by K8s recipes:</span> <Badge tone={badge[0]}>{badge[1]}</Badge>
      <span className="ne-sr-only">.</span> {text}
      {capped}
    </p>
  );
}

/** A dotted quota id that breaks only after a dot (G2.14): "compute.instance.preemptible.count", never "…coun / t". */
export function QuotaId({ name }: { name: string }) {
  const parts = name.split('.');
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {p}
          {i < parts.length - 1 ? (
            <>
              .<wbr />
            </>
          ) : null}
        </Fragment>
      ))}
    </>
  );
}

/** The level pill; a limit 0 outside the estate's regions or in another service reads as a fact, not an alarm. */
function QuotaLevelBadge({ q, urgent }: { q: QuotaAllowanceView; urgent: boolean }) {
  const level = usageLevel(q);
  if (level === 'zero-limit' && !urgent) return <Badge tone="neutral">limit 0</Badge>;
  return <LevelBadge usage={q.usage} limit={q.limit} percent={q.usagePercent} allocation={q.allocation} />;
}

/** Usage against the limit in force: the allowance's own, or for a placeholder the tenant allowance it draws on. */
export function QuotaUsage({ q, label, unit }: { q: QuotaAllowanceView; label: string; unit?: string }) {
  const f = quotaFigures(q);
  if (!f.inherits) return <UsageCell usage={q.usage} limit={q.limit} percent={q.usagePercent} unit={unit ?? q.unit} label={label} />;
  return (
    <div className="ne-cap-usage">
      <div className="ne-between ne-cap-usage-figures">
        <span className="ne-num">
          {f.limit === null ? (
            <span className="ne-faint">tenant limit not read</span>
          ) : (
            <>
              tenant {fmtQuotaAmount(f.usage, q.unit)} / {fmtQuotaAmount(f.limit, q.unit)}
              {!/^bytes?$/i.test(q.unit ?? '') && (unit ?? unitLabel(q.unit)) ? <span className="ne-faint"> {unit ?? unitLabel(q.unit)}</span> : null}
            </>
          )}
        </span>
        <span className="ne-num" data-level="inherits">
          {f.percent === null ? 'uses tenant quota' : `${fmtNumber(f.percent, 1)} %`}
        </span>
      </div>
      {f.percent !== null ? <Meter percent={f.percent} tone="accent" label={label} /> : null}
      <span className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>
        No project allocation set; this project uses {fmtQuotaAmount(f.ownUsage, q.unit)} of the tenant quota.
      </span>
    </div>
  );
}

/** A quota list longer than this opens on "near limit or blocked only": hundreds of rows with headroom hide the few that matter. */
export const LONG_QUOTA_LIST = 50;

function OtherQuotas({ rows, name, title, caption, targets, countLimits }: { rows: QuotaAllowanceView[]; name: ProjectNamer; title: string; caption: string; targets?: Set<string>; countLimits?: boolean }) {
  const [q, setQ] = useState('');
  const [onlyNear, setOnlyNear] = useState(rows.length > LONG_QUOTA_LIST);
  const searchId = useId();
  const nearId = useId();
  // Near or at the limit, or a limit 0 that blocks the estate (isUrgentQuota); a limit 0 elsewhere is a fact, not a block.
  // A search covers every row (W1-P16): the near-limit filter would otherwise hide a match ("0 of 455").
  const searching = q.trim() !== '';
  const shown = rows.filter(r => matchesQuota(r, q, name(r.projectId)) && (searching || !onlyNear || isUrgentQuota(r, targets)));
  // The header's N (nearLimitText) counts the allowances with a limit; the list it is about says both when they differ
  // (F1.39). Project placeholders have no limit of their own by design: that list keeps its plain count.
  const withLimit = countLimits ? rows.filter(r => r.limit !== null).length : rows.length;
  // Folded: the tiles and checks above say what needs a look; the full list is reference (F1.13).
  return (
    <details className="ne-cap-fold">
      <summary>
        <h3 className="ne-cap-subhead">
          {title} <span className="ne-faint">({withLimit === rows.length ? rows.length : `${rows.length} · ${withLimit} with a limit`})</span>
        </h3>
        <span className="ne-faint ne-cap-fold-hint">every limit, with search and a near-limit filter</span>
      </summary>
      <div className="ne-between" style={{ margin: '8px 0' }}>
        <span className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>
          {shown.length === rows.length ? `${rows.length} shown` : `${shown.length} of ${rows.length} shown`}
          {searching && onlyNear ? ' (search covers every row)' : ''}
        </span>
        <div className="ne-row">
          <div className="ne-search ne-cap-search">
            <Icon name="search" size={14} />
            <label htmlFor={searchId} className="ne-sr-only">
              {`Search ${title.toLowerCase()}`}
            </label>
            <input id={searchId} className="ne-input" type="search" placeholder="Search name, region, project…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <label htmlFor={nearId} className="ne-row ne-cap-check">
            <input id={nearId} type="checkbox" checked={onlyNear} disabled={searching} onChange={e => setOnlyNear(e.target.checked)} />
            Near limit or blocked only
          </label>
        </div>
      </div>
      <DataTable<QuotaAllowanceView>
        caption={caption}
        compact
        rows={shown}
        rowKey={quotaKey}
        maxHeight={420}
        initialSort={{ key: 'use', dir: 'desc' }}
        empty={<EmptyState title={rows.length ? 'No quota matches' : 'No other quota allowances in these projects'}>{rows.length ? 'Clear the search or the near-limit filter.' : null}</EmptyState>}
        columns={[
          {
            key: 'name',
            header: 'Quota',
            sortValue: r => r.description ?? r.name,
            render: r => (
              <div>
                <div style={{ fontWeight: 600 }}>{r.description ?? r.name}</div>
                <div className="ne-mono ne-faint ne-cap-wrap" style={{ fontSize: 'var(--ne-fs-caption)' }}>{r.name}</div>
              </div>
            ),
          },
          { key: 'p', header: 'Scope', sortValue: r => (r.scope === 'tenant' ? '' : name(r.projectId)), render: r => (r.scope === 'tenant' ? <span>tenant</span> : <span title={r.projectId}>{name(r.projectId)}</span>) },
          { key: 'r', header: 'Region', sortValue: r => r.region ?? '', render: r => (r.region ? <Chip>{r.region}</Chip> : <span className="ne-faint">not regional</span>) },
          {
            key: 'use',
            header: 'Usage / limit',
            sortValue: r => (isUrgentQuota(r, targets) && r.limit === 0 ? 50 : r.usagePercent ?? -1),
            render: r => <QuotaUsage q={r} label={`${r.name} usage, ${name(r.projectId)}`} />,
          },
          // By urgency (G2.12): "low to high" puts at-limit and blocked rows first, never the level names A to Z.
          { key: 'lvl', header: 'Status', sortValue: r => urgencyRank(r), render: r => <QuotaLevelBadge q={r} urgent={isUrgentQuota(r, targets)} /> },
        ]}
      />
    </details>
  );
}

/** Capacity allowances: how much of a reservation (capacity block group) each project may use. */
export function CapacityAllowancesCard({
  metric,
  blockGroups,
  name,
  now,
  evidence,
}: {
  metric: CapacityResponse['capacityAllowances'];
  blockGroups: CapacityResponse['capacityBlockGroups'];
  name: ProjectNamer;
  now: Date;
  evidence?: ReservationEvidence;
}) {
  const groupName = (id?: string) => (id ? blockGroups.value?.find(g => g.id === id)?.name : undefined);
  // A block group the region filter hides is listed, in another region; one no list holds is said on the row and
  // explained on the Reservations card (F1.10).
  const outside = (id: string) => evidence?.elsewhere.find(g => g.id === id);
  const unlisted = (id: string) => blockGroups.value !== null && !blockGroups.value.some(g => g.id === id) && !outside(id);
  return (
    <Card title="Capacity allowances" icon="gpu" flush footer={<SourceLine metric={metric} now={now} extra="An allowance is a project's share of a reservation; it says nothing about capacity outside the reservation." />}>
      {metric.value === null ? (
        <div className="ne-card-body">
          <Unavailable what="Capacity allowances" metric={metric} />
        </div>
      ) : (
        <DataTable<CapacityAllowanceView>
          caption="Capacity allowances"
          compact
          rows={[...metric.value].sort(byUrgency)}
          rowKey={a => `${a.projectId}/${a.name}`}
          empty={<EmptyState title="No capacity allowances in these projects">The projects in scope draw on no reservation (capacity block group).</EmptyState>}
          columns={[
            { key: 'n', header: 'Allowance', render: a => <strong className="ne-cap-wrap">{a.name}</strong> },
            { key: 'p', header: 'Project', render: a => <span title={a.projectId}>{name(a.projectId)}</span> },
            {
              key: 'g',
              header: 'Reservation',
              render: a =>
                a.capacityBlockGroupId ? (
                  <span className="ne-cap-wrap">
                    {groupName(a.capacityBlockGroupId) ? <>{groupName(a.capacityBlockGroupId)} </> : null}
                    <span className="ne-mono ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>{a.capacityBlockGroupId}</span>
                    {unlisted(a.capacityBlockGroupId) ? (
                      <>
                        {' '}
                        <Badge tone="neutral">not in the reservation list</Badge>
                      </>
                    ) : null}
                    {outside(a.capacityBlockGroupId) ? (
                      <>
                        {' '}
                        <Badge tone="neutral">in {outside(a.capacityBlockGroupId)?.region ?? 'another region'}, outside the filter</Badge>
                      </>
                    ) : null}
                  </span>
                ) : (
                  <span className="ne-faint">no reservation named</span>
                ),
            },
            { key: 'u', header: 'Usage / limit', render: a => <UsageCell usage={a.usage} limit={a.limit} percent={a.usagePercent} unit={a.unit} label={`${a.name} allowance usage`} /> },
            { key: 's', header: 'State', render: a => (a.state ? <StatusPill state={prettyEnum(a.state) === 'active' ? 'ok' : 'unknown'} label={prettyEnum(a.state)} /> : <span className="ne-faint">not reported</span>) },
          ]}
        />
      )}
    </Card>
  );
}
