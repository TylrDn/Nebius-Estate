# Nebius Estate — development

## Requirements

| Tool | Version | Note |
|---|---|---|
| Node.js | 24 (`portal/.nvmrc`; 22 also works) | Backstage 1.55 refuses Node 25+. The production image pins `node:24.21.0-trixie-slim` by digest |
| Yarn | any `yarn` on PATH (Node 24 ships corepack: `corepack enable`) | the repository pins Yarn 4.13.0 through `.yarn/releases` |
| Python 3 | for `better-sqlite3`'s build fallback | |
| Terraform | optional | one domain test runs generated patches through `terraform fmt` when it is on PATH |
| Docker | optional for the native demo; required for pinned release verification | also used for `docker-compose.yaml` (PostgreSQL) and the production image (`packages/backend/Dockerfile`) |

## Commands

```bash
make portal-install     # yarn install --immutable; run before doctor on a fresh clone
make doctor             # read-only prerequisites; no installs, daemon probes or cloud calls
make portal-demo        # isolated synthetic estate at :3100/:7107/:7199; no credentials
make portal-dev         # local run: http://localhost:3000 (backend on 127.0.0.1:7007), hot reload
make portal-test        # unit + integration tests (Jest, all packages)
make portal-e2e         # Playwright + axe against the Nebius REST stub, on :3100/:7107 (yarn --cwd portal playwright install chromium)
make portal-build       # typecheck, lint, config schema check, production build of app and backend
```

Inside `portal/`: `yarn start` (loads `app-config.yaml` + `app-config.local.yaml`, then the git-ignored
`app-config.private.yaml` when it exists, through `scripts/backstage-config.mjs`, which never passes an empty argument and never requires the overlay — see [nebius-setup](nebius-setup.md#private-overlay); load the repository
`.env` first with `set -a; source ../.env; set +a`), `yarn tsc`, `yarn lint:all`, `yarn config:check`
(the local files, including `app-config.private.yaml` when present, and the production files against the config schemas),
`CI=1 yarn test:all`, `yarn build:all`, `yarn playwright test`, and `yarn verify:live` (read-only
probe of every capability against the account in the environment; never in CI). CI runs install,
tsc, lint, config check, unit tests and build in `node:24.21.0-trixie-slim`; the Playwright suite
defines the full synthetic browser/accessibility suite in four shards; it is also available
locally with `make portal-e2e`. Repository Actions may be disabled during private release review;
see the [verification record](../release-readiness.md) for actual results.

`node portal/scripts/doctor.mjs` works before installing dependencies. It reports the current Node
runtime and architecture, PATH tools, dependency presence, fixed demo ports and cached Chromium.
It does not install anything, query a Docker daemon or call a cloud API. Docker and Chromium are optional by default; use `node portal/scripts/doctor.mjs --full`
from the repository root to make those prerequisites affect the exit status too. Cache
presence does not establish browser launchability; Playwright verifies that in the browser job.

`yarn demo` invokes `scripts/demo.mjs`, reused by Playwright. It explicitly loads only base, local
and synthetic config; private overlays are excluded. Child environments discard operator credentials,
`APP_CONFIG_*`, proxies and runtime injection, and get a temporary HOME removed on shutdown.
The stub starts first; app and backend readiness (including the first inventory sync) must succeed
within 180 seconds. Port conflicts, startup failures, signals and later service exits stop both
process groups, with a bounded TERM/KILL sequence. POSIX Node 22/24 is supported (24 recommended).
The frontend compiles locally; no startup duration or real cloud performance is implied.
Run the stdlib lifecycle and doctor regressions with `yarn test:scripts` in the Node container.

Every run is meant to be clean, not to pass eventually:

- Playwright runs with no retries (a test that passes only on retry is a bug). Its `globalSetup`
  (`e2e-stub/wait-ready.mjs`) holds the tests until the backend's readiness endpoint answers, which
  with `waitForFirstSync` is after the first sync; the webServer URL covers the app only, and tests
  that started earlier saw "Portal backend unreachable".
- Backend tests that call `startTestBackend` pass `testDatabase()` (`src/__testUtils__/testing.ts`):
  Backstage's database service never destroys SQLite clients on shutdown, so the default factory
  left a pool timer per backend and Jest force-exited the worker.
- Stopping a backend ends its sync: `InventoryService.stop()` (the plugin's shutdown hook) aborts the running
  sync's calls, cuts its connect-retry back-off short and waits for it, and a run cut short is not recorded. A test
  that builds an `InventoryService` itself awaits `stop()` before destroying its database. Before this, a test
  backend stopped mid-sync kept retrying for up to 30 s and then wrote to the database its test had destroyed;
  the rejection failed whichever test the Jest worker ran next, with an empty message (about one full run in three
  with `--maxWorkers=2`). `src/inventory/shutdown.test.ts` reproduces it.
- `yarn verify:live` stops its service and database after the run; it needs no `--forceExit`.
- `yarn install --immutable` prints peer-dependency notices (YN0002, YN0060, YN0086). They come from
  the Backstage packages themselves (`@material-ui/core` v4 asks for React 16/17 while Backstage runs
  18; `@backstage/cli`, `@backstage/core-components` and `@axe-core/playwright` ask each workspace for
  `jest`, `@types/react` and `playwright-core`, which are installed once at the `portal/` root) and
  are the same in a fresh Backstage app. They are left as they are; no resolution overrides.

Known console warning (development builds only): opening a repository document (Evidence, Solutions, a runbook
link) logs React's "findDOMNode is deprecated" once its Markdown links mount. It is upstream, not portal code:
Backstage `MarkdownContent` (`@backstage/core-components` 0.18.14) renders every Markdown link through the MUI v4
`Link`, whose `useIsFocusVisible` ref callback calls `ReactDOM.findDOMNode`
(`@material-ui/core` 4.12.4, `esm/utils/useIsFocusVisible.js`). `MarkdownContent` takes no component overrides, and
MUI v4 is end of life, so it goes when Backstage moves `MarkdownContent` off MUI v4; production builds print no
React warnings.

## Dependency choices

| Choice | Why |
|---|---|
| Backstage 1.55 (release 1.55.3), new frontend and backend systems | latest stable at scaffold time and at least two weeks old; 1.55.3 (2026-10-12 check) changes only packages the portal does not use (techdocs, the yarn CLI module, already resolved at 0.1.2), so the lockfile is unchanged |
| `@yarnpkg/core` resolution pinned to 4.9.1 | 4.9.2 on npm references a patch file that was never published |
| better-sqlite3 files (local), PostgreSQL (served) | Backstage defaults; nothing else to run |
| `zod` (already a Backstage dependency) | every request body, query and import is validated |
| Hand-written SVG charts and graph | no charting dependency; every chart has a text alternative |
| Plain `fetch` against the documented Nebius REST paths | no SDK or CLI shell-out; `@nebius/js-sdk` would be a contained swap in `inventory/nebius.ts` |

## Workspaces

| Workspace | Role |
|---|---|
| `packages/app` | Backstage app: nav, themes, layout, sign-in |
| `packages/backend` | Backstage backend and `NebiusRolePolicy` |
| `packages/nebius-domain` | Pure logic and the HTTP contracts (`api.ts`), shared by both sides |
| `plugins/nebius-estate` | Every page; design system, API hooks and global filter in `src/ui/`; Costs and Commercial in `src/commercial/` |
| `plugins/nebius-estate-backend` | Every route; connectors, stores, `src/commercial/`, and config/access/HTTP in `src/lib/`; `migrations/`; `config.d.ts` |

## Layout and conventions

- Business logic goes in `packages/nebius-domain` (pure, isomorphic, with tests next to it). Plugins
  call it; they do not reimplement it.
- Response types go in `nebius-domain/src/api.ts` and are used by the route and the page.
- Backend-only shared code (config, access and scope, outbound HTTP, `parse()`) lives in
  `plugins/nebius-estate-backend/src/lib`. A new table is a new knex migration, never a `createTable`
  at start-up.
- UI building blocks and the global filter live in `plugins/nebius-estate/src/ui`. Pages use the `ne-*`
  classes and tokens in `styles.css`; no inline colours.
- Every new route: authorize a `nebius.*` permission, apply the caller's scope, validate input with
  `parse()` and zod, and audit any write.
- Every new metric: return a `SourcedMetric`, using `null` and a reason when the source is absent.
- Style is enforced by `yarn lint:all` (ESLint), not Prettier: the code is hand-formatted, and the
  template's `prettier:check` script was removed because it never passed and no gate ran it. Adopting
  Prettier means one reformat-only commit plus a CI step.

## Test data

`portal/e2e-stub/` holds the synthetic demo and test fixtures; a production deployment never loads it:
- `stubApi.js`: the stub's routing in the documented shapes — every catalog list (paginated,
  `items` or `clusters`), projects by id, the tenant listing and tenant-level lists refused (403),
  pricing policies rejected (400), Monitoring PromQL, and the billing calculator (contract price
  refused) — shared by the unit tests (mocked `fetch`) and `nebius-stub.mjs` (`127.0.0.1:7199`);
- `estate.json`: the invented estate (`e00mock` ids; one project refused on VPC and storage; values
  marked `never-copied-stub-value` that must never appear in any output);
- `app-config.e2e.yaml`, `focus.csv`, `ratebook.json` (XTS prices) and `scenarios.json`.

A backend whose configuration points any Nebius endpoint at a test endpoint (`testEndpointKeys` in
`lib/config.ts`: the API, Monitoring, Logging, Audit, the MK8s test endpoint or the export bucket endpoint)
reports it in `GET /meta` (`testData`), and every page then shows "Test data — not your tenant" at the top of its
header, with a "Test data" mark in the navigation that stays on screen. A live configuration has no `testData`
and shows neither.

`plugins/nebius-estate-backend/src/inventory/apiContracts.ts` is extracted from the Nebius
`openapi.json` (list keys and status enums); regenerate it when the API version changes.

## Tests

| Suite | Where | What |
|---|---|---|
| Domain | `packages/nebius-domain/src/*.test.ts` | decimal maths; connector state and plain-word API errors; money; units; bundled-charge double counting; missing, expired and currency-mismatched rates; discounts; commitments; sensitivity; FOCUS parsing, dedupe, per-project supersession, credits and taxes, Tags parsing and the label-source fallback; repo schema parsing against the real `platform/*.yaml` and tfvars; tfvars patching and diff; provisioning validation, injection and the estimate scenario; capacity arithmetic matching `docs/capacity.md`; `terraform fmt` round-trip |
| Backend library | `plugins/nebius-estate-backend/src/lib/lib.test.ts` | origin allowlist, retries and backoff, timeouts, pagination, concurrency, redaction, fail-closed config (guest, development roles and the test endpoint only on loopback; projects from the environment), budgets, the committed local, production and e2e config files, project scope |
| Backend routes | `plugins/nebius-estate-backend/src/router.test.ts` | permissions per route, telemetry gating, project scoping (including connector statuses), traversal, missing documents, input validation, provisioning concurrency, server-side policy and estimate (409 until a rate book exists), recipe list, connector states from the mocked REST API, an unconfigured start |
| Commercial routes | `plugins/nebius-estate-backend/src/commercial/router.test.ts` | scoped and SQL-filtered billing and import lists, permission gating (before the upload is read), re-import without double counting, project-scoped supersession, import validation and limits, id validation, estimates and quotes on the portal clock, rate-book validation, default rate book |
| Views | `plugins/nebius-estate-backend/src/views.test.ts` | Kubernetes and telemetry scoping through MK8s ids; masked project ids |
| Capabilities | `plugins/nebius-estate-backend/src/inventory/capabilities.test.ts` | the full catalog against the stub (states, relations, tenant refusals with hints), secrets never copied, schema drift, 429 retry, timeouts, 404, method and origin guards, per-host concurrency, Monitoring per GPU and per project, calculator list/contract fallback, cache and unpriced lines, last good data kept, running-sync state, the 9-project speed budget |
| Health | `plugins/nebius-estate-backend/src/health/health.test.ts` | success rate, p50/p95, failure streaks, retention |
| Stores and connectors | `plugins/nebius-estate-backend/src/{database,provisioning/store,inventory/connectors}.test.ts` | migrations on SQLite, compare-and-set transitions, connector contracts, token exchange, Kubernetes mapping, the repository model (network and data roots, missing recipe READMEs), evidence classification |
| Fleet, alerts, logs | `packages/nebius-domain/src/{telemetry,alerts,logs}.test.ts`, `plugins/nebius-estate-backend/src/{telemetry,alerts}/*.test.ts`, `src/operate.test.ts` | roll-ups and buckets (unobserved is null), sample-store retention, merge and size bound, query_range back-fill after downtime; rule parsing, metric classification, `for:` pending → firing → resolved (and from history), a failed query never resolves, every portal signal against fixtures; **every rule's runbook section and docs.nebius.com anchor exist**; LogQL validation, "no logs yet" buckets; routes with permissions and project scope |
| Policy | `packages/backend/src/permissionPolicy.test.ts` | default deny, role grants |
| UI | `plugins/nebius-estate/src/{ui/components,pages}/*.test.ts(x)` | Unavailable is never zero; sortable and keyboard tables; drawer focus and Escape; formatting; axis rounding; trend gaps; document-viewer links |
| End to end | `packages/app/e2e-tests/{portal,operate,budgets-ai,solutions-budgets,one-number,capacity-overview,capacity-cards,pricing-tables,owner-review,inventory-workloads,proof-evidence,overview-integrations}.test.ts` | every page in dark and light themes with axe (WCAG 2.1 A/AA) and at 390 px without horizontal overflow, navigation, filters in the URL across pages, graph expand/collapse, explorer drawer, refresh and trends, provisioning flow, FOCUS and rate-book imports through the UI, costs, recipe list (R1–R16), the Solutions page (Read, Mermaid caption, Price this footprint through the stub calculator), recipes without a form, budgets in one place (config budgets read-only), a refused list call on Integrations, missing documents, keyboard-reachable imports; one number, one name across pages (GPU utilisation and its window, spend excl. tax and credits, durations, the near-limit quota count, project names); Capacity, Overview and Integrations reconciled and compact (a reservation in use but not listed, tenant use against a limit of 0, one-line node-group badges, reference sections folded, a partial connector without raw errors, the Overview's first tiles above the fold at 390 px); pricing, costs, tables and layout (scenario pickers, an empty footprint at 0, a shared live-price reason said once, cost metrics in words and the range in force, the "N more rows below" cue, the graph fitted to its box with regions per project and no status on containers, Solutions as its own page, the log list sized to its lines, the nav groups and order); Capacity cards (`capacity-cards`: the effective limit and "capped by project", the GPU-cluster dependency badge, "Usable by K8s recipes", a GB300 card, quota search over every row, the Reservations empty state's links, history days recorded incompletely, the availability selects and allowance rows at 390 px); inventory, Fleet, Workloads and AI services (`inventory-workloads`: a failed Job in red with its reason, requests and limits summed in Kubernetes units, namespaces and node state (NotReady, cordoned), the Soperator card only with a Soperator cluster in scope, registries and MLflow on AI services with Explorer links, a deleted node group named instead of linked in the Fleet drawer, a disk sized in bytes priced and a size-less disk named unpriced, as-of times on empty and status-only states, tile ages that never break, service cards at their own height); proof from evidence (`proof-evidence`: each Solution's derived proof line and per-recipe chips with the last live date, a drift banner when a README row disagrees, recipe cards that lead with their own runs and say their last live run, evidence dates kept on one line, runbook summaries in prose, Evidence and Solutions fallbacks); Overview and Integrations (`overview-integrations`: every connector count a filter that lists that many, one connector's failed sync as one incident of that connector, optional and not-needed connectors folded as not applicable, one Fix link per Unavailable opened by a click test, project-cap rows with the project and the acknowledge hint, the phone attention list and no fold on a wide screen, the phone header's Filters control and one-sentence intro, the billing pull's last import as a note, the capability matrix inside its card, the Nebius docs page and coverage against the docs catalog); the owner review (`owner-review`: the test-data banner on the 404 route, the graph's Collapse and node clicks, ids and log lines wrapped on a phone, a sort select for stacked tables and no hidden focusable header, folded Evidence and Integrations, one connector wording, a range-scoped Costs data tile, one number format on every page, labels told apart) |

## Licences

Repository-authored custom portal code is licensed under [Apache-2.0](../../LICENSE).
Preserved upstream notices and modification attribution are recorded in the root [NOTICE](../../NOTICE),
[portal NOTICE](../../portal/NOTICE.md) and [source provenance inventory](../source-provenance.md).
Third-party code retains its own terms; see [third-party inventory](../../third_party/README.md)
and the retained license files under `third_party/licenses/`. Installed packages and built images
also carry their own notices; source attribution does not claim redistribution review of every artifact.
