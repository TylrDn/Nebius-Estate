import { createHash } from 'crypto';

type Json = Record<string, any>;

/**
 * A Managed Kubernetes cluster as the MK8s API reports it (`GET /mk8s/v1/clusters?parentId=<project>`):
 * the control-plane endpoints (`status.controlPlane.endpoints.publicEndpoint` / `privateEndpoint`)
 * and the cluster CA (`status.controlPlane.auth.clusterCaCertificate`). Verified live 2026-10-11:
 * the portal's own Nebius IAM token is accepted as the Kubernetes bearer token (read-only,
 * `nebius:viewer`), so a recreated cluster needs no hand-maintained endpoint, CA or token.
 */
export interface DiscoveredCluster {
  id: string;
  name: string;
  projectId: string;
  region?: string;
  /** RUNNING, PROVISIONING, DELETING, … (upper case, as the API reports it). */
  state: string;
  publicEndpoint?: string;
  privateEndpoint?: string;
  /** PEM, kept in memory only; never sent to the browser or logged. */
  caPem?: string;
}

const pick = (o: Json | undefined, ...keys: string[]) => {
  for (const k of keys) if (o?.[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};

export function discoveredCluster(item: Json, projectId: string, region?: string): DiscoveredCluster | undefined {
  const id = item?.metadata?.id;
  if (typeof id !== 'string' || !id) return undefined;
  const cp = pick(item.status, 'controlPlane', 'control_plane') ?? {};
  const endpoints = pick(cp, 'endpoints') ?? {};
  const auth = pick(cp, 'auth') ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return {
    id,
    name: str(item.metadata.name) ?? id,
    projectId,
    region,
    state: String(pick(item.status, 'state') ?? 'STATE_UNSPECIFIED').toUpperCase(),
    publicEndpoint: str(pick(endpoints, 'publicEndpoint', 'public_endpoint')),
    privateEndpoint: str(pick(endpoints, 'privateEndpoint', 'private_endpoint')),
    caPem: str(pick(auth, 'clusterCaCertificate', 'cluster_ca_certificate')),
  };
}

/** Control-plane hosts look like `pu.mk8scluster-<id>.mk8s.<region>.nebius.cloud`. */
const MK8S_HOST = /^(?:[a-z0-9-]+\.)+mk8s\.([a-z0-9-]+)\.nebius\.cloud$/;

/**
 * The origin to call for a discovered endpoint, or why it is refused. Only https on 443 under
 * `*.mk8s.<region>.nebius.cloud` (and, when the project's region is known, that region): the
 * allowlist is derived from discovery, never from a request.
 */
export function mk8sOrigin(endpoint: string | undefined, region?: string): { origin: string } | { refused: string } {
  if (!endpoint) return { refused: 'the MK8s API reported no endpoint of the selected kind' };
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return { refused: 'the reported endpoint is not a URL' };
  }
  if (u.protocol !== 'https:') return { refused: 'the reported endpoint is not https' };
  if (u.username || u.password) return { refused: 'the reported endpoint carries credentials' };
  if (u.port && u.port !== '443') return { refused: `the reported endpoint uses port ${u.port}, not 443` };
  if (u.pathname !== '/' || u.search || u.hash) return { refused: 'the reported endpoint has a path or query' };
  const m = MK8S_HOST.exec(u.hostname);
  if (!m) return { refused: `${u.hostname} is not under *.mk8s.<region>.nebius.cloud` };
  if (region && m[1] !== region) return { refused: `${u.hostname} is not in the project's region ${region}` };
  return { origin: u.origin };
}

/** Short, stable fingerprint of a CA bundle (to notice a rotated CA). */
export function caFingerprint(pem: string | undefined): string | undefined {
  return pem ? createHash('sha256').update(pem.trim()).digest('hex').slice(0, 16) : undefined;
}

/** Plain-language reason for a cluster that is not connected because of its state. */
export function clusterStateNote(state: string): string {
  if (state === 'PROVISIONING') return 'Cluster is PROVISIONING; it is connected automatically once RUNNING.';
  if (state === 'DELETING') return 'Cluster is DELETING; not connected.';
  return `Cluster state ${state}; connected only when RUNNING.`;
}
