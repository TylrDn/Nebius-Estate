# Material-table UUID compatibility patch

The portal retains `@material-table/core` 3.2.5 while updating the existing UUID
dependency to 11.1.1. UUID versions below 11.1.1 are affected by
[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), which
describes missing output-buffer bounds checks in UUID v3, v5 and v6 functions.
The table itself calls UUID v4; its change is compatibility work that enables
the patched UUID release throughout the graph.

## Source and retained license

- Package: [`@material-table/core` 3.2.5 registry metadata](https://registry.npmjs.org/@material-table/core/3.2.5).
- Published archive: `https://registry.npmjs.org/@material-table/core/-/core-3.2.5.tgz`.
- Upstream source: [`src/utils/data-manager.js` at v3.2.5](https://github.com/material-table-core/core/blob/v3.2.5/src/utils/data-manager.js).
- Published runtime file: `dist/utils/data-manager.js`. The package publishes
  `dist/` and `types/`, so there is no separate shipped ESM or source file to patch.
- License: MIT, copyright 2018 Mehmet Baran; retained in
  [`third_party/licenses/material-table-core-LICENSE`](../third_party/licenses/material-table-core-LICENSE).

The inspected original published runtime file has SHA-256
`7e7aac36c6970656e49d8ea0da661b62bc11c6cfa86ac793098c59309189ab07`.
The Yarn patch is a local modification by Taylor Dean. It uses the named `v4`
export instead of relying on a default export, matching the API exported by
UUID 11.1.1. The equivalent upstream source change is `import { v4 } from 'uuid'`
and a call to `v4()`; the committed patch modifies the distributed CommonJS
file that consumers actually load.

Patch artifact:
[`portal/.yarn/patches/@material-table-core-npm-3.2.5-uuid-named-export.patch`](../portal/.yarn/patches/@material-table-core-npm-3.2.5-uuid-named-export.patch).

## Verification and removal

Run the installed-dependency compatibility tests inside the pinned Node
container after applying the Yarn resolution and regenerating the lockfile:

```sh
cd portal
node --test scripts/security-tests/uuid-compatibility.test.mjs
```

These load the actual table DataManager and its resolved UUID dependency. They
check generated row keys, identity and selection across data refresh, existing
row keys, the CommonJS v4 contract, and valid/invalid v3/v5/v6 output-buffer
bounds. The tests belong to the installed-dependency job, rather than the
dependency-free script checks. Immutable installation, the full portal test
suite, typecheck, build, browser tests and complete recursive audit must also
pass on the final candidate commit. These instructions are not a claim that
verification has passed.

The tests were first run with UUID 11.1.1 and the unpatched table in hosted
run 39072319489, job 117512296013 (private development CI; not publicly accessible).
Both generated-row tests failed at the table's default UUID import with
`Cannot read properties of undefined (reading 'v4')`; the v4 and v3/v5/v6 bounds
tests passed. This establishes the compatibility failure before the patch;
green validation of the final graph is still required.

Remove the patch when the supported Backstage table dependency uses named UUID
exports with a patched UUID release. Recheck the actual distributed entry point
and keep the consumer regression tests when replacing the table parent.
