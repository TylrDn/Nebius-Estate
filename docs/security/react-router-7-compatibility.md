# React Router 7 compatibility patches

The portal selects the published `react-router` and `react-router-dom` 7.18.4 releases.
This is a locally maintained migration: the installed Backstage packages still declare
React Router 6 peer ranges. Preserve those peer warnings; this document does not claim
upstream Backstage support for React Router 7.

The [official migration guide](https://github.com/remix-run/react-router/blob/react-router%407.18.0/docs/upgrading/v6.md)
requires Node 20 and React/React DOM 18. The portal uses Node 22 or 24 and React 18.
The guide describes changes controlled by v6 future flags. Backstage's `plugin-app`
0.5.3 default BrowserRouter sets the splat and transition flags to false; Router 7
enables the new behavior and ignores that obsolete prop. The portal uses absolute
navigation destinations and static page paths, but full browser verification is still
required. Local MemoryRouter tests remove the obsolete flags rather than suppressing
their type errors.

## Retained package patches

Router 7's `generatePath` encodes dynamic parameter values. Both installed Backstage
resolvers already encode selected reserved characters before calling it, producing
double encoding after the upgrade. Each patch limits that pre-encoding to the `*` parameter, allowing Router 7 to encode
raw named parameters exactly once. Router 7 inserts wildcard parameters without
encoding; both public Backstage route-ref constructors accept `*` parameter names.
The patches therefore retain the original reserved-character replacement for wildcard
values, including the original treatment of literal percent signs and spaces. No
package names, versions, peer ranges, license files, or audit configuration are changed
by these patches.

| Original package | Published source changed | Retained patch |
|---|---|---|
| `@backstage/frontend-app-api` 0.16.8 | `dist/routing/RouteResolver.esm.js` | [frontend resolver](../../portal/.yarn/patches/backstage-frontend-app-api-npm-0.16.8-router7.patch) |
| `@backstage/core-app-api` 1.20.5 | `dist/routing/RouteResolver.esm.js` | [legacy resolver](../../portal/.yarn/patches/backstage-core-app-api-npm-1.20.5-router7.patch) |

The source packages are published from the [Backstage repository](https://github.com/backstage/backstage),
under Apache-2.0. Retain the existing [Backstage license](../../third_party/licenses/backstage-LICENSE)
and [notice](../../third_party/licenses/backstage-NOTICE). The patch comments identify
Taylor Dean's modifications. These are local compatibility patches, not upstream security
releases. Their original source maps retain upstream source content and are not regenerated.

SHA-256 of the unmodified published resolver files inspected for these patches:

```text
frontend-app-api 0.16.8  ef7b957ba3217de43827d5c09cd6af165bc0bc219916e38de5c86672395c6fd1
core-app-api 1.20.5      d8b209ec895ea82754922553049f4961c62da02ea2a27a8a4a93d3f9a379daa4
```

Bind these exact-version patches with Yarn's `patch:` protocol and regenerate the
lockfile in the pinned CI container. Keep both resolvers patched while these Backstage
versions consume Router 7. On any parent upgrade, compare the newly published resolver
and rerun the regression tests before retaining or removing a patch. Reverting Router 7
also requires removing both patches, since Router 6 needs the old reserved-character
handling.

## Evidence and required verification

The [upstream URL-normalization change](https://github.com/remix-run/react-router/pull/15176)
supplies the mixed-separator regression inputs in `router-security.test.tsx`. Hosted
run 39072319489 demonstrated six failures and three passes against Router 6. Hosted
run 39072495451 passed all nine tests on Router 7 before these compatibility patches.

The same Router 7 run executed the actual published modern and legacy resolvers through
`router-compatibility.test.ts`. Both reserved-character cases failed with double encoding;
the six ordinary-ID, literal-percent and space cases passed. The fixtures explicitly
expect `/resources/a%2Fb%3Fc%26d%23e%3Bf` for `a/b?c&d#e;f`, rather than deriving the
expected result from the implementation. The tests deliberately locate internal published
modules through exported package metadata; a changed package layout must fail visibly.

Eight additional tests exercise both actual resolvers with wildcard parameters: ordinary
IDs, reserved characters, literal percent escapes, and spaces. These protect the old
wildcard behavior while named parameters adopt Router 7 encoding.

All 15 installed-dependency, nine navigation-security and 16 resolver regressions
passed against the generated 7.18.0 graph in
run 39072752183 (private development CI; not publicly accessible).
Its complete audit also identified [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2),
an RSC advisory affecting 7.18.0 and patched in 7.18.2. The final selection is
7.18.4, the latest published 7.x patch reviewed, which also includes the later
URL-validation and RSC redirect-escaping fixes. See the
[upstream changelog](https://github.com/remix-run/react-router/blob/react-router%407.18.4/CHANGELOG.md).
The portal does not enable RSC; that observation does not remove the audit finding
or justify retaining an affected version.

The regenerated 7.18.4 graph in
run 39072928717 (private development CI; not publicly accessible)
passes all 15 installed-dependency and 16 resolver tests. Its recursive audit reports
only the three unpatched packages described in [dependency security](../dependency-security.md).
The newer navigation validator rejects all four malformed destinations with
`External navigation is not allowed`, leaving the original route unchanged; the older
navigation fixture expected normalization and failed. The final navigation regression
requires that rejection and unchanged route, retains the four `resolvePath` expectations,
and includes a valid internal navigation case. This preserves the stricter upstream
security behavior rather than adapting the dependency to accept malformed targets.

Post-patch CI must pass both focused suites, immutable installation, full typechecking,
the portal unit suite, production build, and all browser checks. The focused
splat test complements the real Backstage app browser suite; it does not prove the whole
framework compatible. Keep the complete recursive dependency audit and all required checks
unchanged. The final source baseline passed 397 browser checks and the compatibility suites; the
[verification record](../release-readiness.md) records the exact baseline and the limits of
publication edits that have not received another full container run.
