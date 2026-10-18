// Modified by Taylor Dean from Backstage create-app 0.9.2 (v1.55.0):
// Nebius Estate app/plugin configuration, backend composition and local verification.
// Source details and retained notices: docs/source-provenance.md, third_party/licenses/.
/*
 * Nebius Estate backend. Only what the portal uses: the app, sign-in, the
 * permission framework with a role policy for nebius.* permissions, and the
 * Nebius Estate plugin. No scaffolder, no catalog, no proxy: nothing here can
 * run commands or reach arbitrary URLs.
 */
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-app-backend'));

// Sign-in. The guest provider is for one operator on this machine only: it refuses
// to run outside NODE_ENV=development, and the Nebius Estate plugin refuses to start
// with it unless the backend listens on loopback (docs/portal/security.md).
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));

// Permissions: default-deny role policy for nebius.* (app-config nebiusEstate.access.roles).
backend.add(import('@backstage/plugin-permission-backend'));
backend.add(import('./permissionPolicy'));

backend.add(import('@internal/backstage-plugin-nebius-estate-backend'));

backend.start();
