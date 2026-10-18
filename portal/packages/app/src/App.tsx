// Modified by Taylor Dean from Backstage create-app 0.9.2 (v1.55.0):
// Nebius Estate app/plugin configuration, backend composition and local verification.
// Source details and retained notices: docs/source-provenance.md, third_party/licenses/.
import { createApp } from '@backstage/frontend-defaults';
import nebiusEstatePlugin from '@internal/backstage-plugin-nebius-estate';
import { nebiusAppModule } from './modules/appModule';

export default createApp({
  features: [nebiusEstatePlugin, nebiusAppModule],
});
