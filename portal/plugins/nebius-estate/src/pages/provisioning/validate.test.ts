import type { ProvisioningRequestInput } from '@internal/nebius-domain';
import { budgetError, clientFieldErrors, readableInputError } from './validate';

const input: ProvisioningRequestInput = {
  recipe: 'sandbox-inference', stage: 'sandbox', region: 'eu-north1', platform: null, gpuNodeCount: 1, capacityType: 'preemptible',
  ttlExpires: '2026-10-11T18:00:00Z', runtimeHours: 8, owner: 'platform', requestRef: 'ticket-123',
};

describe('provisioning: field-level client validation', () => {
  it('accepts a decimal budget and rejects "12.3.4" on the budget field', () => {
    expect(budgetError('')).toBeUndefined();
    expect(budgetError('500')).toBeUndefined();
    expect(budgetError('499.50')).toBeUndefined();
    expect(budgetError('12.3.4')).toBe('Enter an amount such as 500 or 499.50 (one decimal point, digits only).');
    expect(budgetError('-5')).toBe('Enter an amount such as 500 or 499.50 (one decimal point, digits only).');
  });

  it('puts owner and reference messages on their fields, never a raw zod string', () => {
    const e = clientFieldErrors({ ...input, owner: '', requestRef: 'bad ref!' }, '12.3.4');
    expect(e).toEqual({
      owner: 'Enter the owning team: lowercase letters, digits and dashes (e.g. platform).',
      requestRef: 'Enter a ticket, date or run id: letters, digits, dot, dash or underscore, no spaces (e.g. ticket-123).',
      budget: 'Enter an amount such as 500 or 499.50 (one decimal point, digits only).',
    });
    expect(Object.values(e).join(' ')).not.toMatch(/budget\.amount|Invalid|regex|expected/);
  });

  it('is empty for a valid request', () => {
    expect(clientFieldErrors(input, '500')).toEqual({});
  });
});

describe('backend validation text', () => {
  it('names the fields instead of showing raw schema messages', () => {
    expect(readableInputError('budget.amount: non-negative decimal; owner: lowercase letters, digits and dashes')).toBe('Check these fields: Approved budget, Owner.');
    expect(readableInputError('footprint.nodeGroups.1.count: Invalid input: expected int')).toBe('Check these fields: node counts (whole numbers only).');
    expect(readableInputError('A sync is already running')).toBe('A sync is already running');
  });
});
