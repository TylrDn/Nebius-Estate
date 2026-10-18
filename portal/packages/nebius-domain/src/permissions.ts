import { createPermission } from '@backstage/plugin-permission-common';

/**
 * Backend-enforced permissions. Every backend route authorizes one of these
 * before reading or writing; the frontend only uses them to hide controls.
 */
export const estateReadPermission = createPermission({
  name: 'nebius.estate.read',
  attributes: { action: 'read' },
});

export const telemetryReadPermission = createPermission({
  name: 'nebius.telemetry.read',
  attributes: { action: 'read' },
});

export const billingReadPermission = createPermission({
  name: 'nebius.billing.read',
  attributes: { action: 'read' },
});

export const billingImportPermission = createPermission({
  name: 'nebius.billing.import',
  attributes: { action: 'create' },
});

export const commercialRateReadPermission = createPermission({
  name: 'nebius.commercial.rate.read',
  attributes: { action: 'read' },
});

export const commercialRateWritePermission = createPermission({
  name: 'nebius.commercial.rate.write',
  attributes: { action: 'update' },
});

export const scenarioReadPermission = createPermission({
  name: 'nebius.commercial.scenario.read',
  attributes: { action: 'read' },
});

export const scenarioWritePermission = createPermission({
  name: 'nebius.commercial.scenario.write',
  attributes: { action: 'update' },
});

export const provisioningPreviewPermission = createPermission({
  name: 'nebius.provisioning.preview',
  attributes: { action: 'read' },
});

/** Creating a request record (local, no external write). */
export const provisioningRequestPermission = createPermission({
  name: 'nebius.provisioning.request.create',
  attributes: { action: 'create' },
});

/** Budgets, credits and Token Factory spend the owner enters (local data, no external write). */
export const budgetWritePermission = createPermission({
  name: 'nebius.billing.budget.write',
  attributes: { action: 'update' },
});

export const integrationAdminPermission = createPermission({
  name: 'nebius.integration.admin',
  attributes: { action: 'update' },
});

/** Acknowledge or mute an alert: a local note stored with the user ref; nothing is sent or changed in the cloud. */
export const alertAnnotatePermission = createPermission({
  name: 'nebius.alerts.annotate',
  attributes: { action: 'update' },
});

/** Read Nebius Observability Logs (serial consoles, control planes, managed services) through the backend. */
export const logsReadPermission = createPermission({
  name: 'nebius.logs.read',
  attributes: { action: 'read' },
});

/** Read the tenant's Nebius audit events (who did what to which resource) through the backend; every project in scope. */
export const auditReadPermission = createPermission({
  name: 'nebius.audit.read',
  attributes: { action: 'read' },
});

/** Every Nebius Estate permission, registered by the backend plugin. */
export const nebiusPermissions = [
  estateReadPermission,
  telemetryReadPermission,
  provisioningPreviewPermission,
  provisioningRequestPermission,
  integrationAdminPermission,
  billingReadPermission,
  billingImportPermission,
  budgetWritePermission,
  commercialRateReadPermission,
  commercialRateWritePermission,
  scenarioReadPermission,
  scenarioWritePermission,
  alertAnnotatePermission,
  logsReadPermission,
  auditReadPermission,
];
