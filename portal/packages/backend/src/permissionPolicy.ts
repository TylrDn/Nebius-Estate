import { coreServices, createBackendModule, UserInfoService } from '@backstage/backend-plugin-api';
import { AuthorizeResult, PolicyDecision } from '@backstage/plugin-permission-common';
import { PermissionPolicy, PolicyQuery, PolicyQueryUser } from '@backstage/plugin-permission-node';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import { AccessRole, readEstateConfig } from '@internal/backstage-plugin-nebius-estate-backend/config';

/**
 * Role-based policy for the `nebius.*` permissions, driven by
 * nebiusEstate.access.roles in app-config. Default deny: a nebius.*
 * permission is allowed only when one of the caller's refs (user entity ref
 * or ownership refs) is a principal of a role that lists the permission (or
 * '*'). Permissions of other Backstage plugins are allowed (this portal
 * ships none that need gating).
 */
export class NebiusRolePolicy implements PermissionPolicy {
  constructor(private readonly roles: AccessRole[], private readonly userInfo?: UserInfoService) {}

  async handle(request: PolicyQuery, user?: PolicyQueryUser): Promise<PolicyDecision> {
    const name = request.permission.name;
    if (!name.startsWith('nebius.')) return { result: AuthorizeResult.ALLOW };
    if (!user) return { result: AuthorizeResult.DENY };
    const info = this.userInfo ? await this.userInfo.getUserInfo(user.credentials) : user.info;
    const refs = new Set(
      [info.userEntityRef, ...(info.ownershipEntityRefs ?? [])]
        .filter((r): r is string => Boolean(r))
        .map(r => r.toLowerCase()),
    );
    const granted = this.roles.some(
      role => role.principals.some(p => refs.has(p.toLowerCase())) && (role.permissions.includes('*') || role.permissions.includes(name)),
    );
    return { result: granted ? AuthorizeResult.ALLOW : AuthorizeResult.DENY };
  }
}

export default createBackendModule({
  pluginId: 'permission',
  moduleId: 'nebius-role-policy',
  register(reg) {
    reg.registerInit({
      deps: { policy: policyExtensionPoint, config: coreServices.rootConfig, userInfo: coreServices.userInfo },
      async init({ policy, config, userInfo }) {
        policy.setPolicy(new NebiusRolePolicy(readEstateConfig(config).roles, userInfo));
      },
    });
  },
});
