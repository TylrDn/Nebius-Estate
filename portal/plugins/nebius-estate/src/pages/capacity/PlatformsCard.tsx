import { useMemo } from 'react';
import type { CapacityResponse, RegionsFile } from '@internal/nebius-domain';
import { Badge, Callout, Card, DataTable, EmptyState, StatusPill } from '../../ui';
import { comparePlatforms, PlatformCheck, PlatformRow, projectRegions, unplacedPlatforms } from './helpers';
import { ProjectNamer, SourceLine, Unavailable } from './parts';

const CHECK: Record<PlatformCheck, { state: string; label: string; title: string; action: string }> = {
  match: { state: 'ok', label: 'matches', title: 'Offered by the live API with the presets regions.yaml names.', action: 'Nothing to do.' },
  'preset-mismatch': {
    state: 'near', label: 'preset mismatch', title: 'The platform is offered, but a preset regions.yaml names is not.',
    action: 'A root that uses the missing preset fails at plan time; update the preset in platform/regions.yaml.',
  },
  'missing-live': {
    state: 'over', label: 'not offered live', title: 'regions.yaml lists it, but no project in this region sees it in the live API.',
    action: 'Check the region and quotas before planning a root with this platform; remove or annotate it in platform/regions.yaml.',
  },
  'not-in-yaml': {
    state: 'near', label: 'not in regions.yaml', title: 'Offered by the live API, but platform/regions.yaml does not list it for this region.',
    action: 'Nothing breaks: the stacks cannot select it until it is added to platform/regions.yaml (with its presets and fabric).',
  },
  'not-checked': {
    state: 'unknown', label: 'not checked', title: 'No project in scope is known to be in this region, so the live API cannot be compared here.',
    action: 'List a project in this region to compare it.',
  },
};

const LEGEND_ID = 'platform-check-legend';

/** GPU platforms and presets offered by the live compute API, next to platform/regions.yaml, with a mismatch indicator. */
export function PlatformsCard({
  metric,
  yaml,
  yamlError,
  cap,
  region,
  name,
  now,
}: {
  metric: CapacityResponse['platforms'];
  yaml?: RegionsFile;
  yamlError?: string;
  cap: CapacityResponse;
  region?: string;
  name: ProjectNamer;
  now: Date;
}) {
  const projRegions = useMemo(() => projectRegions(cap.quotas.value, cap.nodeGroups), [cap.quotas.value, cap.nodeGroups]);
  const rows = useMemo(() => (metric.value && yaml ? comparePlatforms(metric.value, yaml, projRegions, region) : []), [metric.value, yaml, projRegions, region]);
  const unplaced = metric.value ? unplacedPlatforms(metric.value, projRegions) : [];
  const mismatches = rows.filter(r => r.check !== 'match' && r.check !== 'not-checked').length;
  return (
    <Card
      title="Platforms & presets: live API vs. regions.yaml"
      icon="gpu"
      flush
      actions={metric.value && yaml ? <Badge tone={mismatches ? 'warn' : 'ok'}>{mismatches ? `${mismatches} mismatch${mismatches > 1 ? 'es' : ''}` : 'no mismatch'}</Badge> : undefined}
      footer={
        <SourceLine
          metric={metric}
          now={now}
          extra="The live list is read per project; a project's region comes from its quotas and node groups. regions.yaml is what the Terraform roots consume."
        />
      }
    >
      {metric.value === null ? (
        <div className="ne-card-body">
          <Unavailable what="Live platforms" metric={metric} />
        </div>
      ) : !yaml ? (
        <div className="ne-card-body">
          <Callout tone="warn" title="platform/regions.yaml could not be read">
            {yamlError ?? 'Loading the repository model…'} The live list cannot be compared until it loads.
          </Callout>
        </div>
      ) : (
        <>
          {unplaced.length ? (
            <div className="ne-card-body" style={{ paddingBottom: 0 }}>
              <Callout tone="info" title="Some projects have no known region">
                {unplaced.map(u => `${u.platform} (${u.projects.map(name).join(', ')})`).join('; ')}: offered live, but with no quota or node group to place the project in a region, they are not compared.
              </Callout>
            </div>
          ) : null}
          <DataTable<PlatformRow>
            caption="GPU platforms: live API vs. regions.yaml"
            compact
            rows={rows}
            rowKey={r => r.key}
            initialSort={{ key: 'r', dir: 'asc' }}
            empty={<EmptyState title="No GPU platforms for this selection">Neither regions.yaml nor the live API lists a GPU platform{region ? ` in ${region}` : ''}.</EmptyState>}
            columns={[
              { key: 'r', header: 'Region', sortValue: r => `${r.region}/${r.platform}`, render: r => <span className="ne-mono">{r.region}</span> },
              {
                key: 'p',
                header: 'Platform',
                sortValue: r => r.platform,
                render: r => (
                  <div>
                    <span className="ne-mono">
                      {r.platform}
                      {r.isDefault ? ' (default)' : ''}
                    </span>
                    {r.humanName ? <div className="ne-faint" style={{ fontSize: '0.75rem' }}>{r.humanName}</div> : null}
                  </div>
                ),
              },
              { key: 'y', header: 'regions.yaml presets', render: r => (r.inYaml ? <PresetList presets={r.yamlPresets} missing={r.missingPresets} /> : <span className="ne-faint">not listed</span>) },
              { key: 'l', header: 'Live GPU presets', render: r => (r.livePresets.length ? <PresetList presets={r.livePresets} /> : <span className="ne-faint">{r.check === 'not-checked' ? 'no project here' : 'not offered'}</span>) },
              { key: 'pr', header: 'Seen in', render: r => (r.projects.length ? <span className="ne-cap-wrap" title={r.projects.join(', ')}>{r.projects.map(name).join(', ')}</span> : <span className="ne-faint">no project in this region</span>) },
              {
                key: 'c',
                header: 'Check',
                sortValue: r => r.check,
                render: r => (
                  <a href={`#${LEGEND_ID}`} title={CHECK[r.check].title} aria-label={`${CHECK[r.check].label}: what this means`} className="ne-cap-check-link">
                    <StatusPill state={CHECK[r.check].state} label={CHECK[r.check].label} />
                  </a>
                ),
              },
            ]}
          />
          <dl id={LEGEND_ID} className="ne-card-body ne-kv" style={{ margin: 0 }} tabIndex={-1}>
            {(Object.keys(CHECK) as PlatformCheck[])
              .filter(k => k === 'match' || rows.some(row => row.check === k))
              .map(k => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>
                    <StatusPill state={CHECK[k].state} label={CHECK[k].label} />
                  </dt>
                  <dd>
                    {CHECK[k].title} {CHECK[k].action}
                  </dd>
                </div>
              ))}
          </dl>
        </>
      )}
    </Card>
  );
}

function PresetList({ presets, missing = [], none = 'none' }: { presets: string[]; missing?: string[]; none?: string }) {
  if (!presets.length) return <span className="ne-faint">{none}</span>;
  return (
    <ul className="ne-cap-presets">
      {presets.map(p => (
        <li key={p} className="ne-mono">
          {p}
          {missing.includes(p) ? <span className="ne-cap-missing"> (not offered live)</span> : null}
        </li>
      ))}
    </ul>
  );
}
