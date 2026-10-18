// Playwright globalSetup independently verifies backend readiness after the supported demo
// webServer is reachable. The demo also waits for the first inventory sync; this check keeps
// browser tests from racing that readiness when the frontend becomes reachable first.
const READINESS = process.env.E2E_BACKEND_READINESS ?? 'http://127.0.0.1:7107/.backstage/health/v1/readiness';
const TIMEOUT_MS = 180_000;

export default async function waitForBackend() {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(READINESS, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`e2e backend not ready after ${TIMEOUT_MS / 1000} s at ${READINESS} (last: ${last})`);
}
