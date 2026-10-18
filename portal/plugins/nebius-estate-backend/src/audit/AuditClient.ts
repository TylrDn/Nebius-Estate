import { AuditEvent, CapabilityState, CapabilityStatus, ConnectorStatus } from '@internal/nebius-domain';
import { HttpClient, mapLimit, redact } from '../lib/http';
import { classify, worst } from '../inventory/contract';
import { hintFor } from '../inventory/nebius';
import { SyncExtension } from '../inventory/extension';

export { NEBIUS_AUDIT } from '../inventory/endpoints';
export const AUDIT_CONNECTOR = 'nebius-audit';
export const AUDIT_SOURCE = 'Nebius Audit Logs (audit events API)';
export const AUDIT_PATH = '/audit/v2/audit-events';
export const AUDIT_GRANT = '`auditlogs.audit-event-viewer` on the tenant for the portal’s group (docs/credentials.md)';

type Json = Record<string, any>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);

/**
 * One audit event, reduced to who, action, resource, time and result. The event also carries the
 * caller's masked token, client IP, user agent, TLS fingerprint, request parameters and response
 * payload; none of it is copied.
 */
export function mapAuditEvent(e: Json): AuditEvent {
  const subject = (e.authentication?.subject ?? {}) as Json;
  const sa = str(subject.serviceAccountId ?? subject.service_account_id);
  const user = str(subject.tenantUserId ?? subject.tenant_user_id);
  const md = (e.resource?.metadata ?? {}) as Json;
  // A failed call: response.status (gRPC status); an operation: response.payload.status (live shape 2026-10-11).
  const st = (e.response?.status ?? e.response?.payload?.status ?? {}) as Json;
  const code = typeof st.code === 'number' ? st.code : undefined;
  // The documented shape (audit-logs/events/reference): response.status_code, a gRPC code name, and
  // response.error_message, which may be empty on a failure (#37).
  const named = str(e.response?.status_code ?? e.response?.statusCode);
  const message = str(e.response?.error_message ?? e.response?.errorMessage);
  const failure = code && code !== 0 ? String(st.message ?? `code ${code}`) : named && named !== 'OK' ? (message ? `${message} (${named})` : named) : undefined;
  return {
    id: String(e.id ?? ''),
    time: String(e.time ?? ''),
    service: String(e.service?.name ?? ''),
    action: String(e.action ?? ''),
    type: String(e.type ?? ''),
    who: { kind: sa ? 'service-account' : user ? 'user' : 'unknown', id: sa ?? user, name: str(subject.name) },
    resource: { type: str(md.type), id: str(md.id), name: str(md.name) },
    authorized: typeof e.authorization?.authorized === 'boolean' ? e.authorization.authorized : undefined,
    status: String(e.status ?? ''),
    error: failure ? redact(failure).slice(0, 200) : undefined,
  };
}

/** GET only. parentId (the tenant), region, start and end are all required by the API. */
export class AuditClient {
  constructor(private readonly http: HttpClient, private readonly base: string) {}

  /** One page of events in [start, end), newest first as the API returns them; `filter`: the API's query expression. */
  async list(tenant: string, region: string, start: string, end: string, pageSize: number, pageToken?: string, filter?: string): Promise<{ events: AuditEvent[]; nextPageToken?: string }> {
    const params = new URLSearchParams({ parentId: tenant, region, start, end, pageSize: String(pageSize) });
    if (pageToken) params.set('pageToken', pageToken);
    if (filter) params.set('filter', filter);
    const res = await this.http.request<Json>(`${this.base}${AUDIT_PATH}?${params.toString()}`);
    if (!res || (res.items !== undefined && !Array.isArray(res.items))) throw new Error('unexpected audit events response: no items list');
    return { events: ((res.items ?? []) as Json[]).map(mapAuditEvent), nextPageToken: str(res.nextPageToken ?? res.next_page_token) };
  }
}

/**
 * The audit connector on the inventory's sync loop: one single-event page per region of the listed
 * projects shows whether the identity may read the tenant's audit events (Integrations, health).
 * Events themselves are read on demand from the Logs page, never stored.
 */
/**
 * Why audit events cannot be read while the Nebius connector is set up: the tenant or the regions of the listed
 * projects are not known. Advises only on the input that is missing; the same text on Logs and on Integrations.
 * `synced`: whether the inventory has finished a sync (before that, nothing has failed yet).
 */
export function auditInputsGap(have: { tenant: boolean; regions: boolean; synced: boolean }): string {
  const missing = [!have.tenant && 'the tenant', !have.regions && 'the regions of the listed projects'].filter(Boolean).join(' and ');
  const subject = `${missing.charAt(0).toUpperCase()}${missing.slice(1)}`;
  if (!have.synced) return `${subject} ${have.tenant || have.regions ? 'is' : 'are'} not read yet: the first inventory sync has not finished.`;
  const advice = [
    !have.tenant && 'Set NEBIUS_TENANT_ID (nebius.tenantId) so the tenant does not depend on a project read.',
    !have.regions && 'Give each project its `regions` in nebius.projects so the regions do not depend on a project read.',
  ].filter(Boolean).join(' ');
  return `${subject} could not be read: the project reads failed at the last sync (see Nebius inventory on Integrations). ${advice}`;
}

export class AuditExtension implements SyncExtension {
  constructor(
    private readonly d: {
      client: () => AuditClient | undefined;
      /** The tenant, from config or the listed projects' parent. */
      tenant: () => string | undefined;
      /** Regions of the listed projects, once the inventory has read them. */
      regions: () => string[];
      /** Resolves when this sync's project list is read (InventoryService.inventorySettled). */
      settled?: () => Promise<void>;
      maxConcurrency: number;
      syncIntervalMinutes: number;
      now?: () => Date;
    },
  ) {}

  definitions(): ConnectorStatus[] {
    const configured = Boolean(this.d.client());
    return [
      {
        id: AUDIT_CONNECTOR,
        title: 'Audit events (Nebius Audit Logs)',
        state: configured ? 'starting' : 'not-configured',
        scope: 'tenant, per region of the listed projects',
        permissions: 'auditlogs.audit-event-viewer on the tenant',
        services: ['every service Audit Logs supports (docs.nebius.com/audit-logs/services)'],
        staleAfterMinutes: this.d.syncIntervalMinutes * 3,
        missingCoverage: ['Events are read on demand on the Logs page, one region at a time; nothing is stored or alerted on'],
        setup: 'docs/credentials.md',
      },
    ];
  }

  async sync(attempt: string, only?: string) {
    if (only && only !== AUDIT_CONNECTOR) return { statuses: [], capabilities: [] };
    const base = {
      id: 'audit.events.list', title: 'Audit events (tenant, per region)', service: 'audit', connector: AUDIT_CONNECTOR as CapabilityStatus['connector'], scope: 'tenant' as const,
      path: AUDIT_PATH, method: 'GET' as const, verified: '2026-10-11',
    };
    const client = this.d.client();
    const notConfigured = (hint: string) => ({
      statuses: [{ id: AUDIT_CONNECTOR, state: 'not-configured' as const, error: hint }],
      capabilities: [{ ...base, state: 'not-configured' as const, lastAttempt: attempt, hint }],
    });
    if (!client) return notConfigured('Needs the Nebius connector: listed projects and a read-only identity (docs/portal/nebius-setup.md).');
    await this.d.settled?.();
    const tenant = this.d.tenant();
    const regions = this.d.regions();
    if (!tenant || !regions.length) {
      // Configured (projects and an identity), but the project reads that name the tenant or the regions failed:
      // a failure to fix, not a setting to add (F1.32). This runs after the inventory part of the sync (settled).
      const error = auditInputsGap({ tenant: !!tenant, regions: regions.length > 0, synced: true });
      return {
        statuses: [{ id: AUDIT_CONNECTOR, state: 'error' as const, error }],
        capabilities: [{ ...base, state: 'unreachable' as const, lastAttempt: attempt, lastError: error, hint: error }],
      };
    }
    const end = this.d.now?.() ?? new Date();
    const start = new Date(end.getTime() - 3_600_000);
    const started = Date.now();
    const outcomes: { region: string; state: CapabilityState; error?: string }[] = [];
    await mapLimit(regions, this.d.maxConcurrency, async region => {
      try {
        await client.list(tenant, region, start.toISOString(), end.toISOString(), 1);
        outcomes.push({ region, state: 'ok' });
      } catch (e) {
        outcomes.push({ region, state: classify(e).state, error: redact((e as Error).message) });
      }
    });
    outcomes.sort((a, b) => a.region.localeCompare(b.region));
    const state = worst(outcomes.map(o => o.state));
    const failed = outcomes.find(o => o.state !== 'ok');
    const readable = outcomes.filter(o => o.state === 'ok').map(o => o.region);
    const capability: CapabilityStatus = {
      ...base, state, items: readable.length, latencyMs: Date.now() - started, lastAttempt: attempt,
      lastSuccess: readable.length ? attempt : undefined, lastError: failed ? `${failed.region}: ${failed.error}` : undefined,
      hint: hintFor(state, AUDIT_GRANT),
    };
    return {
      statuses: [
        {
          id: AUDIT_CONNECTOR,
          state: (state === 'ok' ? 'ok' : state === 'permission-denied' ? 'permission-denied' : readable.length ? 'ok' : 'error') as ConnectorStatus['state'],
          lastSuccess: capability.lastSuccess,
          error: capability.lastError,
          notes: [readable.length ? `Audit events readable in ${readable.join(', ')}.` : 'No region readable.'],
        },
      ],
      capabilities: [capability],
    };
  }
}
