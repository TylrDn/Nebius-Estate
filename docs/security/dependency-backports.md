# Local dependency security backports

These source patches address reproduced failure cases in the locked dependency graph.
They preserve the published package versions and use Yarn's patch protocol. They are local
maintenance responsibilities: all three upstream proposals were unmerged at the October 18,
2026 review, and none of the advisories listed an official patched release.

The complete registry audit still reports **two High and one Low** findings. Nothing is
ignored, renamed or assigned an invented fixed version. Local verification is complete for the
recorded scope, and the owner approved experimental source publication on October 18, 2026. These patches do not establish
approval for a shared deployment or replace served-authentication integration.
The [advisory decision record](advisory-release-decision.md) records remaining risks, the confirmed
maintenance assignment, review deadline and explicit owner acceptance.

## Patch inventory

| Package | Source and local change | Regression boundary |
|---|---|---|
| braces 3.0.3 | [Upstream PR 87](https://github.com/micromatch/braces/pull/87), commit `d44b9b1ee12e7804d4232d5a47a4a0c61d2fbefe`; retain its runtime depth/cycle guards | Parser and compile/expand/stringify AST depth are bounded at 100, even if a caller requests 3,000; cyclic parent links fail promptly. Ordinary globs, ranges, parentheses and depth-100 compilation remain valid. |
| node-forge 1.4.0 | [Upstream PR 1152](https://github.com/digitalbazaar/forge/pull/1152), commit `ceba34402e329f0365134f23fe19898756527d65`, plus local rejection of nonempty NULL parameters and noncanonical algorithm OIDs | Validate both DigestInfo and nested DigestAlgorithm child counts; reject ignored NULL bytes and unterminated/nonminimal algorithm OIDs. Canonical identifiers for all nine existing allowed algorithms retain their parameter behavior. |
| elliptic 6.6.1 | [Upstream PR 345](https://github.com/indutny/elliptic/pull/345), commit `99a867dc935324e06498f1acec6b7d70310bd551`; preserve generated nonce octet width before truncation | A deterministic P-521/SHA-512 leading-zero case matches an independent RFC 6979 HMAC calculation and OpenSSL EC multiplication. P-256 deterministic signing and OpenSSL-checked supplied-nonce controls pass. |

The committed patch files are in `portal/.yarn/patches/`; every matching range in
`portal/package.json` resolves through the corresponding patch. Original npm locators remain
in the lockfile as patch inputs. Their presence alone does not mean an installed consumer is
using the unpatched copy: inspect `yarn why --recursive --json <package>` and the installed
consumer paths as well.

Complete source license texts are retained in [third-party licenses](../../third_party/README.md).
The braces and elliptic patches retain MIT terms. Forge offers BSD-3-Clause or GPL-2.0;
this source adaptation uses its BSD option, with the complete upstream license file retained.

## The additional Forge checks

The upstream child-count proposal alone passed 12 of the 13 local regressions. It still
accepted a DigestAlgorithm with two children whose NULL parameter contained nonempty bytes.
The local change also requires captured NULL contents to be empty. A synthetic RSA signature
with that malformed structure reproduced the acceptance; the test is not a claim that a new
end-to-end signature-forgery exploit has been demonstrated.

A follow-up review found another ignored-byte case: `asn1.derToOid` silently drops an unfinished
final base-128 arc and normalizes redundant continuation bytes. The local patch now requires
an allowed algorithm's original OID bytes to equal its canonical DER encoding. Ten added
regressions failed before this check and passed after it, covering four malformed suffixes
and a nonminimal arc, each with absent and present NULL parameters. A compatibility test
retains the complete existing algorithm allowlist; supporting those identifiers is not a
recommendation to choose legacy hashes.

All key material is generated ephemerally by the tests. No deployed credential, saved private
key or customer signature is used. The test keeps valid absent/present-NULL controls alongside
the malformed cases.

## Reproduce and maintain

### Supported upgrade review

The October 18 follow-up checked the live npm registry as well as the advisory metadata.
Latest published Backstage backend-defaults 0.18.0, config-loader 1.11.3 and CLI build module
0.1.8 still introduce the affected packages. Every identified installed consumer resolves to
the corresponding patched copy; this is a graph-specific observation to repeat after updates.

| Finding | Remaining parent paths | Why a forced parent replacement is insufficient |
|---|---|---|
| braces | chokidar 3.6.0 and micromatch 4.0.8 | New chokidar majors change the interface and glob behavior; replacing chokidar alone leaves micromatch's braces dependency. |
| node-forge | backend-defaults directly, and selfsigned 2.4.1 through backend-defaults and the development server | selfsigned 5.5.0 removes Forge but replaces the callback API with a Promise. Backstage uses the old API and also imports Forge directly to parse cached development certificates. |
| elliptic | CLI build → node-stdlib-browser 1.3.1 → crypto-browserify → browserify-sign / create-ecdh | The latest published CLI build module retains the browser polyfill chain. Removing it requires a supported build-tool migration and browser compatibility verification. |

The identified Forge use requires generated development HTTPS certificates; that mode is absent
from the shipped configuration. Config watching still uses braces at runtime with operator-selected
paths. Elliptic's identified dependency path is build tooling. These input boundaries reduce the
identified exposure but do not prove all configurations safe. See [dependency security](../dependency-security.md).

**Disposition: mitigated locally; upstream findings remain open.** The complete audit still fails.
Taylor Dean explicitly accepted the documented risks and maintenance responsibility for
experimental source publication on October 18, 2026. The linked decision records the boundaries
and November 1 review deadline. Supported upstream fixes or parent migrations remain the
preferred replacement for these local patches.

### Commands

From `portal/`, using the pinned Node version:

```bash
yarn install --immutable
node --test scripts/security-tests/*.test.mjs
yarn why --recursive --json braces
yarn why --recursive --json node-forge
yarn why --recursive --json elliptic
yarn npm audit --all --recursive --json
```

The focused new suite reproduced nine failures on stock packages, one remaining failure with
only the upstream patches, and passed all 13 after the NULL extension. The strengthened suite now passes 24 checks,
including the ten OID regressions and full digest-identifier compatibility control. It exercises selected
installed micromatch, Backstage backend-defaults and browserify-sign consumer paths. The
lockfile/resolution review must cover every other installed path too. Full build, browser and
infrastructure verification belongs in the [release record](../release-readiness.md).

On each parent or package update, check whether an official fixed release exists, remove
superseded patches, regenerate the lockfile, and rerun regressions plus the full portal suite.
Do not carry a patch forward merely because it still applies cleanly. Any accepted residual
risk requires a named reviewer, deployment constraints and a review date; that acceptance
is recorded in the linked advisory decision for this experimental source release.
