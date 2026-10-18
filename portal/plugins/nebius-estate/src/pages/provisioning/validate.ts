import type { ProvisioningRequestInput } from '@internal/nebius-domain';
import { provisioningRequestSchema } from '@internal/nebius-domain';

/**
 * Field-level checks before a preview is requested: the same schema the backend parses
 * (provisioningRequestSchema), worded for the field it belongs to. A request that fails here is not sent,
 * so the backend's combined validation text never reaches the page.
 */

const BUDGET = /^\d+(\.\d+)?$/;
const BUDGET_MESSAGE = 'Enter an amount such as 500 or 499.50 (one decimal point, digits only).';

/** The budget field: empty (none), or a non-negative decimal with one point at most. */
export function budgetError(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  return BUDGET.test(v) ? undefined : BUDGET_MESSAGE;
}

const MESSAGES: Record<string, string> = {
  owner: 'Enter the owning team: lowercase letters, digits and dashes (e.g. platform).',
  requestRef: 'Enter a ticket, date or run id: letters, digits, dot, dash or underscore, no spaces (e.g. ticket-123).',
  ttlExpires: 'Enter the TTL as a UTC date and time.',
  gpuNodeCount: 'Enter a whole number of GPU nodes from 0 to 64.',
  filestoreSizeGib: 'Enter a whole number of GiB, 0 or more.',
  runtimeHours: 'Enter the approved runtime in hours (at least 0.25).',
  budget: BUDGET_MESSAGE,
};

/** Messages per field for what the schema refuses (and the raw budget text); empty when the request can be sent. */
export function clientFieldErrors(input: ProvisioningRequestInput, rawBudget: string): Record<string, string> {
  const out: Record<string, string> = {};
  const budget = budgetError(rawBudget);
  const full = { ...input, budget: rawBudget.trim() && !budget ? { amount: rawBudget.trim(), currency: input.budget?.currency ?? 'USD' } : undefined };
  const r = provisioningRequestSchema.safeParse(full);
  if (!r.success) {
    for (const issue of r.error.issues) {
      const field = String(issue.path[0] ?? '');
      if (field && !out[field]) out[field] = MESSAGES[field] ?? `Check ${field}.`;
    }
  }
  if (budget) out.budget = budget;
  return out;
}

/** Field labels, for "Fix the highlighted fields: …". */
export const FIELD_LABELS: Record<string, string> = {
  owner: 'Owner',
  requestRef: 'Request reference',
  ttlExpires: 'TTL',
  gpuNodeCount: 'GPU nodes',
  filestoreSizeGib: 'Shared filesystem',
  runtimeHours: 'Approved runtime',
  budget: 'Approved budget',
};

const PATH_LABELS: [RegExp, string][] = [
  [/^footprint\.nodeGroups\.\d+\.count$/, 'node counts (whole numbers only)'],
  [/^footprint\./, 'footprint'],
  ...Object.entries(FIELD_LABELS).map(([k, v]) => [new RegExp(`^${k}(\\.|$)`), v] as [RegExp, string]),
];

/**
 * A backend 400 lists schema issues as "path: message; …". Shown to people, it names the fields instead; any
 * other message passes through unchanged.
 */
export function readableInputError(message: string): string {
  const parts = message.split('; ').map(p => /^([A-Za-z][\w.]*): /.exec(p)?.[1]);
  if (!parts.length || parts.some(p => !p)) return message;
  const labels = [...new Set(parts.map(p => PATH_LABELS.find(([re]) => re.test(p!))?.[1] ?? p!))];
  return `Check these fields: ${labels.join(', ')}.`;
}
