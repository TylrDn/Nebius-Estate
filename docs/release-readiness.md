# Source release and verification

Nebius Estate starts from a cleaned source snapshot of an independent experimental cookbook.
The original development repository, commit history, pull requests and historical tags remain
private. No historical GitHub release or generated image is included in this repository.
Source licenses, notices and [provenance](source-provenance.md) accompany this snapshot;
see [third-party texts](../third_party/README.md).

## Verification record

The source baseline is `188d6b9dcacc9787f4857bedcf2a760b7b813c8c`, checked in private development
Actions run `39082724154` on October 17, 2026. That run is not publicly accessible. The following
is a maintainer-recorded result, not independently accessible public CI evidence:

| Check | Observed baseline result |
|---|---|
| Infrastructure | `make ci`, Soperator mocked checks, history secret scan, Trivy configuration scan and external links passed |
| Portal | Typecheck, lint, config check, unit/integration tests and frontend/backend builds passed; 1,329 tests passed and three existing tests skipped |
| Browser | Four shards, 397 checks passed, no retries |
| Dependency compatibility | 41 installed-dependency, router-security and route-parameter regressions passed |
| Demo and prerequisite scripts | 14 tests passed |
| Release regressions | Passed, including authorization/pricing scope, deployment inputs, source retention and observability mock tests |
| Complete dependency audit | **Failed:** two High and one Low upstream advisory; see [dependency security](dependency-security.md) |

Publication edits update repository URLs (including matching link assertions), first-run command
order and documentation, remove obsolete private-history scanner exceptions, and replace the
private release-review notes with this record. They do not change the locked dependencies or
cloud-resource configuration. The final snapshot has **not** received another full container run.
The maintainer has exhausted the monthly Actions allowance, and local Docker is unavailable.
Actions is disabled in the new repository during preparation to avoid consuming additional minutes.
Do not treat the earlier baseline run as a passing run of this repository's final commit.

The October 18 publication review checked 207 relative Markdown link targets for file existence,
confirmed that the locked dependencies, pins and retained third-party texts are unchanged, and
ran Gitleaks over the fresh source tree with no leaks found. This limited static review does not
replace the project’s full Markdown anchor checks, builds or tests. An independent review of the
publication delta found no source-publication blocker.

The source/private-artifact review found no confirmed credential or private resource identifier
in the classified findings. Scanners do not prove absence of every possible confidential value.
Original private audit downloads and logs are excluded from this source repository.

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
in [SECURITY](../SECURITY.md), and configure public fork approval and branch protection. Enable
Actions only when the owner chooses to resume CI; workflow files remain available for inspection
and local reproduction. Public repository billing differs from private repository billing, so confirm
the account and runner settings before relying on available minutes.

## Built artifacts

Publishing a Dockerfile does not clear its generated image for distribution. Portal/toolbox images,
compiled browser bundles, fetched upstream trees and cached documentation need the conditional
[artifact distribution review](source-provenance.md#conditional-artifact-distribution-checklist).
This source snapshot does not claim that clearance.
