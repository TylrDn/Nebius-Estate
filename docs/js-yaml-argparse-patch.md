# js-yaml 3 CLI compatibility with argparse 2

The scoped argparse 1-to-2 resolution removes the sole `sprintf-js` consumer
without changing js-yaml 3's YAML parser or schema APIs. The deprecated
argparse constructor `version` option needs a small compatibility correction:
argparse 2 registers its version action with `version: this.version` but never
assigns that property from the supplied constructor option. Its action then
prints an undefined value and exits successfully. This explains the observed
empty standard output; moving the assertion to standard error would not fix it.

The patch removes that constructor option and registers `-v`/`--version` with
the supported `add_argument` version action and the explicit package version.
All other CLI options and parser code remain as published.

## Provenance and license

- Original package: `js-yaml` 3.15.2.
- Published archive: `https://registry.npmjs.org/js-yaml/-/js-yaml-3.15.2.tgz`.
- Upstream source: [`bin/js-yaml.js` at 3.15.2](https://github.com/nodeca/js-yaml/blob/3.15.2/bin/js-yaml.js).
- Compatibility implementation inspected: [`argparse` 2.0.1](https://github.com/nodeca/argparse/blob/2.0.1/argparse.js).
- Local modification: Taylor Dean; only the distributed `bin/js-yaml.js` is patched.
- Artifact: [`js-yaml-npm-3.15.2-argparse-version.patch`](../portal/.yarn/patches/js-yaml-npm-3.15.2-argparse-version.patch).
- License: MIT, copyright 2011-2015 Vitaly Puzrin; retained unchanged in
  [`third_party/licenses/js-yaml-LICENSE`](../third_party/licenses/js-yaml-LICENSE).

## Validation

The installed-dependency compatibility test first failed in hosted
run 39072319489, job 117512296013 (private development CI; not publicly accessible):
`--version` exited zero with empty standard output. The help, input conversion
and error behavior checks passed. The existing version-output assertion remains
required. After installing the patched dependency graph in the pinned Node
container, run:

```sh
cd portal
node --test scripts/security-tests/dependency-compatibility.test.mjs
```

Also retain immutable installation, full portal validation and the complete
recursive audit. The successful pre-patch checks and source inspection do not
establish post-patch success. Remove this patch when a supported js-yaml parent
uses argparse 2's explicit version action itself.
