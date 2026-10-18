/** Documented Nebius endpoints the connectors may call (origin allowlists). */
export const NEBIUS_API = 'https://api.nebius.cloud';
/** Documented HTTP token exchange (STS); accepts a self-signed service-account JWT (docs.nebius.com/iam/wif). */
export const NEBIUS_AUTH = 'https://sts.nebius.com';
/** Nebius Monitoring PromQL read API (docs.nebius.com/observability). */
export const NEBIUS_MONITORING = 'https://read.monitoring.api.nebius.cloud';
/** Nebius Observability Logs, Loki-compatible read API (docs.nebius.com/observability/logs/logcli). */
export const NEBIUS_LOGGING = 'https://read.logging.api.nebius.cloud';
/** Nebius Audit Logs read API: GET /audit/v2/audit-events (the CLI's `nebius audit v2 audit-event list`). */
export const NEBIUS_AUDIT = 'https://audit.api.nebius.cloud';
