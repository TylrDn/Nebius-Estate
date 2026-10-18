# Source release and verification

Nebius Estate starts from a cleaned source snapshot of an independent experimental cookbook.
The original development repository, commit history, pull requests and historical tags remain
private. No historical GitHub release or generated image is included in this repository.
Source licenses, notices and [provenance](source-provenance.md) accompany this snapshot;
see [third-party texts](../third_party/README.md).

## Verification record

The October 18, 2026 local verification uses the workflow's pinned Node 24.21.0 Linux image
and the pinned infrastructure toolbox. Docker Desktop's engine is running locally; no GitHub
Actions run or paid runner minute was used. The repository remains private and Actions disabled.
The main-branch ruleset requires a pull request and blocks deletion and non-fast-forward updates.

| Check | Observed local result |
|---|---|
| Portal typecheck, lint, configuration and frontend/backend builds | Passed |
| Portal unit/integration tests | 1,332 passed; three existing tests skipped across 123 suites |
| Dependency compatibility | 28 Node security regressions, 10 router-security and 16 route-parameter regressions passed |
| Demo and prerequisite scripts | 15 passed |
| macOS demo lifecycle | Frontend and backend readiness reached; shutdown completed cleanly |
| Infrastructure | Full toolbox CI, Soperator mocked plans and release regressions passed; final source scans passed |
| External links | Pinned lychee 0.24.2 passed natively; Docker network limitation recorded below |
| Browser and accessibility | 398 Chromium checks passed; two workers, retries disabled |
| Expanded tour visual review | Desktop and mobile, both themes; four additional accessibility analyses passed |
| Complete registry dependency audit | **Failed:** two High and one Low upstream advisory remain visible |

The dependency graph now applies reviewed [local source backports](security/dependency-backports.md)
to braces, node-forge and elliptic. All 13 added regressions pass; stock packages failed nine,
and the upstream proposals alone failed one additional Forge case. Published package versions
remain unchanged, so the registry audit cannot establish that these source patches are installed.
The installed Linux dependency tree was inspected for each patched package and the expected
guards. These patches are a local maintenance responsibility, not official fixed releases or
an accepted residual-risk decision. See [dependency security](dependency-security.md).

Earlier attempts exposed two environment limits: native macOS Jest workers aborted in SQLite
cleanup, and overlapping Linux browser/unit runs exceeded the container's memory limit. The
successful Linux unit/build run was sequential; the macOS full unit run is not recorded as passing.
The first full browser run passed 397 checks and found one accessibility failure in the expanded
demo tour. Paragraph markup restored the existing underlined-link style, and the focused
keyboard/accessibility regression passed before the full rerun.
Final source checks repeat pins, relative links and anchors, and secret/configuration scans in
the pinned toolbox. Its external-link attempt hit a GitHub 503 and connection timeouts to Kueue.
The same pinned lychee 0.24.2 completed `make links` natively on macOS with zero errors.
No additional URLs were excluded and no accepted status codes were added.

The demo's separate macOS startup problem was traced to its temporary SWC cache path, fixed
with a physical private cache directory, and verified with a regression and actual readiness.

This record describes local checks of the source candidate, not publicly accessible CI evidence.
No new GPU benchmark, cloud apply, alert-delivery check, restore drill or autonomous TTL teardown
is claimed. Original private audit downloads and raw verification logs are excluded from this
source repository. Scanners cannot prove the absence of every confidential value.

## Reproduce the checks

Use a working Docker runtime for the infrastructure checks, with the pinned toolbox:

```bash
make toolbox
make ci-docker TARGETS="ci soperator-check scan links release-regressions"
```

For portal verification, use the pinned Node container from `.github/workflows/ci.yml`, with
its private writable HOME and cache directory. The workflow is the authoritative command list:

```bash
cd portal
yarn install --immutable
node --test scripts/tests/*.test.mjs
node --test scripts/security-tests/*.test.mjs
yarn tsc
yarn lint:all
yarn config:check
yarn test:all --ci --maxWorkers=2
yarn build:all
yarn playwright install --with-deps chromium
yarn test:e2e --workers=2
yarn npm audit --all --recursive --json
```

Run the dependency compatibility workspace tests in the workflow as well; the Node security
script suite alone does not cover the Backstage route integration. Audit findings must stay
visible even when builds succeed. No new GPU benchmark, cloud apply, alert-delivery check,
restore drill or autonomous TTL teardown is claimed by these offline checks.

## Repository setup at publication

The fresh repository is prepared privately, with Actions disabled, Dependabot alerts enabled,
no imported deployment secrets or environments, and no live Terraform enable variable. Keep
live dispatch disabled unless deliberately configured for a separately approved cloud run.
Before changing visibility, inspect the final source diff, scanner classifications and verification
limits, and decide whether the disclosed dependency state meets the intended experimental-source
scope. Shared deployment still requires authentication integration and a deployment-specific
security review.

After publication, enable and test GitHub private vulnerability reporting, check the reporting link
in [SECURITY](../SECURITY.md), and recheck public fork approvals and branch protection. Enable
Actions only when the owner chooses to resume CI; workflow files remain available for inspection
and local reproduction. Public repository billing differs from private repository billing, so confirm
the account and runner settings before relying on available minutes.

## Built artifacts

Publishing a Dockerfile does not clear its generated image for distribution. Portal/toolbox images,
compiled browser bundles, fetched upstream trees and cached documentation need the conditional
[artifact distribution review](source-provenance.md#conditional-artifact-distribution-checklist).
This source snapshot does not claim that clearance.
