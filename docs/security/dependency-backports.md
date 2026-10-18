# Local dependency security backports

These source patches address reproduced failure cases in the locked dependency graph.
They preserve the published package versions and use Yarn's patch protocol. They are local
maintenance responsibilities: all three upstream proposals were unmerged at the October 18,
2026 review, and none of the advisories listed an official patched release.

The complete registry audit still reports **two High and one Low** findings. Nothing is
ignored, renamed or assigned an invented fixed version. Keep the repository private until
final verification and advisory disposition are complete. These patches do not establish
approval for a shared deployment or replace served-authentication integration.

## Patch inventory

| Package | Source and local change | Regression boundary |
|---|---|---|
| braces 3.0.3 | [Upstream PR 87](https://github.com/micromatch/braces/pull/87), commit `d44b9b1ee12e7804d4232d5a47a4a0c61d2fbefe`; retain its runtime depth/cycle guards | Parser and compile/expand/stringify AST depth are bounded at 100, even if a caller requests 3,000; cyclic parent links fail promptly. Ordinary globs, ranges, parentheses and depth-100 compilation remain valid. |
| node-forge 1.4.0 | [Upstream PR 1152](https://github.com/digitalbazaar/forge/pull/1152), commit `ceba34402e329f0365134f23fe19898756527d65`, plus local rejection of nonempty NULL parameters | Validate both DigestInfo and nested DigestAlgorithm child counts; reject ignored bytes inside a NULL parameter. SHA-256 signatures with absent or empty NULL parameters still verify. |
| elliptic 6.6.1 | [Upstream PR 345](https://github.com/indutny/elliptic/pull/345), commit `99a867dc935324e06498f1acec6b7d70310bd551`; preserve generated nonce octet width before truncation | A deterministic P-521/SHA-512 leading-zero case matches an independent RFC 6979 HMAC calculation and OpenSSL EC multiplication. P-256 deterministic signing and OpenSSL-checked supplied-nonce controls pass. |

The committed patch files are in `portal/.yarn/patches/`; every matching range in
`portal/package.json` resolves through the corresponding patch. Original npm locators remain
in the lockfile as patch inputs. Their presence alone does not mean an installed consumer is
using the unpatched copy: inspect `yarn why --recursive --json <package>` and the installed
consumer paths as well.

Complete source license texts are retained in [third-party licenses](../../third_party/README.md).
The braces and elliptic patches retain MIT terms. Forge offers BSD-3-Clause or GPL-2.0;
this source adaptation uses its BSD option, with the complete upstream license file retained.

## The additional Forge check

The upstream child-count proposal alone passed 12 of the 13 local regressions. It still
accepted a DigestAlgorithm with two children whose NULL parameter contained nonempty bytes.
The local change also requires captured NULL contents to be empty. A synthetic RSA signature
with that malformed structure reproduced the acceptance; the test is not a claim that a new
end-to-end signature-forgery exploit has been demonstrated.

All key material is generated ephemerally by the tests. No deployed credential, saved private
key or customer signature is used. The test keeps valid absent/present-NULL controls alongside
the malformed cases.

## Reproduce and maintain

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
only the upstream patches, and passed all 13 after the Forge extension. It exercises selected
installed micromatch, Backstage backend-defaults and browserify-sign consumer paths. The
lockfile/resolution review must cover every other installed path too. Full build, browser and
infrastructure verification belongs in the [release record](../release-readiness.md).

On each parent or package update, check whether an official fixed release exists, remove
superseded patches, regenerate the lockfile, and rerun regressions plus the full portal suite.
Do not carry a patch forward merely because it still applies cleanly. Any accepted residual
risk requires a named reviewer, deployment constraints and a review date; that acceptance
has not been recorded here.
