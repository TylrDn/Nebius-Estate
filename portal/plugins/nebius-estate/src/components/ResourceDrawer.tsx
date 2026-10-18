import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { RepoModel, ResourceDetail, ResourceView } from '@internal/nebius-domain';
import { lifecycleLabel, RESOURCE_TYPE_LABELS } from '@internal/nebius-domain';
import {
  Async,
  Badge,
  Callout,
  Chip,
  DataTable,
  Drawer,
  fmtAgo,
  fmtGib,
  fmtTime,
  KeyValue,
  StatusPill,
  useGet,
} from '../ui';
import { observedRow } from './observed';
import { attributionView, drawerStatus, keyFields, lookupPointer, RELATION_LABELS, relationLabels, ttlText } from '../pages/explorer/catalog';
import { TypeLabel } from '../pages/explorer/TypeGlyph';
import { OperateLinks } from '../logs/OperateLinks';


function DesiredVsObserved({ r, repo }: { r: ResourceView; repo?: RepoModel }) {
  if (!r.desiredStateLink || !repo) return null;
  const root = repo.liveRoots.find(x => x.path === r.desiredStateLink!.liveRoot);
  if (!root) return null;
  const rows: { key: string; desired: string; observed: string }[] = [];
  if (r.type === 'mk8s-node-group') {
    const gpu = (r.spec.gpus ?? 0) > 0;
    const desired = gpu ? root.sizing.gpu_node_count : root.sizing.cpu_node_count;
    const observed = r.spec.fixedNodeCount ?? (r.spec.autoscaling ? `${r.spec.autoscaling.min}–${r.spec.autoscaling.max} (autoscaling)` : undefined);
    rows.push({ key: gpu ? 'gpu_node_count' : 'cpu_node_count', desired: String(desired ?? 'stack default'), observed: String(observed ?? 'not reported') });
    if (gpu && root.sizing.gpu_preemptible !== undefined) rows.push({ key: 'gpu_preemptible', desired: String(root.sizing.gpu_preemptible), observed: r.spec.capacityType ?? 'unknown' });
  }
  if (r.type === 'compute-filesystem' && root.sizing.filestore_size_gib !== undefined) {
    rows.push({ key: 'filestore_size_gib', desired: String(root.sizing.filestore_size_gib), observed: String(r.spec.sizeGib ?? 'not reported') });
  }
  if (r.type === 'mk8s-cluster' && root.sizing.k8s_version !== undefined) {
    rows.push({ key: 'k8s_version', desired: String(root.sizing.k8s_version), observed: r.spec.k8sVersion ?? 'not reported' });
  }
  return (
    <section style={{ marginTop: 18 }}>
      <h3 className="ne-section-title">Repository desired state vs. this snapshot</h3>
      <p className="ne-muted" style={{ marginTop: 0, fontSize: 12.5 }}>
        Sizing from <code>{root.sizingFile}</code> (repository) next to what the connector observed. This is an inventory comparison, not drift
        detection: drift needs an authorized <code>terraform plan</code> (runbooks/drift.md).
      </p>
      {rows.length ? (
        <DataTable
          caption="Desired vs observed"
          compact
          rows={rows}
          rowKey={x => x.key}
          columns={[
            { key: 'k', header: 'Setting', render: x => <code>{x.key}</code> },
            { key: 'd', header: 'Repository', render: x => x.desired },
            { key: 'o', header: 'Observed', render: x => x.observed },
            { key: 's', header: '', render: x => (x.desired === x.observed ? <Badge tone="ok">same</Badge> : <Badge tone="warn">differs</Badge>) },
          ]}
        />
      ) : (
        <p className="ne-muted">No comparable sizing field for this resource type.</p>
      )}
    </section>
  );
}

/** Generic spec fields; type-specific ones (summary, public, defaults, refs) are in the key-field section. */
function SpecSection({ d }: { d: ResourceView }) {
  const typed = keyFields(d, () => undefined).map(([k]) => k);
  const rows = (
    [
      ['Platform', d.spec.platform],
      ['Preset', d.spec.preset],
      ['GPUs', d.spec.gpus],
      ['vCPUs', d.spec.vcpus],
      ['RAM', d.spec.ramGib !== undefined ? `${d.spec.ramGib} GiB` : undefined],
      ['Size', d.spec.sizeGib !== undefined && d.type !== 'disk-snapshot' ? fmtGib(d.spec.sizeGib) : undefined],
      ['Disk type', d.spec.diskType],
      ['Attachments', d.spec.attachments],
      ['Fixed node count', d.spec.fixedNodeCount],
      ['Autoscaling', d.spec.autoscaling ? `${d.spec.autoscaling.min}–${d.spec.autoscaling.max}` : undefined],
      ['Capacity type', d.spec.capacityType],
      ['Reservation policy', d.spec.reservationPolicy],
      ['Fabric', d.spec.fabric],
      ['Kubernetes', d.spec.k8sVersion],
      ['Public', d.spec.public === undefined || typed.some(k => /public|visibility/i.test(k)) ? undefined : d.spec.public ? 'yes' : 'no'],
    ] as [string, unknown][]
  )
    .filter(([k, v]) => v !== undefined && v !== null && v !== '' && !typed.includes(k))
    .map(([k, v]) => [k, String(v)] as [string, string]);
  if (!rows.length) return null;
  return (
    <>
      <h3 className="ne-section-title" style={{ marginTop: 16 }}>Specification</h3>
      <KeyValue items={rows} />
    </>
  );
}

function LookupSection({ d }: { d: ResourceView }) {
  const p = lookupPointer(d);
  return (
    <>
      <h3 className="ne-section-title" style={{ marginTop: 16 }}>Look it up outside the portal</h3>
      <KeyValue
        items={(
          [
            ['Console', <span key="c">{p.console} <span className="ne-faint">(no deep link: console URLs are not documented)</span></span>],
            p.rest ? ['REST (read-only)', <code key="r" className="ne-xcmd">{p.rest}</code>] : undefined,
            p.cli ? ['CLI (read-only)', <code key="l" className="ne-xcmd">{p.cli}</code>] : undefined,
            d.source.capability ? ['Listed by', <code key="cap">{d.source.capability}</code>] : undefined,
          ] as ([string, ReactNode] | undefined)[]
        ).filter((x): x is [string, ReactNode] => Boolean(x))}
      />
      {p.note ? <p className="ne-muted" style={{ fontSize: 12.5, margin: '6px 0 0' }}>{p.note}</p> : null}
    </>
  );
}

export function ResourceDrawer({
  uid,
  onClose,
  onNavigate,
  now,
  repo,
  resources,
}: {
  uid?: string;
  onClose: () => void;
  onNavigate: (uid: string) => void;
  now: Date;
  repo?: RepoModel;
  /** The explorer's resource list, used to name reference targets and label relations. */
  resources?: ResourceView[];
}) {
  const load = useGet<ResourceDetail>(uid ? `/resources/${encodeURIComponent(uid)}` : null);
  const r = load.data && load.data.uid === uid ? load.data : undefined;
  const index = useMemo(() => {
    const byProvider = new Map((resources ?? []).map(x => [x.providerId, x]));
    const byUid = new Map((resources ?? []).map(x => [x.uid, x]));
    return { byProvider, byUid };
  }, [resources]);
  const resolve = (providerId: string) => index.byProvider.get(providerId)?.name;
  const projectOf = (id?: string) => (id ? <span title={id}>{resolve(id) ?? id}</span> : <span className="ne-faint">no project</span>);
  return (
    <Drawer
      open={Boolean(uid)}
      onClose={onClose}
      title={r?.name ?? 'Resource'}
      subtitle={r?.providerId}
      badges={
        r ? (
          <>
            <Badge tone="accent">{RESOURCE_TYPE_LABELS[r.type]}</Badge>
            {lifecycleLabel(r.type, r.status) ? <StatusPill state={r.status} label={lifecycleLabel(r.type, r.status)} /> : null}
            {(() => {
              const v = attributionView(r, resolve);
              if (v.kind === 'attributed') return <Badge tone="info">attributed</Badge>;
              if (v.kind === 'default' || v.kind === 'managed') return <Chip title={v.title}>{v.chip}</Chip>;
              return v.kind === 'project' ? null : <Badge tone="warn">unattributed</Badge>;
            })()}
            {r.spec.public ? <Badge tone="info">public</Badge> : null}
            {r.ttl.state === 'expired' ? <Badge tone="danger">TTL expired</Badge> : null}
            {r.orphanReasons?.length ? <Badge tone="warn">orphan candidate</Badge> : null}
          </>
        ) : null
      }
    >
      <Async load={{ ...load, data: r }} rows={8}>
        {d => (
          <div className="ne-stack" style={{ gap: 4 }}>
            {d.type === 'secret' ? (
              <Callout tone="info" title="Metadata only">
                Name, labels and state from the secrets list. The portal never requests or stores secret payloads or versions.
              </Callout>
            ) : null}
            {d.orphanReasons?.length ? (
              <Callout tone="warn" title="Orphan candidate — review before any action">
                {d.orphanReasons.join('; ')}. The portal never deletes anything; follow runbooks/teardown.md.
              </Callout>
            ) : null}
            {d.orphanNote && !d.orphanReasons?.length ? (
              <Callout tone="info" title="Not an orphan candidate (yet)">
                {d.orphanNote}.
              </Callout>
            ) : null}
            {d.attribution.inheritedFrom ? (
              <Callout tone="info" title={`Attributed via ${d.attribution.inheritedFrom}`}>
                {/^(subnet|network) /.test(d.attribution.inheritedFrom)
                  ? `A pool with no nip-* labels of its own, assigned to this ${d.attribution.inheritedFrom.split(' ')[0]} (status.assignment); the missing stage, stack, owner, run and TTL come from its ${d.attribution.inheritedFrom}.`
                  : `Created by Managed Kubernetes for its cluster (a node, its disk or IP address, or a volume), so it lacks some nip-* labels; the missing stage, stack, owner, run and TTL come from its ${d.attribution.inheritedFrom}.`}
              </Callout>
            ) : null}
            {d.ttl.state === 'expired' ? (
              <Callout tone="danger" title={`TTL expired ${fmtAgo(d.ttl.expiresAt, now)}`}>
                <code>nip-ttl-expires = {d.ttl.expiresAt}</code>. A person deletes what is past its TTL (docs/cost.md); there is no reaper.
              </Callout>
            ) : null}
            <h3 className="ne-section-title" style={{ marginTop: 10 }}>Observed</h3>
            <KeyValue
              items={[
                ['Type', <TypeLabel key="t" type={d.type} />],
                ['Provider id', <code key="id">{d.providerId}</code>],
                ['Project', projectOf(d.projectId)],
                ['Region', d.region ?? <span key="r" className="ne-faint">not regional</span>],
                // A container has no lifecycle status; its API state, if any, is shown as such (F1.21).
                ['Status', drawerStatus(d)],
                ['Created', d.createdAt ? fmtTime(d.createdAt) : <span key="c" className="ne-faint">not reported by the API</span>],
                observedRow(d, now),
                ['Source', `${d.source.connector} · ${d.source.kind}${d.source.endpoint ? ` · ${d.source.endpoint}` : ''}`],
              ]}
            />
            {keyFields(d, resolve).length ? (
              <>
                <h3 className="ne-section-title" style={{ marginTop: 16 }}>{RESOURCE_TYPE_LABELS[d.type].replace(' (metadata only)', '')}: key fields</h3>
                <KeyValue items={keyFields(d, resolve)} />
              </>
            ) : null}
            <SpecSection d={d} />
            <h3 className="ne-section-title" style={{ marginTop: 16 }}>Ownership and labels</h3>
            <KeyValue
              items={[
                [
                  'Stage / stack',
                  (() => {
                    const v = attributionView(d, resolve);
                    return v.kind === 'attributed' ? v.text : <span key="u" className="ne-muted">{v.sentence}</span>;
                  })(),
                ],
                ['Owner', d.attribution.owner ?? <span key="o" className="ne-faint">no nip-owner label</span>],
                ['Run', d.attribution.run ?? <span key="r" className="ne-faint">no nip-run label</span>],
                ['TTL', ttlText(d.ttl)],
              ]}
            />
            {Object.keys(d.labels).length ? (
              <div className="ne-row" style={{ marginTop: 8 }}>
                {Object.entries(d.labels).map(([k, v]) => (
                  <Chip key={k}>
                    {k}={v}
                  </Chip>
                ))}
              </div>
            ) : null}
            <DesiredVsObserved r={d} repo={repo} />
            {d.related.length ? (
              <>
                <h3 className="ne-section-title" style={{ marginTop: 16 }}>Relationships (from explicit fields)</h3>
                <div className="ne-stack" style={{ gap: 4 }}>
                  {d.related.map(x => {
                    const other = index.byUid.get(x.uid) ?? { providerId: x.uid.replace(/^[^:]+:/, ''), refs: [] };
                    const rel = relationLabels(d, other);
                    return (
                      <button key={x.uid} type="button" className="ne-btn ne-btn-ghost ne-btn-sm ne-xrel" onClick={() => onNavigate(x.uid)}>
                        {rel.length ? <span className="ne-xrel-label">{rel.join(', ')}</span> : null}
                        <span className="ne-faint">{RESOURCE_TYPE_LABELS[x.type as keyof typeof RESOURCE_TYPE_LABELS] ?? x.type}</span> <span>{x.name}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}
            {d.refs.length ? (
              <div className="ne-faint" style={{ fontSize: 12, marginTop: 6 }}>
                References in this resource&apos;s data: {d.refs.map(x => `${RELATION_LABELS[x.relation].out} → ${resolve(x.target) ?? x.target}`).join(', ')}
              </div>
            ) : null}
            <LookupSection d={d} />
            <OperateLinks d={d} />
            {d.docs?.length || d.desiredStateLink ? (
              <>
                <h3 className="ne-section-title" style={{ marginTop: 16 }}>Repository</h3>
                <div className="ne-stack" style={{ gap: 4 }}>
                  {d.desiredStateLink ? (
                    <Link to={`/evidence?doc=${encodeURIComponent(d.desiredStateLink.sizingFile)}`}>
                      Live root <code>{d.desiredStateLink.liveRoot}</code> · {d.desiredStateLink.sizingFile}
                    </Link>
                  ) : null}
                  {d.docs?.map(x => (
                    <Link key={x.path} to={`/evidence?doc=${encodeURIComponent(x.path)}`}>
                      {x.title} · <span className="ne-mono">{x.path}</span>
                    </Link>
                  ))}
                </div>
              </>
            ) : null}
            {d.coverageNotes.length ? (
              <div style={{ marginTop: 14 }}>
                <Callout tone="info" title="Coverage notes">
                  {d.coverageNotes.join(' ')}
                </Callout>
              </div>
            ) : null}
          </div>
        )}
      </Async>
    </Drawer>
  );
}
