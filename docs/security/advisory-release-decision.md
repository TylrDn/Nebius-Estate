# Advisory review for the proposed source release

**Status: prepared for owner review; publication and risk acceptance are pending.**
This record covers the proposed `v0.1.0` experimental source release. Preparing it does not
approve publication, dismiss an advisory or authorize a shared deployment. Keep the repository
private and Actions disabled until the owner explicitly approves the next action.

## Decision and maintenance responsibility

| Item | Proposed arrangement |
|---|---|
| Publication decision owner | Taylor Dean, repository owner |
| Dependency patch maintenance owner | Taylor Dean, proposed; confirmation pending |
| Technical review date | October 18, 2026 |
| Next maintenance review | By November 1, 2026, or before a dependency, patch or input-boundary change, whichever is earlier |
| Proposed distribution | Source checkout/archive with LICENSE, NOTICE, provenance and retained third-party texts |
| Evaluation scope | Synthetic portal demo on loopback; infrastructure examples require operator review |
| Approval status | Pending separately for the advisory disposition, source ownership/confidentiality review and publication |

The review date is a maintenance obligation for the confirmed owner, not a scheduled monitoring
service. Reassess stale evidence before publication if the review deadline has passed.

## Findings and remaining risk

The complete recursive registry audit reports two High and one Low advisory. Published package
versions are preserved, all matching ranges use committed Yarn patches, and the findings stay
visible. The official advisory metadata reviewed on October 18 lists no fixed release for these
entries. Patch implementation and exact upstream references are in [dependency backports](dependency-backports.md).

| Advisory | Observed path and local mitigation | Remaining risk and release boundary | Owner decision |
|---|---|---|---|
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), braces 3.0.3, High | Backstage config watching and tooling through chokidar/micromatch. The patch bounds parser/AST depth and rejects cyclic parent chains. | Runtime config watching remains a consumer. Trusted operator-selected paths are the reviewed boundary; untrusted patterns or new request-driven glob features need a new review. Targeted regressions cover the reproduced recursion cases, not every possible denial of service. | Pending |
| [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv), node-forge 1.4.0, High | Backstage generated development certificates and selfsigned. The patch checks nested child counts, empty NULL parameters and canonical algorithm OID bytes. | Generated backend HTTPS is absent from the shipped configuration. Enabling it, processing external certificates/signatures or adding authentication integrations changes the boundary. The locally maintained cryptographic patch has bounded regression evidence, not an exhaustive security assessment. | Pending |
| [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84), elliptic 6.6.1, Low | CLI build browser-polyfill chain through browserify-sign/create-ecdh. The patch preserves generated P-521 nonce width before truncation. | Future dependency or bundler changes may change reachability. Do not introduce real signing features using this package under this review. Independent nonce/signature controls exercise the reproduced case and compatibility boundaries. | Pending |

Forty installed-dependency security/compatibility checks passed on macOS and Linux, including
24 advisory-focused checks and a native SQLite lifecycle check. Installed consumer resolution
was inspected on both platforms. The [release record](../release-readiness.md) contains the full
functional verification scope. Those results support the mitigations; they do not clear the audit.

## Conditions for the proposed experimental source scope

- Keep the three findings and patch provenance visible in the README-linked security documents.
  The complete audit continues to fail; no advisory IDs are ignored or assigned invented fixes.
- Use the committed lockfile and immutable installation. Recheck all installed consumer paths
  after graph changes; a passing test against one package copy does not establish the others.
- Use the local synthetic portal demo for evaluation. Shared portal hosting requires completed
  authentication integration and a separate deployment review. Live infrastructure operations
  require the operator's own approved targets, credentials, budget and acceptance checks.
- Publish source only under this review. Images, browser bundles, fetched upstream trees,
  mirrored documentation and tool distributions require their own [distribution review](../source-provenance.md#conditional-artifact-distribution-checklist).

## What the maintenance owner must do

At each review, check the official advisory entries and supported parent/package releases.
Replace local patches with supported fixes when available, or document why they remain.
Regenerate the lockfile with the pinned runtime; inspect every consumer path; rerun advisory,
route compatibility, unit, build and browser checks for a dependency or executable change.
An update that applies cleanly still needs a behavioral review.

Reopen this decision before adding untrusted glob inputs, certificate/signature handling,
cryptographic signing or a shared portal deployment. Treat a patch bypass, missing patched
consumer or failed regression as a release blocker. Keep the last verified lockfile/patch set
available while investigating; do not turn a failing check green by suppressing it.

## Owner approval still required

The owner must record the decision date and confirm the maintenance assignment, reviewed
constraints and next review date for each finding. Source ownership and confidentiality approval
are separate from the technical checks. Neither approval is inferred from asking to prepare
the release. If the owner requires an advisory-free graph, keep publication on hold until
supported upstream fixes or a verified parent migration satisfy that requirement.

No approval has been recorded in this document.
