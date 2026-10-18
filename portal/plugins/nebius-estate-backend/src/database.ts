import { resolvePackagePath } from '@backstage/backend-plugin-api';
import { Knex } from 'knex';

const migrationsDir = resolvePackagePath('@internal/backstage-plugin-nebius-estate-backend', 'migrations');

/**
 * Brings the plugin's tables up to date (knex migrations in migrations/). The configured tenant id
 * reaches the migrations as `knex.userParams.nebiusTenantId` (rows saved without a tenant are claimed).
 */
export async function migrate(db: Knex, opts: { tenantId?: string } = {}): Promise<void> {
  await db.withUserParams({ ...db.userParams, nebiusTenantId: opts.tenantId ?? '' }).migrate.latest({ directory: migrationsDir });
}
