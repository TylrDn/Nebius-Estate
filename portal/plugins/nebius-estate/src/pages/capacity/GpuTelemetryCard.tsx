import type { CapacityResponse, GpuTelemetryView } from '@internal/nebius-domain';
import { utilisationTitle } from '@internal/nebius-domain';
import { Card, DataTable, EmptyState, fmtNumber, Meter } from '../../ui';
import { ProjectNamer, SourceLine, Unavailable } from './parts';

const vmName = (g: GpuTelemetryView) => g.instanceName ?? g.instanceId ?? g.node;
const key = (g: GpuTelemetryView) => `${g.projectId ?? ''}/${g.instanceId ?? g.node}/${g.gpu ?? ''}`;
const missing = <span className="ne-faint">not reported</span>;

/** Latest Nebius Monitoring sample per GPU: utilisation, memory, temperature, power, each with its source. */
export function GpuTelemetryCard({ metric, name, now }: { metric: CapacityResponse['gpuTelemetry']; name: ProjectNamer; now: Date }) {
  return (
    <Card title="GPU telemetry per GPU" icon="gpu" flush footer={<SourceLine metric={metric} now={now} />}>
      {metric.value === null ? (
        <div className="ne-card-body">
          <Unavailable what="GPU telemetry" metric={metric} />
        </div>
      ) : (
        <DataTable<GpuTelemetryView>
          caption="GPU telemetry per GPU"
          compact
          rows={metric.value}
          rowKey={key}
          initialSort={{ key: 'u', dir: 'desc' }}
          empty={
            <EmptyState title="No GPU VMs reporting in these projects" icon="gpu">
              Nebius Monitoring answered, but no GPU series exist for the projects in scope: no GPU VM is running, or none exports DCGM metrics.
            </EmptyState>
          }
          columns={[
            {
              key: 'vm',
              header: 'VM · GPU',
              sortValue: g => `${vmName(g)}/${g.gpu ?? ''}`,
              render: g => (
                <div>
                  <div style={{ fontWeight: 600 }} className="ne-cap-wrap">
                    {vmName(g)}
                    {g.gpu !== undefined ? <span className="ne-faint"> · GPU {g.gpu}</span> : null}
                  </div>
                  <div className="ne-faint ne-cap-wrap" style={{ fontSize: '0.75rem' }}>
                    {g.projectId ? name(g.projectId) : 'project not stated'}
                    {g.instanceName && g.instanceId ? <span className="ne-mono"> · {g.instanceId}</span> : null}
                  </div>
                </div>
              ),
            },
            {
              key: 'u',
              header: utilisationTitle('latest'),
              sortValue: g => g.utilPercent ?? -1,
              render: g =>
                g.utilPercent === undefined ? (
                  missing
                ) : (
                  <div className="ne-cap-usage">
                    <span className="ne-num">{fmtNumber(g.utilPercent, 1)} %</span>
                    <Meter percent={g.utilPercent} label={`GPU utilisation ${vmName(g)} GPU ${g.gpu ?? ''}`} />
                  </div>
                ),
            },
            {
              key: 'm',
              header: 'Memory used / total',
              sortValue: g => (g.memoryUsedMiB !== undefined && g.memoryTotalMiB ? g.memoryUsedMiB / g.memoryTotalMiB : -1),
              render: g =>
                g.memoryUsedMiB === undefined && g.memoryTotalMiB === undefined ? (
                  missing
                ) : (
                  <div className="ne-cap-usage">
                    <span className="ne-num">
                      {g.memoryUsedMiB !== undefined ? fmtNumber(g.memoryUsedMiB / 1024, 1) : '?'} / {g.memoryTotalMiB !== undefined ? fmtNumber(g.memoryTotalMiB / 1024, 1) : '?'} GiB
                    </span>
                    {g.memoryUsedMiB !== undefined && g.memoryTotalMiB ? <Meter percent={(g.memoryUsedMiB / g.memoryTotalMiB) * 100} tone="ok" label={`GPU memory used ${vmName(g)} GPU ${g.gpu ?? ''}`} /> : null}
                  </div>
                ),
            },
            { key: 't', header: 'Temp', align: 'right', sortValue: g => g.tempC ?? -1, render: g => (g.tempC === undefined ? missing : `${fmtNumber(g.tempC)} °C`) },
            { key: 'w', header: 'Power', align: 'right', sortValue: g => g.powerW ?? -1, render: g => (g.powerW === undefined ? missing : `${fmtNumber(g.powerW)} W`) },
            { key: 's', header: 'Source', render: g => <span className="ne-mono ne-faint ne-cap-wrap" style={{ fontSize: 'var(--ne-fs-caption)' }}>{g.source}</span> },
          ]}
        />
      )}
    </Card>
  );
}
