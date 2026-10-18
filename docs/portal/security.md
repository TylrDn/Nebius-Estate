# Nebius Estate — security

The portal reads and explains. It never applies, deletes, scales or provisions anything, and it never
weakens the repository's own gates: CI, plan-time stage policy, saved-plan review, `tf-run.sh`, the
disabled pipeline, and one reconciler per resource.

## Boundaries

| Boundary | How it is enforced | Test |
|---|---|---|
| No cloud writes | The HTTP client refuses every method but GET unless the exact path is allowlisted: the token exchange (`https://sts.nebius.com/oauth2/token/exchange`) and the billing calculator's estimate, which prices a would-be create request and creates nothing. Origins: `api.nebius.cloud`, `read.monitoring.api.nebius.cloud`, `sts.nebius.com`; the billing export pull only `storage.<region>.nebius.cloud` (region from config), GET only, SigV4-signed | `capabilities.test.ts` (method and origin guards), `connectors.test.ts` |
| Secrets never copied | Mappers keep named fields only: secrets are listed by metadata; Serverless specs keep platform, preset and backing VMs (never env vars, auth tokens or registry credentials); managed-service passwords are never read | `capabilities.test.ts` (stub values that must never appear in any output) |
| No terraform, shell, workflow dispatch or pull requests | No code path runs a process or calls a code host. Provisioning returns a diff and a text run sheet; people open the pull request themselves | code review; `router.test.ts` checks the repository file is untouched |
| No arbitrary file reads or writes | `RepoReader` reads only allowlisted relative paths (2 MB cap), resolves symlinks, and stays inside the repository root. Nothing writes to the repository. In the document viewer and an alert's runbook section, links in rendered Markdown keep only `http(s)` and `mailto` schemes; an alert's docs link is shown as a link only when it is `https` (`docsLink`) | `connectors.test.ts` (symlink escape), `router.test.ts` (`../`, `.git`, `backend.hcl`, absolute paths), `EvidencePage.test.ts`, `alerts/model.test.ts` |
| Provisioning targets fixed | Sizing paths come from a fixed `(recipe, stage)` map. Stage, region, owner and request reference are regex-validated. tfvars edits are single-line scalars with a restricted character set; complex values are refused | `provisioning.test.ts`, `repo.test.ts` |
| Concurrent edits | Each request stores the sha256 of the file it was previewed against (409 when stale). Only one open request per sizing file (409). State changes are compare-and-set (409 when the state changed meanwhile) | `router.test.ts`, `provisioning/store.test.ts` |
| Backend-enforced permissions | Every route authorizes one `nebius.*` permission. `NebiusRolePolicy` default-denies `nebius.*` unless a configured role grants it | `router.test.ts`, `permissionPolicy.test.ts` |
| Project scoping | `scopeFor(roles, user and ownership refs)` filters resources, Kubernetes clusters (through their MK8s id), telemetry, billing rows (in the SQL query), billing imports (by the projects each import carried), budgets and alerts before any response. Connector scopes, errors and coverage notes show a restricted caller only its own project ids; discovered cluster connectors and tenant quota allowances are shown only with their projects / to unrestricted callers | `router.test.ts`, `commercial/router.test.ts` |
| Billing import scope | A row's project is `x_ProjectId`, else `x_ContainerId`; the scope check, reports and the supersession slot (billing account × that project × hour, `billingSlot`) all use that one id. A row whose `x_ProjectId` and `x_ContainerId` both exist and disagree is rejected with the reason; a project-scoped importer is refused (403) unless both columns of every row are in its scope. So it can only import, and only supersede, its own projects' rows. The migration `20261011030000_billing_slot_by_project` re-derives stored slots the same way | `commercial/router.test.ts` (the cross-project supersession proof of concept), `billing.test.ts`, `commercial/store.test.ts` |
| Budgets scope | A project-scoped caller sees, and through `/budgets/signals` is alerted about, only budgets whose project conditions are all in its scope; account-wide budgets, credits and Token Factory spend entries (no project) only reach unrestricted callers. Writes (`nebius.billing.budget.write`) from a project-scoped caller must name only projects in its scope (403); account-wide items, credits and spend entries need every project; another project's budget answers 404 to update or delete. The alert engine evaluates every budget (account-wide); only the API is scoped | `budgets/budgets.test.ts` |
| Alerts scope | `/alerts` and `/alerts/:id` return only alerts of projects in scope (tenant-level alerts only to unrestricted callers). Rule statuses are rewritten per caller: out-of-scope project ids and names in their reasons are masked (`scopeRuleStatuses` with `maskProjects`), and firing / pending counts are computed from the caller's alerts | `alerts/engine.test.ts`, `operate.test.ts` |
| Kubernetes access | Discovered MK8s clusters are read with the portal's Nebius IAM token, which the cluster maps to group `nebius:viewer` (verified live: lists answer; secrets, `services/proxy` and writes are refused). Explicit clusters use a read-only token from an environment variable. GET only | `inventory/mk8s.test.ts` |
| Credentials only on the backend | Environment-variable *names* in config (`config.d.ts`: backend visibility); values read at call time. The browser holds only the Backstage user token. The export bucket's access key signs requests in the backend and never appears in logs, errors or responses | `lib/config.ts` validation |
| No secrets in logs or errors | `redact()` strips bearer tokens, JWTs, private keys, `secret`/`password`/`token` pairs, the S3 error-body fields that echo the signing input (`AWSAccessKeyId`, `StringToSign`, `StringToSignBytes`, `SignatureProvided`, `CanonicalRequest`, `CanonicalRequestBytes`, `Signature`) and SigV4 `Credential=`/`Signature=` values; URLs in errors are reduced to origin and path | `lib/lib.test.ts` (including a SignatureDoesNotMatch body) |
| SSRF | Outbound URLs are built from configuration only, except discovered MK8s control planes: those come from the MK8s API and are accepted only as `https://…mk8s.<region>.nebius.cloud:443` in the project's region, with the cluster CA from the same API pinned per cluster; never from a request. Each connector has an origin allowlist; userinfo is refused, redirects are errors, https is required (except `http://localhost` for a port-forwarded Prometheus). Every request sends an explicit `User-Agent: nebius-estate/<version>` | `lib/lib.test.ts`, `inventory/mk8s.test.ts` |
| Bounded connectors | Per host: ≤ 12 requests in flight (configurable up to 16) and ≥ 20 ms between starts (configurable); timeouts, retry cap with backoff honouring `Retry-After`, page cap, 50 MB response cap for Kubernetes, 32 MB for Nebius Monitoring and Logs (declared or streamed; a larger answer is an error naming the limit); billing export: ≤ 50 files per sync, each file and its gunzipped content ≤ `billing.maxImportBytes`. One sync at a time ("Sync now" during one: 409); within a minute of the last attempt it is not repeated; the service-account token is reused until near expiry | `lib/lib.test.ts`, `capabilities.test.ts` |
| Bounded storage and memory | Billing: superseded rows are deleted in the import's transaction (only active rows are stored; each import keeps its summary and audit event). GPU sample store: at most `MAX_TRACKED_GPUS` (2048) series seen in the 7-day sample window; when full, a new GPU evicts the series seen longest ago (never one of the same write); minutes kept 7 days, hours 90. GPU history back-fill reads and writes 6-hour windows per project, never 7 days at once. `/fleet` reads 7 d from the hourly roll-ups and 1 h / 6 h / 24 h downsampled in SQL (one row per GPU and bucket, ≤ 96 per GPU) | `commercial/store.test.ts`, `billing/export.test.ts`, `telemetry/telemetry.test.ts` |
| Live-price throttle | Calculator-backed routes, including live estimates, quotes and list-book previews, share one token bucket per user: 30 at once, then one per second; beyond that 429 with `Retry-After`. Fleet's optional idle cost uses the same bucket but preserves telemetry with an unpriced reason when exhausted. Stored-book estimates do not consume calculator tokens. Calculator answers are cached per offer × spec for `pricing.cacheMinutes` in an LRU of at most 2000 entries | `router.test.ts`, `commercial/router.test.ts`, `operate.test.ts`, `lib/limits.test.ts` |
| Honest failure | Every call has its own state (permission-denied with the role to grant, not-found, rejected, unreachable, schema-drift); failed lists keep their last good data marked stale; responses are checked against the documented contract | `capabilities.test.ts` |
| Bounded input | JSON bodies are parsed per route, each with its own limit: ≤ 2 MB on the estate, provisioning and commercial routes (rate books, scenarios, estimates, footprints); ≤ 64 KB on budget writes and alert notes. Footprint node-group `platform` and `preset` ≤ 64 characters. FOCUS uploads ≤ `billing.maxImportBytes` (default 25 MB, max 200 MB), read only after `nebius.billing.import` is authorized; ≤ 512 columns and 2 M rows. Every id, path and query parameter is checked by a zod schema (400 otherwise) | `commercial/router.test.ts` (100 KB rate book accepted, > 2 MB refused), `operate.test.ts` (> 64 KB refused), `router.test.ts`, `pricing.test.ts` |
| Browser boundary | Served template sets CSP `connect-src 'self'` and grants no cross-origin API access. No `backend.auth.keys` or external access tokens are configured. A working served identity flow still requires the integration below | `app-config.production.yaml`; [identity](#identity) |
| Audit | `auditor.createEvent` for: billing import, rate-book write, scenario write/delete, provisioning request create/withdraw/transition, integration sync, budget / credit / spend-entry create/update/delete, alert acknowledge/mute and their removal | `audited()` in `lib/access.ts` |
| No raw state | No route reads Terraform state, plans or `backend.hcl` (none is allowlisted) | `router.test.ts` |
| Confidential price books | Stored in the portal database only, never in git. Reads need `nebius.commercial.rate.read`; writes need `…rate.write` and are audited | `commercial/router.test.ts` |

## Permissions

| Permission | Grants |
|---|---|
| `nebius.estate.read` | inventory, graph, capacity, workloads, repository model, evidence, integrations |
| `nebius.telemetry.read` | GPU utilisation (otherwise shown as unavailable) and the Fleet page |
| `nebius.billing.read` / `nebius.billing.import` | cost reports, CSV export, Budgets & credits and `/budgets/signals` (in scope) / FOCUS imports |
| `nebius.billing.budget.write` | create, update and delete budgets, credits and Token Factory spend entries (local data, audited; project-scoped callers: budgets of their projects only) |
| `nebius.commercial.rate.read` / `.rate.write` | rate books, estimates (including the provisioning estimate), run-rate / rate-book imports |
| `nebius.commercial.scenario.read` / `.scenario.write` | scenarios and quotes / saving them |
| `nebius.provisioning.preview` | recipes, validation, previews, request list, patches |
| `nebius.provisioning.request.create` | prepare, withdraw, approve or record evidence on a request (local only) |
| `nebius.integration.admin` | "Sync now" |
| `nebius.alerts.annotate` | acknowledge and mute alerts in scope (local notes with the user ref, audited; nothing leaves the portal) |
| `nebius.logs.read` | the Logs page: log buckets and lines of the projects in scope, read on demand through the backend |
| `nebius.audit.read` | the tenant's audit events on the Logs page (who did what to which resource), read on demand; tenant-wide, so only for roles scoped to every project. The masked token, client IP, user agent and request or response contents of an event are never copied |

Roles are configured in `nebiusEstate.access.roles`: `principals` (user or group entity refs),
`permissions` (names or `*`) and `projects` (ids or `*`). Each permission uses only the project grants
of matching roles that grant that permission. For example, billing access on project A plus estate
access on project B does not grant billing access on B; an unrelated role's `projects: ['*']` does
not widen billing access. A missing matching grant or an empty permission scope is denied even if
an external permission policy returns ALLOW. Wildcard permissions retain their role's project scope.

Routes requiring several permissions intersect their project scopes (Fleet needs both estate and
telemetry access). Optional data, such as telemetry on Overview and Capacity or historical GPU
utilisation, is hidden unless its permission covers the entire selected caller scope. Capability
flags for optional editing follow the same rule; individual write routes authorize their own scope.
The two-argument `scopeFor` helper and `/meta` expose the aggregate role scope for descriptive use;
data routes use the permission-bound scope returned by `Access.require`.

Contract footprint prices and generated list books select a project inside that intersected scope,
in the requested region. A region with no authorized project returns unavailable rather than
calling the calculator through an unrelated project or disclosing its name in rate sources.
Fleet's idle-cost figure is optional: it requires rate-read access covering the telemetry scope;
without that grant, GPU telemetry remains available and no price request is made.

Unprojected repository documents, rate books, scenarios and provisioning requests remain global
within their named permissions; they do not model project ownership. Grant those permissions only
to users who may access those shared records.

## Identity

The operator path uses real, read-only connectors. The separate `make portal-demo` path uses
the loopback REST stub with invented data, an isolated environment and a visible test-data banner.
It is a development demonstration, not evidence of live cloud access or served identity.

- **Local (one operator, `app-config.local.yaml`, `yarn start`).** The backend binds `127.0.0.1`.
  Only then does the configuration accept the guest sign-in provider and a role for
  `user:development/guest` (`lib/config.ts`); Backstage also refuses the guest provider outside
  `NODE_ENV=development`. Credentials come from the environment (the repository `.env`), never from
  the file.
- **Served (`app-config.production.yaml`) fails closed.** The backend refuses to start when:
  - the guest provider is configured, or a role names `user:development/*`, while it listens on
    anything but loopback;
  - there are no access roles;
  - there is no project list (`projects` or the variable named by `projectIdsEnv`);
  - `nebius.apiEndpoint` is anything but `https://api.nebius.cloud` (another value is accepted only
    for a loopback endpoint on a loopback-only backend: the test stub).

  It also refuses non-https endpoints, URLs with embedded credentials and an old `mode` key.
- **Served sign-in is not implemented by the template.**
  `portal/packages/backend/src/index.ts` registers the auth backend and only its guest provider module.
  `portal/packages/app/src/modules/appModule.tsx` renders `ProxiedSignInPage` with `provider="guest"`.
  Editing YAML or swapping that string alone does not add an OIDC, GitHub or proxy integration.
  A served deployment requires all of the following work; consult the Backstage auth documentation
  and check compatibility with the pinned release (<https://backstage.io/docs/auth/>):

  1. Add and register the selected backend auth provider module and configure its production settings,
     secret delivery, callback URLs or trusted proxy boundary.
  2. Implement a sign-in resolver that maps verified identities and ownership/group refs to the
     entity refs used by `nebiusEstate.access.roles`; verify denial for unmapped identities.
  3. Wire the matching frontend auth API and sign-in flow. Retain `ProxiedSignInPage` only for a
     compatible proxy-based provider; an interactive OAuth/OIDC flow needs its appropriate UI/API.
  4. Verify login, logout/session expiry, unauthenticated API refusal, role/permission/project
     isolation and proxy/header spoofing defenses in the actual served environment.

  No served-provider acceptance result is recorded here. The production configuration is a template
  with empty providers; its fail-closed checks are not evidence of working production authentication.
- **Errors** returned to the browser carry messages, not stack traces (Backstage's error handler with
  `NODE_ENV=production`). Connector errors pass through `redact()` before they are stored or shown.

## Data hygiene

- **Never committed:** `.env`, key files (`secrets/`), the local database (`portal/.local-data/`),
  imported billing files and rate books. Provisioning patches never contain reservation, tenant or
  project IDs.
- **Synthetic estate data** lives in `portal/e2e-stub/` (ids carry `e00mock`, prices use `XTS`, the
  ISO 4217 test currency). Tests and the explicit demo load its configuration; operator and served
  configurations do not.
