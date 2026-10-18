import {
  AuditorService,
  BackstageCredentials,
  HttpAuthService,
  PermissionsService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import { NotAllowedError } from '@backstage/errors';
import { AuthorizeResult, BasicPermission } from '@backstage/plugin-permission-common';
import { Request } from 'express';
import { AccessRole } from './config';

/**
 * Server-side project scoping. Permissions decide *what* a caller may do;
 * the scope decides *which projects* a read returns. Both are enforced in
 * the backend; the browser never receives out-of-scope rows.
 */
export interface ProjectScope {
  all: boolean;
  projects: ReadonlySet<string>;
}

export function scopeFor(roles: AccessRole[], principalRefs: string[], permission?: BasicPermission): ProjectScope {
  const refs = new Set(principalRefs.map(r => r.toLowerCase()));
  const matching = roles.filter(r => r.principals.some(p => refs.has(p.toLowerCase())) &&
    (!permission || r.permissions.includes('*') || r.permissions.includes(permission.name)));
  if (matching.some(r => r.projects.includes('*'))) return { all: true, projects: new Set() };
  return { all: false, projects: new Set(matching.flatMap(r => r.projects)) };
}

export function inScope(scope: ProjectScope, projectId: string | undefined): boolean {
  if (scope.all) return true;
  // Rows without a project (e.g. a tenant) are visible only to unrestricted callers.
  return projectId !== undefined && scope.projects.has(projectId);
}

export interface Caller {
  credentials: BackstageCredentials;
  userEntityRef: string;
  principals: string[];
  scope: ProjectScope;
}

export interface AccessDeps {
  httpAuth: HttpAuthService;
  userInfo: UserInfoService;
  permissions: PermissionsService;
  roles: AccessRole[];
}

export class Access {
  constructor(private readonly deps: AccessDeps) {}

  async caller(req: Request): Promise<Caller> {
    const credentials = await this.deps.httpAuth.credentials(req, { allow: ['user'] });
    const info = await this.deps.userInfo.getUserInfo(credentials);
    const principals = [info.userEntityRef, ...info.ownershipEntityRefs];
    return { credentials, userEntityRef: info.userEntityRef, principals, scope: scopeFor(this.deps.roles, principals) };
  }

  async allowed(caller: Caller, permission: BasicPermission): Promise<boolean> {
    // Optional data must be authorized for the entire snapshot being returned.
    const grant = scopeFor(this.deps.roles, caller.principals, permission);
    if (!grant.all && (caller.scope.all || !caller.scope.projects.size || [...caller.scope.projects].some(p => !grant.projects.has(p)))) return false;
    const [decision] = await this.deps.permissions.authorize([{ permission }], { credentials: caller.credentials });
    return decision?.result === AuthorizeResult.ALLOW;
  }

  /** Authorizes every permission and intersects their project grants; an empty scope is denied. */
  async require(req: Request, permission: BasicPermission, ...additional: BasicPermission[]): Promise<Caller> {
    const caller = await this.caller(req);
    for (const requested of [permission, ...additional]) {
      const grant = scopeFor(this.deps.roles, caller.principals, requested);
      caller.scope = caller.scope.all ? grant : grant.all ? caller.scope : {
        all: false, projects: new Set([...caller.scope.projects].filter(p => grant.projects.has(p))),
      };
      if ((!caller.scope.all && !caller.scope.projects.size) || !(await this.allowed(caller, requested))) {
        throw new NotAllowedError(`missing permission or project scope for ${requested.name}`);
      }
    }
    return caller;
  }

  async allowedMap(caller: Caller, perms: BasicPermission[]): Promise<Record<string, boolean>> {
    const decisions = await this.deps.permissions.authorize(
      perms.map(permission => ({ permission })),
      { credentials: caller.credentials },
    );
    return Object.fromEntries(perms.map((p, i) => [p.name, decisions[i].result === AuthorizeResult.ALLOW]));
  }
}

/** Runs a sensitive action inside an audit event; success or failure is recorded. */
export async function audited<T>(
  auditor: AuditorService,
  req: Request,
  eventId: string,
  meta: Record<string, string | number | boolean | null>,
  fn: () => Promise<T>,
): Promise<T> {
  const event = await auditor.createEvent({ eventId, request: req, severityLevel: 'medium', meta });
  try {
    const result = await fn();
    await event.success();
    return result;
  } catch (error) {
    await event.fail({ error: error as Error });
    throw error;
  }
}
