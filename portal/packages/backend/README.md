# backend

The Nebius Estate backend: Backstage auth (guest only on a loopback-only local run), the permission backend with
`NebiusRolePolicy` (`src/permissionPolicy.ts`, default deny for `nebius.*`), and the Nebius Estate
backend plugin. Start it with `yarn start` from `portal/` (or `make portal-dev`), which loads
`app-config.yaml` and `app-config.local.yaml`.
