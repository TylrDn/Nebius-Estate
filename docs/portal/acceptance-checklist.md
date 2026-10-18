# Nebius Estate — acceptance checklist

Status as of 2026-10-11 (rows 2, 3, 29 and 36 updated and row 44 added 2026-10-12):
- **done:** implemented and checked by the named test or check
- **partial:** implemented with a stated gap
- **open:** not done

October 17 source review updates rows 1 and 23 and clarifies the scope of this historical checklist.
Named tests describe coverage, not a fresh pass on the current commit. Current container CI run links,
dependency findings, historical-artifact review and repository-setting evidence belong in the
[release gates](../release-readiness.md). No row grants production or publication approval.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Operator path starts without cloud credentials and reports unconfigured connectors; explicit demo shows labelled synthetic data | done | `make portal-dev`; `router.test.ts` (unconfigured start); `make portal-demo` uses the documented REST stub; current demo and browser verification run pending in release gates |
| 2 | Sixteen pages in four nav groups (Operate 8, Change 1, Finance 3, Assurance 4: Evidence & Runbooks, Solutions, Nebius docs, Integrations & Coverage), with breadcrumbs, global project/region/stage filter, search and a "Read-only to Nebius" indicator (the portal saves its own budgets, scenarios, rate books and imports) | done | `pricing-tables.test.ts` (nav groups and order), `portal.test.ts` (read-only badge on every page, filter) |
| 3 | Dark-first theme, usable light theme, WCAG 2.1 A/AA, keyboard navigation, reduced motion | done | axe on all sixteen pages in both themes (`portal.test.ts`; at 390 px with WCAG 2.2 AA in `a11y-ui.test.ts`); keyboard tests for nav, graph and drawer; `prefers-reduced-motion` CSS |
| 4 | Responsive layout | done | nav collapses to an icon rail below 900 px; tiles stack below 600 px; `portal.test.ts` checks every page at 390 px for horizontal overflow |
| 5 | Overview: independently sourced metrics; unavailable sources shown as Unavailable, not 0 | done | `primitives.test.tsx`; `router.test.ts` (telemetry gating) |
| 6 | Capacity, Kubernetes allocatable, requested and utilisation never mixed | done | separate `SourcedMetric` fields (`api.ts`); separate tiles |
| 7 | Estate graph and table, detail drawer, explicit relationships only, unattributed resources, desired vs discovered (not "drift") | done | `resources.ts` graph builder; drawer copy; `portal.test.ts` drawer test |
| 8 | TTL-expired and orphan candidates, no deletion | done | `findOrphanCandidates`, `ttlState`; no delete path exists |
| 9 | GPU & Capacity: platform/preset, counts, capacity type, node-group bounds, requests, pending demand, prerequisites, quota only from a verified source, utilisation only from telemetry, min/expected/max calculator | done | quotas come from the quota-allowances connector (#28): tenant allowances lead, project allocations beneath, Unavailable only when the call fails (`QuotaSections.tsx`; `capacity.test.ts`, `sections.test.tsx`, `capabilities.test.ts`). Read live 2026-10-11: 419 items in 9 projects; the API omits every limit ([evidence](../evidence/2026-10-11-portal-live-read-only.md#quotas)), so an omitted tenant limit is read as 0 (observed to behave as 0 once, [evidence](../evidence/2026-10-11-sandbox-inference-portal-connectors.md)) |
| 10 | Workloads from configured clusters only; read-only; Slurm unavailable | done | config validation; `connectors.test.ts` |
| 11 | Provisioning: three recipes, options from repository files, configure → validate → preview → estimate → prepare → CI status → evidence | done | `provisioning.test.ts`, `router.test.ts`, `portal.test.ts`. CI status is stated as "not integrated" |
| 12 | No apply from the browser; disabled pipeline untouched; patch download; no pull request or other write outside the portal database | done | no code-host client exists; `router.test.ts` (repository file untouched) |
| 13 | Path traversal, arbitrary writes, branch/repo targets, workflow dispatch, parameter injection, concurrent edits | done | `router.test.ts`, `connectors.test.ts`, `provisioning.test.ts`, `repo.test.ts` |
| 14 | FOCUS CSV import (test files): dedupe, overlap, per-project supersession, credits, adjustments, taxes, negatives, four metrics never summed, currencies apart, period and ingestion time, reported vs forecast | done | `billing.test.ts`, `commercial/router.test.ts` |
| 15 | FOCUS read-only Object Storage ingestion | done | live 2026-10-11: the portal imported the periodic export's first files, 261 rows, $8.75, equal to the console ([evidence](../evidence/2026-10-11-sandbox-inference-populate.md)); `billing/export.test.ts` (SigV4 known-answer vector, pagination, gzip, ETag dedupe, 403/404), e2e `billing export pull` against the S3 fake; [billing-and-pricing](billing-and-pricing.md#billing-export-pull) |
| 16 | Cost dashboards by project, service, region, resource and labels; unattributed; budgets advisory; completeness and lag; CSV export | done | Costs page; budgets on Budgets & credits (`budgets.test.ts`); `billing.test.ts` |
| 17 | Rate book schema (all requested fields), user-managed imports, no hard-coded live prices | done | `rateBookSchema`; none ships: the portal starts without a rate book |
| 18 | Scenario estimates: decimal arithmetic, bundled charges, unit normalisation, targeted discounts, commitments, currency safety, missing and expired rates, floor vs workload, sensitivity, monthly assumption, validity, JSON/CSV/print, draft label | done | `pricing.test.ts`, `decimal.test.ts`, `commercial/router.test.ts` |
| 19 | Confidential price books stored in the backend, permission-gated, never committed | done | `CommercialStore`; permissions; `.gitignore` |
| 20 | Evidence and runbooks with kinds kept distinct; no green checks from docs | done | `evidence.ts`; `connectors.test.ts` (no repo-live items) |
| 21 | Integrations: status, scope, permissions, attempts, freshness, failure, missing coverage, setup | done | Integrations page; one set of connector definitions; a refused list call shows as permission-denied with project and service (`router.test.ts`) |
| 22 | Backend-enforced permissions (all nine requested, plus billing import and request create) with the Backstage permission framework | done | `permissions.ts`, `permissionPolicy.ts`, tests |
| 23 | Guest identity only on loopback; served config checks; production identity integration | partial | Config guard coverage: `lib/lib.test.ts`. Backend registers only guest and frontend uses `ProxiedSignInPage`; provider module, identity resolver, matching frontend flow and served acceptance are pending ([security](security.md#identity)) |
| 24 | Server-side project scoping | done | `router.test.ts` (estate and commercial) |
| 25 | Credentials backend-only, redaction, SSRF allowlists, timeouts, retries, pagination, validation, audit | done | `lib/lib.test.ts`; `lib/access.ts` |
| 26 | Read-only Nebius connector for a bounded service set | done | about 30 documented lists per project, verified live on 2026-10-11 with project-level `viewer`; tenant-level lists report the role to grant (`capabilities.test.ts`, `yarn verify:live`) |
| 27 | GPU telemetry | done | Nebius Monitoring by default (read API verified live; GPU series appear with GPU VMs), in-cluster Prometheus optional (`capabilities.test.ts`, `connectors.test.ts`) |
| 28 | Quotas and capacity-block connectors | done | quotas and capacity allowances per project (verified live); capacity block groups and advice need a tenant-level read role and say so |
| 29 | Playwright smoke tests for primary workflows | done | the suite runs locally against the REST stub (`make portal-e2e`); 219 tests passed at the 2026-10-12 gates ([overnight brief](../plans/2026-10-12-overnight-hardening.md#progress-log)) |
| 30 | Existing repository checks unchanged | done | the portal changes nothing outside `portal/` and `docs/portal/`; its CI job is additive |
| 31 | Make targets for install, dev, build, test and e2e | done | `make portal-install portal-dev portal-build portal-test portal-e2e` |
| 32 | Generated OpenAPI documents for the backend routes | open | contracts are TypeScript and zod in `nebius-domain`; route list in `architecture.md` |
| 33 | Portal tests in CI | partial | the CI `portal` job runs install, tsc, lint, config check, unit tests and build; the Playwright suite runs locally only |
| 34 | The global filter applies on every page that shows it; filters are in the URL and survive navigation | done | `router.test.ts` (filter on overview, capacity and workloads); `portal.test.ts` (URL and nav) |
| 35 | Views refresh on demand and every 5 min while visible; the last refresh time is shown | done | `portal.test.ts` (refresh) |
| 36 | The explorer graph scales: opens with tenant, project and region levels unfolded, deeper levels on demand, Collapse folds to the tenant, matches-only while searching | done | `ResourceGraph.test`, `resources.test`, `portal.test.ts` (expand/collapse), owner-review e2e |
| 37 | Daily history (scoped, filtered, gaps kept) with 30-day trends on Overview and GPU & Capacity | done | `history.test.ts`, `router.test.ts`, `primitives.test.tsx`, `portal.test.ts` |
| 38 | Charts have a labelled y-axis and readable day ticks | done | `primitives.test.tsx` (`niceMax`) |
| 39 | Schema by knex migrations; billing reports select their rows in SQL (no whole-ledger load); provisioning transitions are compare-and-set | done | `database.test.ts`, `commercial/router.test.ts`, `provisioning/store.test.ts` |
| 40 | Repeatable runtime: Node 24.22.0 (`.nvmrc`), image pinned by digest, one backend replica stated | done | `packages/backend/Dockerfile`; `architecture.md` |
| 41 | Network (R7) and data (R8) stacks visible without forms; a recipe README missing from the checkout is explained, not a 404 | done | `connectors.test.ts` (live roots, missing README), `router.test.ts`, `portal.test.ts` |
| 42 | Live list prices from the Nebius calculator, labelled and never fabricated | done | `capabilities.test.ts`, `router.test.ts` (run-rate, provisioning, footprint) |
| 43 | Connector health: every run recorded, success rate, p50/p95, failure streak, next run; first sync does not block start-up; concurrent "Sync now" refused with 409 | done | `health.test.ts`, `capabilities.test.ts` |
| 44 | A run against a test endpoint or the stub is unmistakable: "Test data — not your tenant" on every page (the 404 page too) and a "Test data" mark in the nav; never in a live run | done | `lib.test` (which configs are test data), `router.test` (`/meta` `testData`), `TestData.test` (none in a live run), `portal.test.ts` (every page, both themes, axe, 390 px) |
