import { readFileSync } from 'fs';
import { resolve } from 'path';
import { NIP_LABELS } from './resources';

// docs/naming.md "Our label set" is the source of truth for the nip-* keys the stacks write.
const naming = readFileSync(resolve(__dirname, '../../../../docs/naming.md'), 'utf8');

describe('nip-* labels', () => {
  const documented = [...naming.matchAll(/^\|\s*`(nip-[a-z-]+)`\s*\|/gm)].map(m => m[1]);

  it('knows every key of the docs/naming.md label table, and nothing else', () => {
    expect(documented.length).toBeGreaterThan(8);
    expect([...Object.values(NIP_LABELS)].sort()).toEqual([...new Set(documented)].sort());
  });

  it('includes nip-ci-job (R13 federated credentials)', () => {
    expect(NIP_LABELS.ciJob).toBe('nip-ci-job');
  });
});
