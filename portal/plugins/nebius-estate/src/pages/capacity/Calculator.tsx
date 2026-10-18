import { useMemo, useState } from 'react';
import type { Footprint, QuotaAllowanceView, RepoModel } from '@internal/nebius-domain';
import { inferenceFootprint, quotaNeeds, soperatorLabFootprint, trainingFootprint } from '@internal/nebius-domain';
import { Badge, Callout, Card, DataTable, Field, fmtGib, KeyValue } from '../../ui';
import { calculatorSizing, CountKey, footprintQuotaStatus, FootprintQuotaStatus, MAX_CALC_NODES, profileNodeCounts, quotaLineText, validateNodeCounts } from './helpers';
import { LivePriceCell, LivePriceNote, useLivePrices } from './LivePrice';

const KEYS: CountKey[] = ['min', 'expected', 'max'];

/** The three node-count inputs, with field-level messages (whole numbers, min ≤ expected ≤ max, clamped values). */
export function NodeCountFields({ raw, onChange }: { raw: Record<CountKey, string>; onChange: (k: CountKey, v: string) => void }) {
  const v = validateNodeCounts(raw);
  return (
    <>
      {KEYS.map(k => (
        <Field key={k} label={`${k} GPU nodes`} htmlFor={`fc-${k}`} error={v.errors[k]} hint={v.notes[k]}>
          <input
            id={`fc-${k}`}
            className="ne-input ne-num"
            style={{ width: 90 }}
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_CALC_NODES}
            step={1}
            aria-invalid={v.errors[k] ? 'true' : undefined}
            value={raw[k]}
            onChange={e => onChange(k, e.target.value)}
          />
        </Field>
      ))}
    </>
  );
}

const QUOTA_TONE = { ok: 'ok', blocked: 'danger', exceeded: 'danger', 'not-checked': 'neutral' } as const;

/** One footprint's quota check (tenant allowances of the calculator's region), the same check as Overview and Provisioning. */
export function QuotaNeedCell({ s, region }: { s: FootprintQuotaStatus; region: string }) {
  const bad = s.lines.filter(l => l.state !== 'ok');
  return (
    <div>
      <Badge tone={QUOTA_TONE[s.state]}>{s.state === 'not-checked' ? 'not checked' : s.state === 'ok' ? 'fits' : s.state}</Badge>
      {s.state === 'not-checked' ? <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>No tenant allowance read for {region}</div> : null}
      {bad.map(l => (
        <div key={l.quota} className="ne-faint ne-cap-wrap" style={{ fontSize: 'var(--ne-fs-caption)' }}>
          <span className="ne-mono">{l.quota}</span> {quotaLineText(l, region)}
        </div>
      ))}
    </div>
  );
}

/**
 * Minimum / expected / maximum footprints of a stack, their quota needs checked against the tenant allowances
 * of the chosen region (checkPlannedFootprint, as on Overview), and their live price.
 */
export function FootprintCalculator({
  repo,
  quotas,
  defaultRegion,
  name,
}: {
  repo: RepoModel;
  /** Quota allowances in scope (GET /capacity); null when they could not be read. */
  quotas: QuotaAllowanceView[] | null | undefined;
  defaultRegion?: string;
  name?: (projectId: string) => string;
}) {
  const [stack, setStack] = useState<'inference' | 'training' | 'soperator'>('training');
  const [stage, setStage] = useState('sandbox');
  const regions = Object.keys(repo.regions.regions);
  const [region, setRegion] = useState(defaultRegion && repo.regions.regions[defaultRegion] ? defaultRegion : regions.includes('eu-north1') ? 'eu-north1' : regions[0]);
  const [raw, setRaw] = useState<Record<CountKey, string>>({ min: '0', expected: '2', max: '4' });
  const [profileName, setProfileName] = useState('');
  const root = repo.liveRoots.find(r => r.stage === stage && r.stack === stack);
  // Run profiles of this stack and stage (G2.3): the shape a `make plan PROFILE=<name>` run actually applies.
  const profiles = stack === 'soperator' ? [] : root?.runProfiles ?? [];
  const chosen = calculatorSizing(root, stack, profiles.some(p => p.name === profileName) ? profileName : undefined, repo.regions, region);
  const pickProfile = (next: string) => {
    setProfileName(next);
    const p = profiles.find(x => x.name === next);
    if (!p) return;
    if (repo.regions.regions[p.region]) setRegion(p.region);
    const n = p.vars.gpu_node_count;
    // A profile plans a fixed node count (#27): max is that count, never the previous max above it.
    if (typeof n === 'number') setRaw(r => profileNodeCounts(r, n));
  };
  const policy = repo.stages.stages[stage]?.policy;
  const cap = stack === 'soperator' ? 0 : policy?.max_gpu_nodes[stack];
  const valid = validateNodeCounts(raw);
  // Soperator's lab profile has no GPU nodes: its footprint does not depend on the counts.
  const counts = stack === 'soperator' ? { min: 0, expected: 0, max: 0 } : valid.counts;
  const invalid = counts ? undefined : 'Fix the node counts above to price the footprints.';

  const rows = useMemo(() => {
    if (!counts) return [];
    const ctx = { regions: repo.regions, region };
    const sizing = chosen.sizing;
    return KEYS.map(k => {
      let fp: Footprint;
      if (stack === 'inference') fp = inferenceFootprint(sizing, ctx, counts[k]);
      else if (stack === 'training') fp = trainingFootprint(sizing, ctx, counts[k]);
      else fp = soperatorLabFootprint(stage);
      return {
        k,
        fp,
        q: quotaNeeds(fp, { gpuCluster: stack === 'training' }),
        quota: footprintQuotaStatus(fp, stack, sizing, region, quotas),
        over: cap !== undefined && stack !== 'soperator' && counts[k] > cap,
      };
    });
    // counts is derived from raw on every render; key on its values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, stack, stage, region, counts?.min, counts?.expected, counts?.max, root, cap, quotas, chosen.profile?.name]);

  const priced = useMemo(() => rows.map(r => ({ k: r.k, fp: r.fp })), [rows]);
  const capacityType = stack === 'soperator' ? undefined : chosen.capacityType;
  const prices = useLivePrices(priced, region, invalid, capacityType);
  const gpuPlatform = stack === 'soperator' ? undefined : chosen.gpuPlatform;
  const defaultGpu = repo.regions.regions[region]?.default;
  return (
    <Card
      title="Footprint calculator (minimum / expected / maximum)"
      icon="gpu"
      footer="Assumptions: shapes from the live root's sizing file (with the chosen run profile's vars over it) and platform/regions.yaml; CPU nodes cpu-d3 with 128 GiB boot disks; Prometheus TSDB 25 GiB (docs/capacity.md). The quota check uses the tenant allowances of the chosen region, as the Overview does; a quota does not guarantee physical GPUs, and no reservation terms are implied."
    >
      <div className="ne-row" style={{ alignItems: 'flex-start', marginBottom: 14 }}>
        <Field label="Stack" htmlFor="fc-stack">
          <select id="fc-stack" className="ne-select" value={stack} onChange={e => setStack(e.target.value as typeof stack)}>
            <option value="inference">inference (R1)</option>
            <option value="training">training (R3)</option>
            <option value="soperator">soperator lab (R4)</option>
          </select>
        </Field>
        <Field label="Stage" htmlFor="fc-stage">
          <select id="fc-stage" className="ne-select" value={stage} onChange={e => setStage(e.target.value)}>
            {Object.keys(repo.stages.stages).map(s => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        {profiles.length ? (
          <Field label="Run profile" htmlFor="fc-profile" hint={chosen.profile ? `platform/profiles/${stack}/${chosen.profile.name}.json` : 'the sizing file alone'}>
            <select id="fc-profile" className="ne-select" value={chosen.profile?.name ?? ''} onChange={e => pickProfile(e.target.value)}>
              <option value="">none (sizing file)</option>
              {profiles.map(p => (
                <option key={p.name} value={p.name}>
                  {p.name} ({p.region})
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Region" htmlFor="fc-region" hint={defaultGpu ? `default GPU: ${defaultGpu}` : 'no default GPU platform listed'}>
          <select id="fc-region" className="ne-select" value={region} onChange={e => setRegion(e.target.value)}>
            {regions.map(r => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
        {stack !== 'soperator' ? <NodeCountFields raw={raw} onChange={(k, v) => setRaw(r => ({ ...r, [k]: v }))} /> : null}
      </div>
      {rows.some(r => r.over) ? (
        <div style={{ marginBottom: 10 }}>
          <Callout tone="danger" title={`Above the ${stage} cap of ${cap} ${stack} GPU nodes`}>
            platform/stages.yaml would make that plan fail. Raising a cap is a policy change (docs/capacity.md).
          </Callout>
        </div>
      ) : null}
      <DataTable
        caption="Footprint quota needs"
        compact
        rows={rows}
        rowKey={r => r.k}
        empty={<div className="ne-state"><div className="ne-state-title">No footprint yet</div><div>Fix the node counts above.</div></div>}
        columns={[
          { key: 'k', header: 'Footprint', render: r => <strong>{r.k}</strong> },
          { key: 'g', header: 'GPUs', align: 'right', render: r => (r.over ? <span style={{ color: 'var(--ne-danger)' }}>{r.q.gpus}</span> : r.q.gpus) },
          { key: 'vm', header: 'GPU VMs', align: 'right', render: r => r.q.gpuVms },
          { key: 'v', header: 'Non-GPU vCPU', align: 'right', render: r => r.q.nonGpuVcpus },
          { key: 'ssd', header: 'Network SSD', align: 'right', render: r => fmtGib(r.q.networkSsdGib) },
          { key: 'io', header: 'IO_M3', align: 'right', render: r => fmtGib(r.q.ioM3Gib) },
          { key: 'fs', header: 'Filesystems', align: 'right', render: r => fmtGib(r.q.filesystemGib) },
          { key: 'gc', header: 'GPU clusters', align: 'right', render: r => r.q.gpuClusters },
          { key: 'ip', header: 'Public IPs', align: 'right', render: r => r.q.publicIps },
          { key: 'qc', header: `Quota in ${region}`, render: r => <QuotaNeedCell s={r.quota} region={region} /> },
          { key: 'lp', header: 'Live price / h', align: 'right', render: r => <LivePriceCell prices={prices} k={r.k} /> },
        ]}
      />
      <LivePriceNote prices={prices} keys={rows.map(r => r.k)} name={name} />
      <div style={{ marginTop: 12 }}>
        <KeyValue
          items={[
            ['Sizing file', root ? <code key="f">{root.sizingFile}</code> : 'none for this stage/stack'],
            ...(chosen.profile ? [['Run profile', <span key="p"><code>{`platform/profiles/${stack}/${chosen.profile.name}.json`}</code> (its vars over the sizing file)</span>] as [string, JSX.Element]] : []),
            ...(gpuPlatform ? [['GPU platform', <span key="g"><code>{gpuPlatform}</code>{capacityType === 'preemptible' ? ', preemptible (priced and quota-checked as preemptible; system nodes on-demand)' : ', on-demand'}</span>] as [string, JSX.Element]] : []),
            ['Capacity choice', stack === 'training' && policy?.require_strict_reservation.training ? 'STRICT reservation required when GPU nodes > 0 (stage policy)' : 'on-demand, reserved (AUTO/STRICT) or preemptible where the stage allows it'],
          ]}
        />
      </div>
    </Card>
  );
}
