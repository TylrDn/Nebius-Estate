# @internal/backstage-plugin-nebius-estate-backend

Nebius Estate backend: read-only inventory connectors, repository model, evidence index, capacity and
workload views, provisioning previews (`src/`), FOCUS billing, rate books and scenarios
(`src/commercial/`), and the shared configuration, access and outbound HTTP code (`src/lib/`).
Schema: `migrations/`. Configuration schema: `config.d.ts`; the permission policy reads it through
the `./config` entry point.

Part of Nebius Estate — see [portal/README.md](../../README.md) and [docs/portal/architecture.md](../../../docs/portal/architecture.md).
