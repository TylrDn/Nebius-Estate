import { AuthorizeResult, createPermission } from '@backstage/plugin-permission-common';
import { NebiusRolePolicy } from './permissionPolicy';

const perm = (name: string) => ({ permission: createPermission({ name, attributes: {} }) });
const user = (ref: string, groups: string[] = []) => ({ info: { userEntityRef: ref, ownershipEntityRefs: [ref, ...groups] }, credentials: {} as any });

describe('NebiusRolePolicy', () => {
  const policy = new NebiusRolePolicy([
    { name: 'platform', principals: ['group:default/platform'], permissions: ['*'], projects: ['*'] },
    { name: 'finance', principals: ['user:default/fin'], permissions: ['nebius.billing.read'], projects: ['*'] },
  ]);

  it('allows nebius.* only through a matching role (default deny)', async () => {
    expect((await policy.handle(perm('nebius.billing.read'), user('user:default/fin'))).result).toBe(AuthorizeResult.ALLOW);
    expect((await policy.handle(perm('nebius.commercial.rate.write'), user('user:default/fin'))).result).toBe(AuthorizeResult.DENY);
    expect((await policy.handle(perm('nebius.integration.admin'), user('user:default/x', ['group:default/platform']))).result).toBe(AuthorizeResult.ALLOW);
    expect((await policy.handle(perm('nebius.estate.read'), user('user:default/stranger'))).result).toBe(AuthorizeResult.DENY);
    expect((await policy.handle(perm('nebius.estate.read'))).result).toBe(AuthorizeResult.DENY);
  });

  it('does not gate permissions of other plugins', async () => {
    expect((await policy.handle(perm('catalog.entity.read'), user('user:default/stranger'))).result).toBe(AuthorizeResult.ALLOW);
  });
});
