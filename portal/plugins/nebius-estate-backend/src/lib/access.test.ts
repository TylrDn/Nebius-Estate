import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { billingReadPermission, budgetWritePermission } from '@internal/nebius-domain';
import { Request } from 'express';
import { Access } from './access';
import { AccessRole } from './config';

const principal = 'user:default/mixed';
const finance = (projects: string[], permissions = [billingReadPermission.name, budgetWritePermission.name]): AccessRole => ({
  name: 'finance', principals: ['GROUP:DEFAULT/FINANCE'], permissions, projects,
});
const observer = (projects: string[]): AccessRole => ({
  name: 'observer', principals: [principal], permissions: ['nebius.estate.read'], projects,
});

function access(roles: AccessRole[], result: AuthorizeResult.ALLOW | AuthorizeResult.DENY = AuthorizeResult.ALLOW) {
  const httpAuth = mockServices.httpAuth.mock();
  httpAuth.credentials.mockResolvedValue(mockCredentials.user(principal));
  return new Access({
    roles,
    httpAuth,
    userInfo: mockServices.userInfo.mock({ getUserInfo: async () => ({ userEntityRef: principal, ownershipEntityRefs: ['group:default/finance'] }) }),
    permissions: mockServices.permissions.mock({ authorize: async () => [{ result }] }),
  });
}

describe('Access.require permission-bound projects', () => {
  it.each([billingReadPermission, budgetWritePermission])('keeps $name on its granting role projects', async permission => {
    const caller = await access([finance(['project-a']), observer(['project-b'])]).require({} as Request, permission);
    expect(caller.scope.all).toBe(false);
    expect([...caller.scope.projects]).toEqual(['project-a']);
  });

  it('does not inherit a wildcard project from an unrelated observer role', async () => {
    const caller = await access([finance(['project-a']), observer(['*'])]).require({} as Request, budgetWritePermission);
    expect(caller.scope.all).toBe(false);
    expect([...caller.scope.projects]).toEqual(['project-a']);
  });

  it('recognizes wildcard permissions and unions only granting roles', async () => {
    const caller = await access([finance(['project-a'], ['*']), finance(['project-c']), observer(['project-b'])]).require({} as Request, billingReadPermission);
    expect(caller.scope.all).toBe(false);
    expect([...caller.scope.projects].sort()).toEqual(['project-a', 'project-c']);
  });

  it('allows all projects only when a granting role has wildcard projects', async () => {
    const caller = await access([finance(['*']), observer(['project-b'])]).require({} as Request, billingReadPermission);
    expect(caller.scope.all).toBe(true);
  });

  it.each([
    [observer(['*'])],
    [finance([]), observer(['*'])],
    [{ ...finance(['*']), principals: ['user:default/someone-else'] }],
  ])('fails closed without projects granted for the permission (%#)', async (...roles) => {
    await expect(access(roles).require({} as Request, billingReadPermission)).rejects.toThrow(/scope|permission|project/i);
  });

  it('still refuses an external policy denial', async () => {
    await expect(access([finance(['*'])], AuthorizeResult.DENY).require({} as Request, billingReadPermission)).rejects.toThrow(/permission/i);
  });

  it('does not enable optional permission data beyond that permission scope', async () => {
    const service = access([finance(['project-a']), observer(['*'])]);
    const caller = await service.require({} as Request, { ...billingReadPermission, name: 'nebius.estate.read' });
    expect(await service.allowed(caller, billingReadPermission)).toBe(false);
  });

  it('allows optional permission data when its granting scope covers the caller scope', async () => {
    const service = access([finance(['*']), observer(['project-b'])]);
    const caller = await service.require({} as Request, { ...billingReadPermission, name: 'nebius.estate.read' });
    expect(await service.allowed(caller, billingReadPermission)).toBe(true);
  });
});
