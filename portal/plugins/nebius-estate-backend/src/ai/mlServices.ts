import { AiServicesResponse, ObservedResource, serverlessListed } from '@internal/nebius-domain';
import { readTime, ScopedSnapshot } from '../views';

const LISTS = ['registry.registries', 'msp.mlflow'];
const TITLES: Record<string, string> = { 'registry.registries': 'Container registries', 'msp.mlflow': 'Managed MLflow clusters' };

const row = (r: ObservedResource, detail: string | undefined) => ({
  uid: r.uid,
  name: r.name,
  projectId: r.projectId,
  region: r.region,
  status: r.statusDetail ?? r.status,
  ...(detail ? { detail } : {}),
});

/**
 * Container registries and Managed MLflow clusters in the caller's scope (followup 20: R12 ml-services creates both),
 * each with its Explorer uid, as of their lists' own read time, and whether the lists answered.
 */
export function mlServices(snap: Pick<ScopedSnapshot, 'resources' | 'capabilities' | 'observedAt'>): AiServicesResponse['mlServices'] {
  const caps = snap.capabilities.filter(c => LISTS.includes(c.id));
  const bad = caps.filter(c => c.state !== 'ok' && c.state !== 'schema-drift');
  // A list with no capability record has not been read: "none" needs both lists' answers (followup 20).
  const unread = LISTS.filter(id => !caps.some(c => c.id === id));
  const note = !caps.length
    ? 'The registry and MLflow lists have not been read yet (Integrations).'
    : [...bad.map(c => `${c.title}: ${c.state.replace(/-/g, ' ')}${c.hint ? ` (${c.hint})` : ''}`), ...unread.map(id => `${TITLES[id]}: not read yet`)].join('; ') || undefined;
  const observedAt = readTime(snap, LISTS).observedAt;
  const listed = serverlessListed(caps);
  return {
    registries: snap.resources.filter(r => r.type === 'container-registry').map(r => row(r, r.spec.summary || undefined)),
    mlflow: snap.resources.filter(r => r.type === 'mlflow-cluster').map(r => row(r, r.spec.public === undefined ? undefined : r.spec.public ? 'public endpoint' : 'private endpoint')),
    ...(observedAt ? { observedAt } : {}),
    ...(note ? { note } : {}),
    listed: listed === 'all' && unread.length ? 'partial' : listed,
  };
}
