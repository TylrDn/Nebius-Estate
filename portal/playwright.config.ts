// Modified by Taylor Dean from Backstage create-app 0.9.2 (v1.55.0):
// Nebius Estate app/plugin configuration, backend composition and local verification.
// Source details and retained notices: docs/source-provenance.md, third_party/licenses/.
/*
 * Copyright 2023 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { defineConfig } from '@playwright/test';
import { generateProjects } from '@backstage/e2e-test-utils/playwright';

// Browser tests use the supported isolated synthetic demo and its lifecycle.
export default defineConfig({
  timeout: 60_000,
  expect: { timeout: 30_000 },
  webServer: {
    command: 'node scripts/demo.mjs',
    url: 'http://localhost:3100',
    reuseExistingServer: false,
    timeout: 240_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
  globalSetup: './e2e-stub/wait-ready.mjs',
  forbidOnly: !!process.env.CI,
  // No retries: a test that passes only on a retry is a bug to fix (the start-up race was one).
  retries: 0,
  reporter: [['html', { open: 'never', outputFolder: 'e2e-test-report' }]],
  use: {
    actionTimeout: 0,
    baseURL: process.env.PLAYWRIGHT_URL ?? 'http://localhost:3100',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  outputDir: 'node_modules/.cache/e2e-test-results',
  // Find all packages with e2e-test folders; use Playwright's bundled Chromium
  // (`yarn playwright install chromium`) instead of an installed Google Chrome.
  projects: generateProjects().map(p => ({ ...p, use: { ...p.use, channel: undefined } })),
});
