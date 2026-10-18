/**
 * Nebius Audit Logs (GET https://audit.api.nebius.cloud/audit/v2/audit-events): who did what to
 * which resource, tenant-wide, per region. The API requires parentId (the tenant), region, start and
 * end (verified live 2026-10-11). Only the fields below are kept: never the token, client IP, user
 * agent, TLS fingerprint, request parameters or response payload the event also carries.
 */

/** The most events one request shows, and the longest window it may cover. */
export const MAX_AUDIT_EVENTS = 200;
export const MAX_AUDIT_RANGE_MINUTES = 7 * 24 * 60;

export interface AuditEvent {
  id: string;
  time: string;
  /** e.g. COMPUTE, IAM, VIRTUAL_NETWORKS */
  service: string;
  /** e.g. CREATE, UPDATE, DELETE, GET, LIST */
  action: string;
  /** The full event type, e.g. ai.nebius.compute.instance.create */
  type: string;
  who: { kind: 'service-account' | 'user' | 'unknown'; id?: string; name?: string };
  resource: { type?: string; id?: string; name?: string };
  /** false: the call was refused by authorization; undefined when the event does not say. */
  authorized?: boolean;
  /** The event status, e.g. DONE; with the error message when the operation failed. */
  status: string;
  error?: string;
}

export interface AuditEventsResponse {
  region: string;
  /** Regions the listed projects are in: the regions audit events can be read for. */
  regions: string[];
  start: string;
  end: string;
  events: AuditEvent[];
  limit: number;
  /** More events exist in the window than `limit`, or pages were left unread (then `scannedFrom` is set). */
  truncated: boolean;
  /**
   * Set when the page budget ran out before the window's start: the oldest event time read. Events between `start`
   * and this time were not read (G3.4).
   */
  scannedFrom?: string;
  /** Events read from the API, reads included. */
  scanned?: number;
  /** Writes only: whether the API accepted the writes filter (else reads were dropped by the portal). */
  serverFiltered?: boolean;
  /** Mutating actions only (CREATE, UPDATE, DELETE and the like), or every action including GET and LIST. */
  writesOnly: boolean;
  unavailableReason?: string;
  source: string;
  observedAt: string;
}

/** Read-only calls the portal and other tools make all day; hidden unless the reader asks for them. */
export const AUDIT_READ_ACTIONS = ['GET', 'LIST'];
