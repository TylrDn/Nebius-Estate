# Dependency security status

The portal's current Backstage dependency graph has known advisories. A source release is
not an advisory-free installation or approval for a hosted multi-user deployment. The
complete recursive audit deliberately remains visible; no advisory is blanket-ignored and
the scoped owner acceptance is recorded explicitly in the linked decision record.

[Local source backports](security/dependency-backports.md) now address the reproduced cases,
including additional Forge NULL-content and algorithm-OID validation gaps found during review. Their 24 focused regressions
pass locally. The complete version-based registry audit still reports the three advisories;
these results are distinct.
The [advisory decision record](security/advisory-release-decision.md) documents each finding's
remaining risk and maintenance obligations. Taylor Dean approved experimental source publication
and accepted these risks on October 18, 2026; the next maintenance review is due by November 1.

## Dependency updates

The release remediation updates the existing graph, without new application libraries:

| Component | Remediation | Boundary |
|---|---|---|
| adm-zip | 0.6.0 to 0.6.1 resolution | Module-federation/Backstage CLI archive tooling |
| undici | Exact 7.29.0 to 7.30.0 resolution | Module-federation tooling; other major resolutions retained |
| tar | Consolidate on 7.5.22 | Archive tooling including the old node-gyp chain; removes the known critical affected version |
| prismjs | 1.30.0 | Existing syntax highlighting dependency |
| postcss-selector-parser | 7.1.6 | Existing CSS build dependency; verify compatibility in full build |
| supertest | 7.3.1-compatible dev dependency | Test HTTP client, with updated superagent |
| Octokit REST / app-auth | REST 20.1.2 and app-auth 6.1.4 for the old Backstage integration selectors | Preserves CommonJS while selecting patched request, request-error and pagination packages; synthetic credentials, JWT, installation token and pagination tests |
| argparse / js-yaml 3 | argparse 2.0.1, retaining js-yaml 3.15.2 with a CLI version-action patch | Removes the sprintf-js chain without changing YAML schema behavior; [patch and provenance](js-yaml-argparse-patch.md) |
| UUID / material-table | UUID 11.1.1 and a named-import patch to material-table 3.2.5 | Preserves row identity and selection; [patch, upstream license and buffer regressions](material-table-uuid-patch.md) |
| React Router | Router and DOM 7.18.4, with [Backstage route parameter compatibility patches](security/react-router-7-compatibility.md) | Tests mixed-separator navigation, exact-once named parameter encoding and preserved wildcard behavior; full browser verification and its source scope are recorded in the [release record](release-readiness.md) |

Lockfile changes use the pinned Node version and are verified by immutable installs on
macOS and Linux. The immutable install,
typecheck, full test suite and build must validate them; resolution overrides are not proof
of compatibility by themselves. Re-run `cd portal && yarn npm audit --all --recursive --json`
on the exact candidate commit: counts and advisories change over time.

## Remaining upstream limitations and local mitigations

The October 18 local complete recursive audit still reports three advisory entries: two High
and one Low, plus upstream deprecations. It removes the seven Moderate findings in the earlier
10-entry candidate, but remains a failing check. The findings remain unsuppressed; the owner accepted their documented source-release risks;
see the local backports for their tested mitigation and maintenance limits, and the
[verification record](release-readiness.md) for the candidate's full test results. No GitHub
Actions run was used for this local verification.

At the October 18 metadata recheck, the latest published `braces` 3.0.3 and `node-forge` 1.4.0
remain affected by High advisories with no patched release identified:

- [braces stack exhaustion](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): Backstage's
  runtime config loader and development tooling use chokidar 3 and brace patterns. The
  demonstrated inputs are operator-selected configuration/watch paths, not an identified
  anonymous HTTP request path. Do not accept untrusted watcher patterns or local config.
- [node-forge RSA verification](https://github.com/advisories/GHSA-86w9-cpqp-85rv): Backstage
  backend defaults use forge for generated development HTTPS certificates. `selfsigned`
  verifies its own newly generated certificate; no attacker-provided signature path was
  demonstrated here. The shipped backend does not enable `backend.https: true`. Keep TLS
  termination outside the portal and review any new certificate/authentication integration.

- [elliptic nonce generation](https://github.com/advisories/GHSA-848j-6mx2-7j84):
  the latest published 6.6.1 remains affected by a Low advisory. It enters through
  browserify signing/ECDH tooling. No exploit path through the portal was demonstrated;
  this does not establish that every bundled or future consumer is safe.

These are scoped source observations, not proof that every call path is unreachable.
None of these three packages had an official patched release at the review. Open
upstream patches do not make their current versions pass the registry audit. Keep
the findings visible while the local backports await published upstream fixes or supported
parent replacements.
For example, replacing chokidar 3 with 4 changes glob behavior. Do not rename packages,
fabricate patched version numbers, or suppress advisory IDs to obtain a passing check.

The Router 7 resolution intentionally produces peer-version warnings from Backstage
packages that declare Router 6. The narrow local resolver patches and regression tests
address the observed parameter-encoding break; they do not create upstream support for
this combination. Recheck it on every Backstage or Router update, run the complete
browser suite, and remove the overrides when the supported parent graph includes fixes.
Upstream deprecated-package warnings also remain and are included in the unchanged audit.

Before a public installation recommendation or shared deployment, review each remaining
finding, its enabled feature/input boundary and available mitigation. Any residual-risk
acceptance must name the advisory, reviewer, deployment constraints and review/expiry date.
The recorded approval covers experimental source distribution only. Keep the full audit check and exact CI results
linked from release review; do not describe a green compilation as a clean security audit.
