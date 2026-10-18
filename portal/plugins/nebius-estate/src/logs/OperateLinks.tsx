import { Link } from 'react-router-dom';
import type { ResourceDetail } from '@internal/nebius-domain';

const enc = encodeURIComponent;

/** Deep links from a resource in the Explorer to its logs, GPU history and alerts (Fleet, Alerts and Logs pages). */
export function OperateLinks({ d }: { d: Pick<ResourceDetail, 'type' | 'providerId' | 'projectId' | 'spec'> }) {
  const project = d.projectId ? `project=${enc(d.projectId)}&` : '';
  const links: { to: string; label: string }[] = [];
  if (d.type === 'compute-instance') {
    links.push({ to: `/logs?${project}bucket=sp_serial&resource=${enc(d.providerId)}`, label: 'Serial-console logs' });
    if (d.spec.gpus) links.push({ to: `/fleet?${project}focus=${enc(d.providerId)}`, label: 'GPU history on Fleet' });
  }
  if (d.type === 'mk8s-cluster') links.push({ to: `/logs?${project}bucket=sp_mk8s_control_plane&resource=${enc(d.providerId)}`, label: 'Control-plane logs' });
  if (d.type === 'postgresql-cluster') links.push({ to: `/logs?${project}bucket=sp_postgres`, label: 'PostgreSQL logs' });
  if (d.type === 'mlflow-cluster') links.push({ to: `/logs?${project}bucket=sp_mlflow`, label: 'MLflow logs' });
  if (!links.length) return null;
  links.push({ to: `/alerts${d.projectId ? `?project=${enc(d.projectId)}` : ''}`, label: 'Alerts in this project' });
  return (
    <>
      <h3 className="ne-section-title" style={{ marginTop: 16 }}>Operate</h3>
      <div className="ne-stack" style={{ gap: 4 }}>
        {links.map(l => (
          <Link key={l.to} to={l.to}>
            {l.label}
          </Link>
        ))}
      </div>
    </>
  );
}
