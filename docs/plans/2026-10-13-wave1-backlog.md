# Wave 1 backlog — 2026-10-13

> **Scope:** the portal follow-ups noted during the 2026-10-12 live session and its verification
> (items 1–74), plus the Wave 1 ("Correct and trustworthy") items of the SA journey redesign proposal
> (W1-P1…W1-P29). Every change closes an item below and meets its acceptance check.
> Offline only: tests use the Nebius REST stub, never real ids; no Nebius or GitHub writes.

**Goal:** after this wave nothing on screen is wrong, even where the portal is still incomplete: no
silent stateful shrink in Provisioning, no total built on an unpriced line, no proof claim that
contradicts the evidence index, no count that disagrees with its own table.

**Branching:** integration branch `wave1` (from `main` at 6242c10, v0.3.0). Each group commits on its own
branch from `wave1` in its own worktree; nothing reaches `main` until the owner reviews.

## Gates (per group, all must pass, outputs read)

- in `portal/`: `yarn tsc`, `yarn lint:all`, `CI=1 yarn test`, `CI=1 yarn test:e2e`, `yarn config:check`
  (Node 24, [development.md](../portal/development.md))
- toolbox: `make ci-docker TARGETS="ci"` when anything outside `portal/` changed
- gitleaks on the branch diff: `git diff main... | docker run --rm -i --platform linux/amd64 -v "$PWD:/repo" -w /repo nip-toolbox gitleaks stdin --config .gitleaks.toml --no-banner`
- no real resource ids in the diff (the owner's local id list, `grep -F -f`)
- Test first: new behaviour gets a test that fails without it, in the package's existing style.
- Nebius facts come from [docs/reference/nebius-docs.md](../reference/nebius-docs.md) and the local
  docs mirror; unknowns are written as unknowns.
- A red gate is fixed or the change is reverted; never weakened, skipped or retried until green.

**Prerequisite (from the proposal):** #13 and #23 land before the Wave 1 checks run, or the freshness
checks fail on Overview and Budgets for reasons outside this wave. #23 is done; #13 is partly done.

**Status words:** *done* (commit named), *partly done* (what is left is named), *open*.

## Live follow-ups (items 1–74)

### Live session, 2026-10-12
1. Estate/resources: storage buckets show status "running" (bucket has no run state; show "active"/"ready" as for disks/projects in F1.21/F1.44).
   *Status:* **done** — verified live 2026-10-12 23:20Z on the v0.3.0 code (6242c10): a bucket reads "ready" (`lifecycleLabel`, nebius-domain `resources.ts`).
2. Overview + Capacity "Project quota caps below the tenant limit": rows name region and quota but not the PROJECT (alerts name nbis-labs); add the project name to each row.
   *Status:* **done** (8d632f7, G6) — Capacity rows carried the project; the Overview's cap rows now lead with the project name (the filter options' names, passed to the tile) and keep the quota id as hover text.
3. Overview "Planned resources blocked by quota": judges the committed sandbox/inference defaults (cpu_node_count=2) against eu-north1 non-GPU vCPU 0 and says "blocked" while the l40s-gpu-only run profile (0 CPU nodes) is being deployed successfully (make preflight: GO). Use the rendered run profile when the root has one (.run-profile.tfvars.json) and name it; otherwise say "blocked with the committed defaults" and name a profile that fits. Same inputs as scripts/preflight.py so the two cannot disagree.
   *Status:* **done** (ab33550, G2.2) — the planned quota check sizes an unapplied root by its run profile's vars and an applied root by its observed node groups, and the Overview names the profile; not showing in the 23:20Z re-check.
4. Overview "Needs attention": project-below-tenant cap warnings may be intentional defaults (nbis-labs); hint that acknowledging with a note is the expected action.
   *Status:* **done** (8d632f7, G6) — the cap row's list ends with "Intended (a project kept small on purpose)? Acknowledge its alert with a note, so the next reader knows" and an "Acknowledge on Alerts" link.
5. Integrations, Billing export pull: the per-sync note is prefixed "Not covered:" but is information ("Imported this sync: …"); label it as the last import, not a gap.
   *Status:* **done** (08d068b, G6) — root cause: the connector put the import in `missingCoverage` (gaps). It is the connector's note, "Last import: <file> (<month>), N rows" (`lastImportNote`), from the newest imported file in the database (`BillingExportPuller.lastImport`), so a sync with nothing new or a restart still names it. Review fix: the last import is looked up by id (`importSummary`), not by loading every import each sync; one deleted since reads "…, since removed", never "0 rows".
6. Same note shows raw billing export and customer ids in the file path; show the file name/month and row count, ids on hover at most.
   *Status:* **done** (08d068b, G6) — only the key's file name and a YYYY-MM month are shown; the folders (where the ids live) are not shown at all, not even on hover.
7. Overview "Connector health: 10 of 11 connectors ok (1 not needed) · 1 optional" counts the not-needed connector as ok while the table shows 9 ok; read "9 ok · 1 optional · 1 not needed" (one shared summary, same as S3 gapText).
   *Status:* **done** (9670e20, G6) — root cause: `connectorHealthLine` added not-needed to the healthy count. Each state is counted once under its own name ("14 connectors: 10 ok · 1 partial (…) · 2 waiting · 1 not needed"), and each count is the Integrations filter that lists exactly that many (W1-P29).
8. Evidence → Decisions: ADR 0001 card summary is a mid-document fragment ("does not build the gateway of option 3."); the summary extractor should take the first prose paragraph after the title/status (test on all 9 ADRs and 23 runbooks).
   *Status:* **done** (98bd0b6, G5.8) — ADR summaries use their Context paragraph; verified live 23:20Z.
9. Evidence → Runbooks: Drift runbook summary is a raw numbered command line ("1. terraform -chdir=… plan -detailed-exitcode …"); skip list items and code when picking the summary sentence.
   *Status:* **done** (7c5c015, G5) — root cause: with no prose paragraph the extractor fell back to the first list item, a command. A list item that opens with a code span is skipped and the first prose item's first sentence is used: Drift reads "Identify the source: manual console change, another reconciler, or provider upgrade."; tested on all 24 runbooks (no summary starts with a command).
10. Evidence cards: titles wrap with the date split across lines ("— 2026-10-" / "11"); keep the date unbroken (nowrap) or move it to a meta line.
   *Status:* **done** (bf66cf7, G5) — the trailing "— <date>" of an evidence title is one no-wrap box inside a single inline title (`splitTitleDate`, `DatedTitle`), on the evidence cards and recipe-card rows; e2e at 1440 and 390 px in both themes checks every date is one line box and not a column beside the title.
11. Estate: a Nebius documentation page (browse docs/reference/nebius-docs catalog + .cache mirror sections in the document drawer; link from Capacity/Alerts/Recipes).
   *Status:* **done** (02b172a, daaf1c2, G6) — `/nebius-docs` (Assurance): sections with their pages, key pages with why, search over titles, paths and recipe ids; a page opens in a drawer from the git-ignored mirror (`.cache/nebius-docs`, MDX components removed), else with its sections linked to docs.nebius.com; only catalogued paths open. Linked from Capacity (allowance check → quotas page), Alerts (metrics) and each Evidence recipe card whose id a key page names ("Nebius docs for R3 (n)"). The e2e runs without a mirror (this checkout has none); the mirrored view was checked by hand with three pages copied in.
12. Costs / Budgets / Overview freshness: next to "exported through <t> (lag)", show "next pull <t> UTC" (the billing connector schedule, as Integrations shows) and "next export file expected ≈ <t> UTC (estimate: Nebius writes the periodic export about hourly, docs signup-billing/usage/export#periodic-export; derived from the observed arrival times of the last files)". Label it an estimate; never a promise; hide it when the cadence cannot be observed.
   *Status:* **done** (22ca41d, G2) — Costs (Export lag), Budgets (Spend this month) and the Overview billing tile say "next pull HH:MM UTC" from the export pull's schedule, and, when at least three files arrived at a regular 15 min–6 h interval, "next export file expected ≈ … (estimate …)" from their bucket LastModified (`exportCadence`); late is said; hidden otherwise (the stub's one file shows no estimate).

### From the populated-view live audit (run live-20261012-run2)

13. Inventory tiers: msp.postgresql, msp.mlflow, registry.registries and quotas.allowances are outside CORE (nebius-catalog.ts:72) so read every 4th sync (InventoryService.ts:575, fullSyncEvery 4): R12 resources and quota usage arrived ~1 h late. Add them to CORE (or the fast tier while a run changes state); stamp quota cards with the capability's own lastSuccess, not the snapshot time.
   *Status:* **partly done** (cd1c58d, 46211e5: these lists are CORE, quota cards stamped with their own read time; fe31b10, f8db7ec: the Provisioning quota card carries the tenant allowances' own last success and says when the latest read failed) ; **done** (6c3fc2b, G4) — root cause: the Overview's TTL-expired and orphan counts and the AI services Serverless lists were stamped with the snapshot time, which a fast re-sync moves although it reads three lists only. They now carry the oldest last success of the lists they span (`readTime`).
14. plannedQuotaIssues (views.ts:699-702) uses root.sizing (sandbox.auto.tfvars) while the observed run used profile l40s-gpu-only: merge the rendered profile vars / compare with observed node groups; else mark "sizing file, not the running profile" (same as item 3).
   *Status:* **done** (ab33550, G2.2) — same change as #3.
15. CSI disks: nebius-mappers.ts:125 reads size_gibibytes only; fall back to size_bytes/size_kibibytes; calculator.ts:99 must push size-less disks to `unpriced`, never drop them silently.
   *Status:* **done** (b27eb49, 92f03f0, G4) — root cause: `nebius-mappers.ts` read `size_gibibytes` only and `calculator.ts` skipped a disk without a size. Every documented size unit is read, then `status.size_bytes`; a size-less disk is named unpriced ("the API answer has no size to price"). The stub has a bytes-only CSI disk and a size-less one; e2e asserts the unpriced line on the Overview.
16. Workloads: failed Jobs show amber "not ready (0/1)": kubernetes.ts:116-117 + workloads/model.ts:62 need status.failed and Failed/Complete conditions → red "failed (<reason>)".
   *Status:* **done** (d4dc181, G4) — root cause: the Job mapper kept no status; `jobOutcome` reads the Failed / Complete conditions (status "True") and `status.failed`; the row reads red "failed (BackoffLimitExceeded)" with its failed pods, "complete" in green.
17. Requests/limits concatenated ("100m+250m+100m"): kubernetes.ts:72 must parse Kubernetes quantities (m, Ki/Mi/Gi) and sum.
   *Status:* **done** (d4dc181, G4) — root cause: `sumRequests` added plain numbers only and joined the rest as strings. `sumKubeQuantities` (nebius-domain) parses every Kubernetes quantity form and sums; an unreadable value is kept, never counted as zero. Independent G4 review (f371f88): a sub-millicore total read "0.001" or "0"; it now reads in micro or nano units ("500u").
18. Workloads page: namespaces list and node state (cordoned/deleting/NotReady); hide the Soperator card when no Soperator cluster exists (WorkloadsPage.tsx).
   *Status:* **done** (d4dc181, G4) — namespaces per cluster; a Nodes table and a per-cluster summary from the Ready condition, `spec.unschedulable` and `metadata.deletionTimestamp`; the Soperator card only while a Soperator cluster is in scope (label, name or a soperator namespace).
19. Alert rule for TTL near expiry (nip-ttl-expires within N h on a running root), with runbook section.
   *Status:* **done** (76b77c1, G7) — new portal signal `nebius_estate_ttl_expires_hours` (per project, stage, stack and run: hours to the earliest `nip-ttl-expires`, own or inherited, of the root's running resources, while ahead) and rule `TtlExpiresSoon` (`< 6`, warning: "sandbox/inference (run r1) reaches its TTL in 3 h (…)"); runbook section `runbooks/teardown.md#a-running-root-near-its-ttl`. Unit-tested (signal, stored title, rule list); the stub has no root that close to its TTL, so no e2e.
20. AI services: show the R12 container registry and MLflow (link to Explorer).
   *Status:* **done** (888b60e, G4) — a "Container registries and MLflow" card with Explorer links, as of the lists' own read, "none" only when both lists answered. Independent G4 review (d48aba1): a list with no capability record yet counted as answered, so one list's answer could read "none"; it is now named "not read yet" and the card is partial.
21. Explorer graph at 390 px after "Expand all": avoid a tall empty canvas (fit or list fallback).
   *Status:* **done** (49afc05, G7) — root cause: the layered drawing puts each depth in a column, so after "Expand all" a 390 px screen showed column 0 (the tenant) over a 1760 px canvas. A narrow box (< 600 px) that cannot hold the columns draws the same nodes as an indented tree (`treeOrder`), placing edges as elbows, with a note that cross-references show on a wider screen and in the drawer. e2e: after Expand all at 390 px, both themes, no sideways scroll and a node on every row; the F1.21 phone test now expects the tree.
22. estate-check.sh: include resources attributed to the run by the portal (VM, disks via node group), not only the nip-run label.
   *Status:* **done** (58096b9, 1d4d178, G4) — root cause: the script filtered on the nip-run label only; it now uses the portal's attribution (`attribution.run`, `inheritedFrom`). G4 review: the run-rate line printed the estimate object; it prints the hourly total and currency ("no total" or "0 … (nothing running)") and the count without a price.

### Vision review, phone width, 2026-10-12 20:20Z

23. PRIORITY (pairs with 13): stale slow-tier data after deletion. 20:18Z: portal still listed R12 PostgreSQL + registry as "running" and priced PostgreSQL (0.149 USD/h) in the live run-rate, though Nebius had no PostgreSQL/MLflow/registry. Read these lists every sync (or refresh them on any inventory change), and never price a resource whose last read is older than the core sync.
   *Status:* **done** (cd1c58d, 46211e5) — managed DBs, registries and quotas read every sync; nothing the latest sync did not read is priced; verified live 23:20Z.
24. Phone first screen: page intro + three filters + Refresh/badge fill the whole first 844 px on Overview/Estate/Fleet; collapse filters into one "Filters" control and shorten the intro on narrow screens so the first KPI is above the fold.
   *Status:* **done** (8d632f7, G6) — in PageShell, so every page: on a phone the filters (and search) are one "Filters" control that names what is applied, the intro is its first sentence (cut at a word past 90 characters) with the rest under "More about this page", and the refresh age is the Refresh button's hover text so it shares a row with the read-only badge. e2e: the header ends above 300 px and the first figure of Overview, Estate and Fleet is on the first screen, both themes.
25. Overview "Needs attention" at 390 px reads as one run-on sentence; render as a short list (count + label per row). "Show all 8" while 8 + 1 + 8 items are listed: say what "all" covers or show the total.
   *Status:* **done** (8d632f7, G6) — one row per item, count first; the toggle reads "Show all N checks".
26. Estate graph: the tenant node is labelled with its raw id ("tenant-<id>"); use the tenant name (or "Tenant") with the id on hover.
   *Status:* **done** (49afc05, 98d932b, G7) — the tenant node reads the tenant's name when the snapshot has one, else "Tenant"; the id is its hover text and, so tenants stay distinguishable to a screen reader, its accessible name ("Tenant tenant-…"; owner-review S4 addresses it so).

### Live re-check after the UI fix merge (5ac4d99): remaining

27. Run-profile awareness, one model across the portal (with items 3 and 14): Provisioning has no run-profile select and prices/quota-checks the committed sizing (2 × cpu-d3 + H100: "non-gpu.vcpu needs 16, limit 0, blocked" while Prepare stays enabled); Capacity calculator with l40s-gpu-only keeps max 4 GPU nodes (Calculator.tsx:86 Math.max(r.max, n)) and warns above the sandbox cap. Read platform/profiles/<stack>/*.json in nebius-domain; same inputs as scripts/preflight.py.
   *Status:* **done** (7a27044, fe31b10, f8db7ec, G1) — one run-profile model (`runProfileSizing` in nebius-domain: sizing file, then the profile's vars, as `make plan PROFILE=` and scripts/preflight.py) for the Overview check, the calculator and Provisioning. Provisioning has a Run profile select (region and the fields the profile sets locked to it; run sheet adds `make preflight … PROFILE=` and `PROFILE=/RUN=`); the calculator sets expected and max to the profile's node count (no Math.max).
28. G1.6 Integrations flaky calls: sharedOutages (integrations/model.ts:53-61) compares only each call's newest failure; older tenant-wide outages count as the call's own failure.
   *Status:* **done** (9670e20, G6) — `syncIncidents` groups every failed run a call keeps (recent runs and the newest failure) by attempt; `ownFailures` leaves out every failure at an incident, the older ones too. Review fix: only incident failures inside the 24 h that `failures24h` counts are taken off (the window ends at the call's newest run).
29. G1.10 Explorer: unlabelled auto-subnet-pool still plain "unattributed" with no hint.
   *Status:* **done** (e511eee, 16108c7, G7) — root cause: nothing the portal read named an unlabelled pool's owner. The pool mapper reads the documented `status.assignment.subnets / networks` (`pool-of` relation); an unlabelled pool inherits stage, stack, owner, run and TTL from the subnet or network it is assigned to ("attributed via subnet …"), is "managed" when that subnet is, and otherwise names the unlabelled subnet it serves, or says "assigned to no subnet or network" only when the answer carried `status.assignment`. Live: the field has not been seen in a live list answer yet (it is documented in the Terraform provider reference); a pool whose answer lacks it reads the plain "No nip-* labels" sentence, never a claim about its use.
30. G3.4 Logs audit: 24 h and 7 d views cut at the newest 50 events (truncated, no scannedFrom): paginate or say where the window stops.
   *Status:* **done** (2c2d99c, G7) — root cause: a list cut at its limit (50) set `truncated` without `scannedFrom` and the card said neither where the list stopped nor how to see more. It names the oldest event shown and the range's start, and offers "Show 50 more" up to the API maximum (200). e2e against an intercepted full response.
31. G3.14 Logs default project: defaultProject.ts picks a project whose 24 h probe says recent:true though its newest line is days old; pick by newest line time.
   *Status:* **done** (0a02018, G7) — root cause: "recent" came from Loki label values over 24 h, answered from the index (a bucket can be listed with no line in the window). The route reads each bucket's newest line (query_range, limit 1, backward) and opens on the project that wrote last; "recent" means a line in 24 h; a failed read falls back to the label probe. Stub: staging's logs end 3 h ago (`logsQuietMinutes`).
32. N3 (seen once): /logs with a valid project link showed "not a project in your scope" and raw ids; likely a race before /filters loads — guard the link filter until scope is known.
   *Status:* **done, guarded** (dec595b, G7) — not reproduced. Likely cause: `/filters` lists projects from the snapshot, empty until the first inventory sync, and the filter bar removed the valid project against that empty list. `/filters` now says `pending` while the inventory connector is starting; the bar judges no value against a pending scope (invalid ids still refused) and re-reads the options every 5 s. The frontend rule is unit-tested; the route flag has no route test (the test backend cannot be held inside its first sync).

### Section-by-section verification (pre-v0.3.0)

Live, 2026-10-12 23:20–23:49Z, 15 pages × light/dark × 1440/390 px (verification report kept locally, not in git).

33. [Misleading] Overview Trends; Capacity "GPUs present vs utilisation · 30 d": 30-day history shows 0 GPUs / no utilisation on 2026-10-11 and 10-12 though GPU VMs ran both days. Cause: Day rows were written before e985dbb (G2.5 per-day peak, 18:52Z 10-12) or by a backend still on pre-G2.5 code at 19:31–19:46Z (current process started 23:06Z). Merge logic itself is correct. history.ts:100-120, history/record.ts:6-10, plugin.ts:90. Fix: Backfill affected days once from GPU hourly telemetry + billing rows; have /history mark a day "incomplete" (or "last state only") when hourly GPU samples exist but gpus = 0; confirm peaks during a live sync window. (G1 F1, G2 #1)
   *Status:* **partly done** (be28237, 4162cd0, dc441a1, G3) — root cause: day rows written before the G2.5 per-day peak kept only the day's last state. After the first sync of each start, `backfillHistory` compares every recorded day (90-day roll-up window) per project with the sample store's hourly roll-ups and raises GPUs and running VMs to the peak hourly GPUs telemetry saw (the project's busiest hour, the same quantity as the row's per-sync peak, so sequential VMs replaced during a day are not added up; G3 review) and fills missing utilisation (`backfillFromTelemetry`; per project, so a series without region or stage is not counted twice; never lowers, never adds a day, idempotent). Decision: today takes no utilisation from telemetry, because on a fresh start the first sync runs before the telemetry recorder (start-up order, not a gap); a GPU today's syncs missed is still raised (it ran before the portal started). Only the GPU and utilisation charts draw a marked day hollow. The row is marked and `/history` returns `incomplete` with the reason; Overview Trends and the Capacity history card draw that day as a hollow point, name it under the chart and give the reason in the footer. Left: billing rows are not used (GPU-hours per day give no peak count; telemetry is the count), vCPUs on those days stay as recorded (telemetry has none), and the live confirmation during a sync window needs the live account (not offline).
34. [Broken] Fleet GPU drawer: Fleet GPU drawer links "Node group in the Explorer" for a deleted node group; the Explorer drawer then says "could not be loaded". Cause: telemetry/FleetPage.tsx:373 checks only r.nodeGroupId. Fix: Show the link only when !r.deleted?.nodeGroup; otherwise "node group deleted; not in the Explorer". (G2 #2)
   *Status:* **done** (d14a2bd, 92f03f0, G4) — root cause: the drawer linked any `nodeGroupId`. It links only a node group in the inventory (`nodeGroupUid`, as `instanceUid` for the VM); "Node group deleted; not in the Explorer." once a listed project's sync lost it; otherwise "not in the current inventory". The stub's legacy GPU series names an absent node group; e2e asserts the drawer.
35. [Misleading] Integrations & Coverage: Integrations callout "A sync failed for every connector at once" (16:23Z) when only the inventory connector failed. Cause: integrations/model.ts:53-61 sharedOutages counts the inventory connector's ~35 calls as separate connectors (used at IntegrationsPage.tsx:127); second symptom of #28. Fix: Count distinct connectors (or calls grouped by connector) and require at least 2. (G1 F3)
   *Status:* **done** (9670e20, G6) — root cause: calls were counted, not connectors. An incident names its distinct connectors: one connector's sync reads "Nebius inventory (REST API): one sync failed across 35 calls; recovered 16:38", and "for N connectors at once" needs two or more.
36. [Misleading] Overview Credits tile; Budgets "Credit remaining" tile + Credits card: Token Factory credit shown as "25.00 USD of 25.00 USD left", green "Active", though no spend was ever entered (the 10-11 smoke test and 10-12 sweep drew on it). Cause: budgets.ts:560,577 (status ok with zero entries) and :936-943 (line drops the credit note); BudgetsPage.tsx:389-398; overview/parts.tsx:732-735. Fix: When a provider has no spend entries show "≤ 25.00 USD (no spend entered)" and a neutral "unverified" status. (G1 F5, G4 F1)
   *Status:* **done** (b6bd84e, G2) — root cause: a credit with no spend source was evaluated as fully unused and "ok". It is now "Unverified: no spend entered" (or "no billing export rows"), "≤ 25.00 USD" with the reason and no meter, grey, on Budgets, the Credit remaining tile and the Overview (`remainingAtMost`, `creditTone`). G2 review: an AI Cloud credit counted as verified as soon as any export row existed; it now needs export coverage inside its validity ("Unverified: no billing export rows since it applied", with the export's end date named).
37. [Misleading] Logs → Audit events: Audit events with status ERROR (4 VIRTUAL_NETWORKS DELETE at 19:50:09Z) show a green "error" badge. Cause: logs/auditModel.ts:28-31 treats an event as failed only when e.error is set. Fix: Status /^(ERROR|FAILED|CANCELL?ED)$/ → { tone: 'warn', label: 'failed' } + unit test. (G3 F1)
   *Status:* **done** (1cb719a, 6085a19, G7) — root cause on both sides: the mapper took an error only from a numeric `response.status.code`, while the documented event has `response.status_code` (a gRPC name) and a possibly empty `error_message`; and `auditResult` judged failure by the message alone. The mapper reads the documented fields; ERROR / FAILED / CANCELLED read "failed" (amber) on the status alone, STARTED "started". Stub: a VIRTUAL_NETWORKS DELETE with status ERROR and an empty message; unit, route and e2e tests.
38. [Misleading] Solutions S3, S9: Solutions Status is stale: S3 "one smoke request proven" (R11 ran a 600-request sweep 10-12); S9 lists R8 / R12 as not run (both ran live). Cause: solutions/README.md:20,26 (last changed 10-11, fb08179) shown unchanged at SolutionsTab.tsx:189. Fix: Update the README rows; label "Status (README, <date>)" or derive "not run" from recipe proof levels. (G4 F2)
   *Status:* **done** (11dde27, bf66cf7, G5) — README rows reconciled with docs/evidence (S3 index and Status: the R11 sweep; S9: R8, R12, R14 run live, R3 planned only; and the section 10 rows of S1, S2, S4–S7, S9 that said a recipe was not run while it had run or been planned live). The card now leads with a proof line derived from the evidence (W1-P11) and shows the hand-written text as "README status". No date label: the README's Dated row dates its prices (2026-10-11), not its status rows.
39. [a11y serious] Alert drawer runbook (both themes); Evidence document drawer: Markdown code blocks: scrolling <pre> not keyboard-focusable, and light-theme syntax tokens fail contrast (#408080 3.94:1, #219161 3.44:1 on #eceff4). Cause: No tabIndex on MarkdownContent <pre> (AlertsPage.tsx:350-351, EvidencePage.tsx:517); token colours ui/styles.css:1563-1584; 360 px runbook box styles.css:2220; axe tests never open a drawer. Fix: tabIndex=0 + aria-label on overflowing .ne-markdown pre (or pre-wrap in .ne-fix-runbook); ≥4.5:1 token palette; drop the 360 px limit; add an axe test with ?doc= and an alert drawer open. (G3 F3+F4, G4 F5)
   *Status:* **done** (f9529d6, ed25777, G7) — root cause: every Markdown view rendered Backstage `MarkdownContent` directly: code blocks scrolled with no tab stop, and the CodeSnippet painted hljs docco/dark colours inline with the class names dropped. One shared `Markdown` component (alert runbook, Evidence and Nebius docs drawers): an outer code block or table that scrolls gets tabindex 0 (a code block also region "Code block (scrolls sideways)"), tokens are tagged by colour and painted by a theme palette at least 4.5:1 (unit-tested), the inner highlighter box no longer scrolls on its own, the 360 px runbook box is gone, links in Markdown are underlined (link-in-text-block in the same drawer). Screenshot review: table cells keep their words (Backstage's cell rule won on specificity). e2e: alert drawer and two documents at 1440 and 390 px, both themes, no unfocusable scroller, no axe violations.
40. [a11y serious] Estate Explorer drawer: At 390 px Explorer drawers without a link or button fail axe scrollable-region-focusable (bucket, pool, project; both themes). Cause: ui/components/primitives.tsx:617 drawer body not focusable. Fix: tabIndex={0} and an accessible label on the drawer body. (G1 F7)
   *Status:* **done** (fa53032, G7) — the shared Drawer's body is role=region, named by the title, tabindex 0. e2e: bucket, project and subnet drawers at 1440 and 390 px, both themes, no unfocusable scroller and no axe violations.
41. [a11y serious] Logs results: Selected log row time fails contrast (light). Cause: styles.css:2245-2246 (--ne-faint on --ne-accent-soft). Fix: .ne-logrow[aria-pressed='true'] .ne-logrow-time { color: var(--ne-muted) }. (G3 F5)
   *Status:* **done** (83aae0f, G7) — the selected row's time takes `--ne-muted` (faint failed AA on the selection colour). e2e: a selected row at 1440 and 390 px, both themes, no axe violations (failed in light before).
42. [Confusing] Alerts drawer Evidence + History: Alert value is raw bytes with no unit ("Value: 3,848,290,697,216") for a 1.5 TiB vs 5 TiB cap. Cause: AlertsPage.tsx:290,314 fmtNumber(value); value from alerts/signals.ts:178 (bytes). Fix: Add display.value to the signal (fmtQuotaAmount → "3.5 TiB below the tenant limit"); else label with the rule metric. (G3 F2)
   *Status:* **done** (de475f1, G7) — root cause: a signal's value said nothing about what it counts. Signals carry `valueKind` (quota unit, quota line, or unit word, and what it is), kept on the stored alert; `alertValueText` renders the drawer's value and history ("987 below the tenant limit", "3.5 TiB below the tenant limit"); a Monitoring rule's value is "the result of the query below". Alerts stored before keep a plain number.
43. [Confusing] Capacity footprint calculator: Calculator quota line "compute.disk.size.network-ssd 0 + 4,373 > 4,096" has no units or words. Cause: pages/capacity/Calculator.tsx:47 uses fmtNumber. Fix: fmtQuotaAmount(…, unit) with labels: "in use 0 + needs 4.27 TiB > limit 4 TiB". (G2 #3)
   *Status:* **done** (7a27044, G1) — `quotaLineAmount`: "in use 0 GiB + needs 4.27 TiB > limit 4 TiB in eu-north1"; vCPU and GPUs by name. The Provisioning quota table uses the same units (f8db7ec).
44. [Confusing] Overview: "Needs attention" can end up folded at desktop width with no way to reopen it (toggle hidden on wide screens). Cause: styles.css:2473-2475 hides the summary; width handling overview/parts.tsx:281-283,425 closes it on a narrow→wide flip. Fix: Render the list unconditionally on wide screens, or .ne-attn-fold:not([open]) > .ne-attn-summary { display: block }. (G1 F2)
   *Status:* **done** (8d632f7, G6) — a wide screen renders the list without a details element, so nothing can leave it folded; e2e opens and closes it at 390 px, widens, and finds the list.
45. [Confusing] Estate Explorer table: Resources table is 1294 px in a 1150 px card at 1440; the Observed ("last seen") column is off-screen and a DNS summary breaks mid-word. Cause: Long "managed by a Nebius managed service (label managed=true)" chip does not wrap (ExplorerPage.tsx:290, .ne-chip styles.css:603); overflow-wrap:anywhere styles.css:2014-2016. Fix: Shorten chip to "managed" with hover text, or let it wrap; min width for Flags. (G1 F4)
   *Status:* **done** (e511eee, G7) — the never-wrapping chip is "managed" with who manages it on hover and in the drawer; a DNS name or CIDR in Flags breaks after its dots and slashes. e2e at 1440 px, both themes: the table fits its card, Observed on screen, the DNS name breaks only at separators.
46. [Confusing] Estate Explorer drawer: Drawer says "unattributed" for the orphan subnet the table shows as "managed by a Nebius managed service". Cause: ResourceDrawer.tsx:159-165, :229-236 have no managed case. Fix: Reuse the table's "managed by …" chip and sentence. (G1 F6)
   *Status:* **done** (e511eee, G7) — root cause: table and drawer each worded attribution and only the table knew "managed". `attributionView` decides it once for the table cell, the drawer badge and its Stage / stack row. e2e on a managed=true leftover subnet in the stub.
47. [Confusing] Costs → Breakdown: resource: Costs Resource breakdown lists 51 labels twice (a node-group VM and its boot disk share a name). Cause: commercial/costsModel.ts:31-35 strips the id and adds no type. Fix: Append the type from the key prefix (VM, disk, filesystem, IP). (G4 F3)
   *Status:* **done** (8f0e9ac, G2) — the resource label carries its type from the id prefix ("gpu-node-1 · VM" / "· disk").
48. [Confusing] Evidence → Recipes: Recipe R1 card leads with R8 / R14 runs; R1's own 10-12 validation run is hidden under "5 more". Cause: pages/solutions/model.ts:39-46 leadEvidence sort (ties keep file order). Fix: Rank rows whose primary recipe is this recipe first, then kind and date. (G4 F4)
   *Status:* **done** (46799ca, G5) — `leadEvidence` ranks rows whose primary recipe is the card's first, then kind and date; R1 leads with its own 2026-10-12 validation run (unit and e2e).
49. [Confusing] Commercial → Scenarios: Commercial with no rate book says "Create one below" then "Import a rate book first", with no link or button. Cause: commercial/CommercialPage.tsx:95,413,455. Fix: Say the rate book is needed first and add a button to the Rate books tab. (G4 F6)
   *Status:* **done** (3384c77, then b51e910 with W1-P6) — with no rate book the Scenarios tab says the scenario is priced at the Nebius list price and offers "Import or build a rate book"; with no calculator either, it says neither is available and offers Open Rate books; every "import a rate book first" now says "Import or build a rate book first". E2E covers the list-price path; the no-calculator callout is unit-tested only (the stub always has a calculator).
50. [Confusing] Commercial draft quote: Draft quote headline (40.69 XTS) silently leaves out 3 unpriced gap lines. Cause: commercial/EstimateView.tsx (tiles ~line 33). Fix: Add "excludes N unpriced line(s)" to the headline tile. (G4 F7)
   *Status:* **done** (14ccda9, G2) — same change as W1-P9: a total names "excludes N unpriced lines".
51. [Confusing] Evidence document drawer: Document drawer at 390: inline code widens the body to 427 px; anchors scroll the document sideways and clip headings. Cause: styles.css:1556 .ne-markdown code. Fix: overflow-wrap: anywhere (or word-break: break-word) on inline code. (G4 F8)
   *Status:* **done** (f9529d6, G7) — inline code wraps anywhere (`docs/naming.md` was 416 px in a 353 px body at 390); code blocks keep their lines. e2e checks the body width for two documents.
52. [Confusing] Capacity 30-day history: History utilisation chart draws empty axes with no message when every day is null; GPU count axis has a 0.5 tick. Cause: ui/components/charts.tsx:115 ([0, max/2, max]); TrendChart charts.tsx:224-233 hides only with no points. Fix: Whole-number ticks for counts; "no samples in these days" when no day has a value. (G2 #4)
   *Status:* **done** (4162cd0, G3) — `TrendChart`: whole-number series get whole-number gridlines (1 GPU reads 0 and 1, never 0.5); when no day has a value it says "No samples in these days." instead of drawing empty axes.
53. [Polish] Capacity Node groups; Fleet Volumes / PostgreSQL / MLflow; Workloads empty state: Some "none" states show no as-of time though data is current. Cause: CapacityPage.tsx:129; telemetry/fleet.ts:285,314 (no observedAt); WorkloadsPage.tsx:58. Fix: Pass each source's last-success time as observedAt. (G2 #8)
   *Status:* **done** (d4dc181, 6c3fc2b, G4) — every Fleet service card, Capacity's empty node-group table and Workloads' "No Kubernetes cluster in scope" carry their lists' read time. Independent G4 review (ec02b36): the Workloads empty state carried the last full-sync time; it is now the cluster list's own last success.
54. [Polish] Integrations: Optional (Kubernetes) and not-needed (External Prometheus) connectors stay open next to cards that need a look. Cause: ConnectorCard.tsx:12-18 isHealthy; IntegrationsPage.tsx:169-173. Fix: Fold them with the healthy group or a third group. (G1 F8)
   *Status:* **done** (9670e20, G6) — a third group, "Not applicable (N)", folded, its one line naming each connector and "Not counted as gaps".
55. [Polish] Estate Explorer: tfstate-nip-foundation-… state bucket listed as "unattributed" with no hint (pairs with #29). Cause: Created by the foundation step outside the label convention. Fix: Label it, or explain the case as #29 asks for the subnet pool. (G1 F9)
   *Status:* **done** (4f6c73d, G7) — root cause: `scripts/bootstrap-backend.sh` created the state bucket unlabelled, and the foundation's own bucket is never adopted by Terraform (which labels the stage buckets). The bootstrap now creates it with `nip-owner=platform,nip-layer=foundation` (and `nip-stage` for a stage); for an existing unlabelled bucket it prints the `nebius storage bucket update --labels` command (repeating the bucket's existing labels, since `--labels` may replace the whole map) and changes nothing. The live `tfstate-nip-foundation-…` bucket stays unattributed until the owner runs that command. Tests in `tests/scripts/test-bootstrap-backend.sh`.
56. [Polish] Estate Explorer drawer: Project drawer Status reads "active — ACTIVE". Cause: ResourceDrawer.tsx:210. Fix: Hide the raw API state when it only repeats the label. (G1 F10)
   *Status:* **done** (05fcc33, G7) — `drawerStatus` shows the API state only when it says more than the status word. e2e: the sandbox project reads "active".
57. [Polish] Integrations: Capability matrix 1232 px in a 1150 px card (Fallback · limits clipped, paths break per character); opened folded sections show their title twice. Cause: pages/integrations/MatrixCard.tsx; IntegrationsPage.tsx:198-228. Fix: Let the matrix scroll or wrap sanely; drop the duplicate card title. (G1 F11)
   *Status:* **done** (5994fcf, G6) — root cause: auto column widths sized to an unbroken repository path in Fallback. Columns take shares of the card and paths break after their separators; the matrix, coverage and capabilities cards no longer repeat their fold's title. e2e: the table fits at 1440 px in both themes.
58. [Polish] Capacity availability: Opening "16 more platform presets" pushes the Platform / Capacity type selects to the bottom and empties the left column. Cause: pages/capacity/TenantSections.tsx:188 alignItems: 'flex-end'. Fix: BestRegions on its own row, or alignItems: 'flex-start'. (G2 #5)
   *Status:* **done** (a0164d4, G3) — root cause: the best-region list shared the selects' flex row (`alignItems: flex-end`). The selects keep their row and the list is a row of its own below them; the list's row-only `flex: 1 1 280px` (which became a 280 px height in a column) is gone. e2e: the select does not move when the fold opens.
59. [Polish] Capacity quotas: At 390 px each Allowance check badge wraps under its sentence and reads as belonging to the next item. Cause: pages/capacity/QuotaSections.tsx:198-205. Fix: Keep the badge on the title row (no-wrap like .ne-attn-row) and separate rows. (G2 #6)
   *Status:* **done** (a0164d4, G3) — the badge sits on the title row (`ne-attn-row`, no wrap), the sentence under it, a rule between rows. e2e at 390 px: each badge is on its title row, above its sentence.
60. [Polish] Fleet tiles (both widths): Tile source lines wrap into an orphan "· 3 h ago" line. Cause: ui/components/primitives.tsx:289-292. Fix: No-wrap the age with its source; drop the leading dot after a wrap. (G2 #7)
   *Status:* **done** (2efb437, G4) — `TileSource`: the age is a no-wrap unit and the dot is drawn in a clipped margin, so a wrapped age starts its line without one.
61. [Polish] Fleet: Fleet service-health cards stretch to the tallest (300+ px empty bodies). Cause: styles.css:2212 .ne-svc-grid lacks align-items: start. Fix: Add align-items: start. (G2 #9)
   *Status:* **done** (2efb437, G4) — `align-items: start` on `.ne-svc-grid`; e2e checks each card ends with its content.
62. [Polish] Fleet: Roll-up header "GPU utilisation · mean, last 24 h" wraps to 3 lines with a lone "h" at 1440. Cause: telemetry/FleetPage.tsx:394. Fix: Shorter header with hover text, or text-wrap: balance. (G2 #10)
   *Status:* **done** (2efb437, G4) — a `wrapHeader` column header wraps with `text-wrap: balance`; e2e checks no line is a lone short word.
63. [Polish] Logs: Log line detail: long label names overlap values (1440); at 390 the time column takes ~45 % and text wraps 2–3 words per line. Cause: styles.css:1089 (.ne-kv dt fixed 150 px), styles.css:2252. Fix: overflow-wrap: anywhere on .ne-kv dt; stack time above text at narrow width. (G3 F6+F7)
   *Status:* **done** (c0bd0e1, G7) — a label name wraps in its 150 px column; on a phone the time sits above its line. e2e at 1440 and 390 px with a long label in the stub (both failed before).
64. [Polish] Alerts inbox: Alerts Scope column repeats quota/region from the summary; "nbis-labs" breaks at the hyphen. Cause: alerts/model.ts:16 SCOPE_KEYS; AlertsPage.tsx:213-215. Fix: Omit labels the summary shows; ne-nowrap on the project name. (G3 F8)
   *Status:* **done** (d1fcc05, G7) — a label the summary already shows (whole token) is left out of the scope; the project name is one no-wrap unit. Unit and e2e.
65. [Polish] Alerts → Rules: Budget rules say "evaluated" with 0 budgets defined. Cause: alerts/engine.ts:289. Fix: reason: 'no budgets defined' when none exist. (G3 F9)
   *Status:* **done** (22668e0, G7) — root cause: the engine received only the signals, empty both when nothing crossed and when nothing existed. `BudgetService.defined()` counts budgets and credits; a budget rule with none reads not-configured "No budgets defined: add one on Budgets & credits." (credits: "No credits entered: …").
66. [Polish] Alerts → Resolved: Resolved GpuIdle alerts show raw ids and "GPU GPU-<uuid>". Cause: Stored before names were kept; summary template in platform/alerts. Fix: Omit "GPU " when the label already starts with "GPU-". (G3 F10)
   *Status:* **done** (375b57e, G7) — `tidyAlertTitle` drops "GPU " before a value that starts "GPU-", in every rendered summary and in stored titles; three tests that had recorded the repetition now expect it once.
67. [Polish] Costs: At 390 px Costs breakdown tables keep maxHeight 460, so a 4-row stacked table scrolls inside the card. Cause: commercial/CostsPage.tsx:248. Fix: Drop maxHeight in stacked mode. (G4 P1)
   *Status:* **done** (8f0e9ac, a76297b, G2) — on a phone the Costs breakdown has no 460 px box; long breakdowns keep the page-wide 75vh box (`ne-table-wrap-tall`) by design. G2 review: after a tab change the previous tab's rows stayed on screen under the new heading until the new reply came (resources listed "by project", in a tall box); the breakdown now shows as loading until the reply answers the tab and metric asked for (`reportShows`). That was the cause of this test's failure in a full e2e run.
68. [Polish] Costs: Billing imports "Charge period" column shows the billing month, not the hours covered. Cause: commercial/CostsPage.tsx:381. Fix: Rename "Billing period" or show first/last row times. (G4 P2)
   *Status:* **done** (8f0e9ac, G2) — root cause: the import span used every row, and a month-long tax row stretched it to the billing month. `ingestSummary` now spans the usage rows' hours (column "Usage hours"); imports stored earlier keep their old span.
69. [Polish] Budgets: "Projected: no live run-rate estimate (No running VMs…)" mid-sentence capital, reads as failure. Cause: budgets/BudgetsPage.tsx:384, budgets.ts:675. Fix: "nothing running to estimate since 21:16 UTC". (G4 P3)
   *Status:* **done** (b6f5a26, G2) — "Projected: nothing running to estimate since HH:MM UTC" (the last exported hour); other reasons lower-cased after the colon.
70. [Polish] Commercial cost breakdown: Unit rate / h rounds a boot disk to 0.0002; stacked breakdown at 390 is ~2,800 px. Cause: commercial/EstimateView.tsx:114. Fix: More significant digits for small rates; compact the stacked layout. (G4 P4)
   *Status:* **done** (3384c77, G2) — unit rates keep four significant digits with their unit (`fmtUnitRate`: "0.0001644 / GiB"); the cost-line table has four columns (basis with the line, discount under the hourly figure), so a phone card is four short rows.
71. [Polish] Costs: Daily chart footer always says "negative bars are credits/adjustments" even when there are none. Cause: commercial/CostsPage.tsx:180. Fix: Show the note only when a negative bar exists. (G4 P5)
   *Status:* **done** (8f0e9ac, G2) — the negative-bar note shows only when a bar is below zero (`dailyChartFooter`).
72. [Polish] Commercial: /commercial?tab=bogus falls back silently; Evidence shows "Unknown tab". Cause: commercial/scenarioDraft.ts:12 useUrlTab. Fix: Show the same "Unknown tab" notice. (G4 P6)
   *Status:* **done** (3384c77, G2) — "Unknown tab “bogus”; showing Scenarios & draft quotes." as on Evidence.
73. [Polish] Evidence → Runbooks: Rollback runbook summary is the first sentence after a code block (new case of #9). Cause: Summary extractor. Fix: Same fix as #9; add rollback to the test set. (G4 #9)
   *Status:* **done** (7c5c015, G5) — prose that follows a code block in the same section is a note on that code and is skipped up to the next heading; Rollback reads its Platform paragraph ("Roll back one component at a time (P5): …"). Only drift.md and rollback.md summaries changed across the 24 runbooks and 9 ADRs.
74. [Test gap] Commercial "Estimate unavailable"; Solutions unavailableReason / unreadable footprint / denied price; Calculator 503; page-level error + Retry on Costs, Budgets, Evidence, Solutions, Commercial; drawer "Not readable": Fallback states that render correctly live (injected) but have no test. Cause: —. Fix: Add stub/e2e tests for each. (G4)
   *Status:* **done** (7a27044, G1: Calculator 503; 67c1cbe, G2: Costs, Budgets and Commercial page-level error with a Retry that recovers, and Commercial "Estimate unavailable" with its reason, each against a stubbed 503/500) — G5 (bf66cf7, `proof-evidence.test.ts`): Evidence and Solutions page-level error with a Retry that recovers, Solutions `unavailableReason`, an unreadable footprint named in the price panel beside a priced one, and the price panel without the commercial read permission (no calculator call) ; **done** (b5bd2d9, G7): the Evidence document drawer for a path outside the allowlist (a Terraform state file, `.env`) says "Not readable through the portal" with the allowlist sentence, shows nothing of the file, no axe violations.

## SA proposal, Wave 1 (W1-P1…W1-P29)

From the SA journey redesign proposal (section 6, Wave 1: proposals 1, 2, 3 roll-up and drift, 6 slice 1,
7, 8, 16). Each wave section ends with the four checks (vision at 1440/390 px, data against its source,
freshness = the source's own lastSuccess, fallback with the source stubbed down) and a re-walk of
Jobs 3, 6, 8 and 10. Items already in 1–74 are cited by number.

### Proposal 1 — guard stateful sizes; truthful Provisioning validation (Critical)

W1-P1. Prefill every Provisioning field from the root's committed sizing file and badge each field "from sizing file" or "changed by you". Changing only the GPU node count must patch only `gpu_node_count` (training prod today yields `filestore_size_gib` 4096 → 256, staging 1024 → 256).
   *Status:* **done** (fe31b10, f8db7ec, G1) — root cause: the form prefilled filestore from the recipe's first stage and kept it on a stage change, and the domain wrote every field. The form now starts from (and re-prefills on stage change from) the chosen stage's sizing file and run profile, badges each field, and the domain writes only variables that differ from the committed sizing.
W1-P2. Any decrease of a stateful size (filestore, disks) is a validation error until the SA ticks an explicit "I intend to shrink/replace" box; offer "Reset to <committed value>".
   *Status:* **done** (fe31b10, f8db7ec, G1) — a smaller shared filesystem is an error (source: docs compute/storage/manage#how-to-resize-a-volume, "Reducing volume size is not possible") with "Reset to <committed> GiB" and an "I intend to shrink/replace" box. Disks: the form edits no disk size, so only `filestore_size_gib` is guarded (STATEFUL_SIZES in provisioning.ts is the list to extend).
W1-P3. A quota at limit 0 is an error (Prepare disabled), or needs "prepare anyway: quota request pending"; add a "Fits in: <region>" line, confirmed by the quota API, with a one-click region switch. Pairs with #27.
   *Status:* **done** (fe31b10, f8db7ec, G1) — a quota line that stops the plan is an error that disables Prepare (as preflight fails it) unless "Prepare anyway: quota request pending"; "Fits in: <region>" lists regions whose compute VM quotas are listed and all fit, with a one-click switch. The stub lists allowances in eu-north1 only, so the e2e check of the switch extends the preview reply; the region computation is unit-tested.
W1-P4. Check reserved/STRICT against capacity.v1 (capacity block groups in the tenant) and list matching reservations; turn the advisor's "fabric-N: 0 available; room now: fabric-M" into a fabric picker or a one-click "Use fabric-M". Advisor down → "availability unknown", never "fits".
   *Status:* **done** (fe31b10, f8db7ec, G1) — reserved requests are checked against the tenant's capacity block groups (STRICT with none matching: error; AUTO: warning; not read: unknown) and the matching ones listed; an InfiniBand fabric picker (regions.yaml fabrics, written as `infiniband_fabric`); advisor options become "Use fabric-N" / "Use <region>" only where regions.yaml offers them; an advisor not read is "availability unknown".
W1-P5. Always show the diff and the estimate, even when policy or quota errors block Prepare.
   *Status:* **done** (fe31b10, f8db7ec, G1) — the diff, live price and estimate are produced whenever the stage and region resolve; only Prepare refuses errors.

### Proposal 2 — price with no setup; rate-book lifecycle; honest headline (Critical)

W1-P6. A built-in, read-only "Nebius list price (live calculator)" price source, always available, so a scenario can be created with no rate book; a rate book becomes an optional overlay (discount %, or an imported negotiated book). Pairs with #49.
   *Status:* **partly done** (b51e910, a76297b, G2) — built-in "Nebius list price (live calculator)" source (`nebius-list-price`): a scenario can be created and priced with no rate book; the backend builds a book per estimate from the scenario's presets and storage specs at the calculator's list price in its region (`listPriceBook`). Imported books are listed first. G2 review: the source is labelled "built-in Nebius list price (live calculator)", never "user rate book" or "entered by you", and the draft quote no longer compares it with the live price (itself); the New scenario form's hints name platform/regions.yaml and "reserved" is not offered with it (e2e). Deferred: the discount-% overlay on the live list price (a rate book still overlays only by being chosen instead); a reserved scenario's compute stays a pricing gap (a reservation's own price is not read), now only for scenarios edited to reserved after creation.
W1-P7. "Create book from current list prices" (pick regions and platforms), a downloadable template, CSV upload, and a preview/validate step before commit.
   *Status:* **done** (b51e910, G2) — "Build from current list prices" (regions and platforms from platform/regions.yaml; `POST /ratebooks/from-list-prices`, not stored), a downloadable CSV template (`GET /ratebooks/template.csv`), CSV upload validated row by row (`rateBookFromCsv`), and a preview with Save / Discard before anything is stored. Not changed: the existing JSON import still stores a schema-valid book at once (no preview step).
W1-P8. Rate-book lifecycle: Archive/Delete (audited) and "Set as portal default" stored in the database; each tile that uses a book says "priced with book X" and warns on the id fallback.
   *Status:* **done** (c38da3f, 78c18da, G2) — archive / restore (audited; never a default, not offered for new scenarios, still prices its scenarios), "Set as portal default" stored in the database (migration 20261013000000; order: configured, portal default, only active, first active by id), and the run-rate tiles name the book, with a "first rate book by id" warning and a link to set a default. G2 review: with every book archived the run-rate says "Every rate book is archived", not "No rate book has been imported".
W1-P9. If any GPU or compute line has no rate, the headline and the selling price become "Incomplete: N lines unpriced" with no total. Pairs with #50.
   *Status:* **done** (14ccda9, G2) — `estimateHeadline`: with an unpriced GPU, vCPU or RAM line the headline reads "Incomplete: N lines unpriced" with no total and no selling price (`sellingPriceWithheld`); the footprint and sensitivity tables say "incomplete"; Provisioning's estimate card uses the same rule. Correction (G2 review): quote.json still carried the incomplete footprint's hourly, run-period and monthly sums of the priced lines (a boot disk without its GPU); it now carries each footprint's `headline`, and an incomplete footprint's totals and sensitivity figures are `null` with `totalsWithheld` (`quoteDocument`, router test).
W1-P10. The Overview rate-book tile counts agree with the live tile (an import read "0 priced, 0 without a rate" while the live tile counted 1 and 1).
   *Status:* **done** (e649889, 4dba927, G2) — root cause: `estimateRunRate` skipped managed PostgreSQL and MLflow, which the live run-rate counts. They are listed without a rate; both tiles say "N resources priced, M without a price" and the rate-book tile names what has none. G2 review: the live tile's breakdown no longer adds a second count in another unit ("19 priced line(s)"); it reads "Price breakdown by kind of resource". Size-less disks are no longer dropped by the live path: they are named unpriced (#15, b27eb49, G4).

### Proposal 3 — proof from evidence: roll-up and drift (Critical)

W1-P11. Each Solution card gets a proof roll-up computed from its recipes' evidence-index rows: one chip per recipe (Live run / Live plan / Mocked / Offline / Not measured) with date and link; status pills are derived, not hand-written. Pairs with #38.
   *Status:* **done** (11dde27, bf66cf7, G5) — each run of this repository gets a level from its evidence (`evidenceRunLevel`: Measured from its index row, Live run for an apply or a script run, Live read / plan for a plan or read-only run); `recipeProof` takes a recipe's strongest level and newest file; a recipe with no live run keeps its README Offline-ready / Mocked only level, else "Not measured". A unit test on the real repository checks the computed level equals the README What is proven level of all 16 recipes. Each Solution card shows the derived line ("3 of 6 recipes run live · 1 planned or read only") and one chip per recipe (level, last live date that opens the file). Chip words are the README levels (Measured, Live run, Live read / plan, Offline-ready, Mocked only, Not measured), one vocabulary with the Evidence page.
W1-P12. A drift banner on a Solution whose README proof rows disagree with the evidence index, and a CI check that fails on the same mismatch (it must fail on the current S1/S9 rows until they are reconciled).
   *Status:* **done** (11dde27, bf66cf7, G5) — `solutionProofClaims` reads the index Status cell, the README Status row and every section 10 row; `proofDrift` flags a clause naming a recipe that says "not run" while the recipe has a Live run / Measured file, or "not measured" while it is Measured (a plan is not a run; a clause with no recipe continues the one before). CI check: `plugins/nebius-estate-backend/src/repo/solutions.test.ts` (run by `yarn test:all` in the CI portal job). Before the rows were reconciled it failed with 10 rows: S1 (R8, R12), S3 (R11), S6 (R1, R8), S7 (R2), S9 (R8, R12 in the index, Status row and section 10). Banner on the card, e2e with an injected drift. Limit: only claims that name an `R<n>` are checked; prose without a recipe id (S4's spot-cap row) was reconciled by hand.
W1-P13. A "last live run" date per recipe = the newest evidence or results file; a recipe without evidence reads "Not measured", never blank. (Indexing results/*.json as raw measurements beyond the date is Wave 2+.)
   *Status:* **done** (11dde27, bf66cf7, 2acf617, G5) — `recipeProof.lastLive` is the date of the newest live evidence file of the recipe, shown on Solution chips (opening the file) and beside the level badge in each Evidence recipe card's header ("last live 2026-10-12"); none reads "Not measured". In the header, not a new row: a row pushed the Recipes tab to 8,468 px at 390 px, over the N5 8,000 px budget. Results files are not read: the portal may not list `results/`, and the only committed results folder (2026-10-12) is cited by evidence files of the same date, so no date differs (see Deferred).

### Proposal 6, slice 1 — capacity cards (High)

W1-P14. Capacity cards show the effective limit min(project cap, tenant) with "capped by project", and dependency badges (GPU clusters cap 0 → 8-GPU InfiniBand presets unusable). Allowances unread → "project cap unknown", tenant value labelled as tenant.
   *Status:* **done** (a0164d4, G3) — `tileLimit`: under a project filter a GPU card leads with "Effective limit for <project>: usage / cap" and "capped by project" (the card's level follows the cap), or says the tenant limit applies; without a filter it names the projects capped below the tenant limit; with no project allowance read it says "Project cap unknown". The tenant figure is labelled "Tenant". `gpuClusterBlock`: a GPU clusters limit or cap of 0 in the region puts "GPU clusters cap 0 (<project>): 8-GPU presets cannot join an InfiniBand GPU cluster" on the cards of models the live platform list gives an 8-GPU preset, none when the list is unavailable (docs: compute/clusters/gpu; an 8-GPU VM without a GPU cluster still runs, without InfiniBand). The stub has no project cap on a GPU quota; the e2e adds one to the /capacity reply in the test.
W1-P15. Each region gets a "Usable by K8s recipes" line (a non-GPU vCPU limit of 0 blocks every K8s recipe there).
   *Status:* **done** (a0164d4, G3) — each region with GPU quota (the regions the Quotas card lists) has "Usable by K8s recipes: yes / full / no CPU nodes / unknown" from the non-GPU vCPU allowance (tenant, or the filtered project's lower cap; with project caps only and no filter, the highest cap with its project named), naming projects capped at 0, so one project at 0 does not read as the whole region blocked. Worded from docs/capacity.md: a limit 0 stops the recipes' CPU node groups; only a GPU-only run (cpu_node_count = 0) starts, so "blocks every K8s recipe" is not claimed.
W1-P16. Search in "All tenant quotas" covers every row (it returned "0 of 455" behind a hidden filter).
   *Status:* **done** (a0164d4, G3) — root cause: the search applied on top of the near-limit filter, which is on by default above 50 rows. A search now covers every row; the count says "(search covers every row)" and the filter checkbox is disabled while searching. "tenant" matches tenant allowances.
W1-P17. Platforms the live API offers (e.g. GB300) are first-class cards.
   *Status:* **done** (a0164d4, G3) — `platformsWithoutQuota`: a GPU platform the live API offers in a region with no `compute.instance.gpu.<model>` allowance there gets a card in that region (GB300 in eu-north1 on the stub: name, presets, "no quota listed"); its quota name is not documented, said as such.
W1-P18. The Reservations empty state links capacity-request.md and the Nebius docs instead of a dead end.
   *Status:* **done** (a0164d4, G3) — the empty Reservations state (tenant or region) links runbooks/capacity-request.md at its reservation step in the document viewer and docs.nebius.com/compute/virtual-machines/reservations.

### Proposal 7 — budgets and credits that alert on time (High)

W1-P19. Re-evaluate budget signals on every budget, credit or spend-entry write; deleting a budget resolves its alerts at once with reason "budget deleted" (a deleted budget kept 3 alerts firing for ~14 min).
   *Status:* **done** (b6bd84e, G2) — every budget, credit or spend-entry write re-evaluates the budget alerts before it answers (`AlertEngine.reevaluateBudgets`, serialised with the sync's evaluation); a deleted budget's alerts resolve at once with "Resolved: budget deleted."
W1-P20. Two forecast lines, "if nothing new runs" and "at this period's average burn"; withhold the forecast with a reason when history is too short or there are no billing rows. Pairs with #69.
   *Status:* **done** (b6f5a26, G2) — "at this period's average burn" and "if nothing new runs" (spend so far + the live run-rate of what runs now) per budget; each withheld with its reason (under a day of spend, no billing rows, another currency, no run-rate, Token Factory).
W1-P21. A "credit-exhausting" (amber) signal; a missing expiry shows grey, never green. Pairs with #36.
   *Status:* **done** (b6bd84e, G2) — `credit-exhausting` signal and alert (CreditExhausting; amber, critical within 3 days; runbook row in runbooks/finance.md); a credit without an expiry is grey, never green.
W1-P22. One spend entry per day: a second same-day entry prompts replace instead of summing silently; billing as-of on each budget row.
   *Status:* **done** (58c981f, G2) — a second spend entry for a day is refused (409 naming the entry) and the drawer saves it as a replace, said before Save; each budget row says "billing through …" / "entered through …". G2 review: the route's check was read-then-write; the database now holds a unique provider-and-day key per tenant (migration 20261013010000; days entered twice before it keep both rows), and a violation is the same 409.
W1-P23. "Open in Costs" scoped to the budget, and a scope preview while typing the amount.
   *Status:* **done** (58c981f, G2) — "Open in Costs" with the budget's period, project and region, naming the conditions Costs cannot apply (`budgetCostsLink`); the budget drawer previews the scope's spend this period against the amount while it is typed (`POST /budgets/preview`).

### Proposal 8 — one Fix per Unavailable; day-one checklist (High)

W1-P24. Every "Unavailable" carries exactly one primary Fix link to the page where the fix happens (e.g. `/commercial?tab=ratebooks` for the run-rate book); a scripted click test opens each.
   *Status:* **partly done** (9b390d3, G6) — the Overview: every Unavailable tile and attention row has one "Fix: … →" link (`fixFor`: access roles, Rate books, Costs, alert rules, or the connector on Integrations); the e2e takes four sources down and opens each. Review fixes (G6 review): "Temperature and power unavailable" on a GPU tile that shows a value now carries its own Fix (the tile's own Fix covers it when the tile is Unavailable). Scope, stated: one Fix per tile, so the live run-rate tile's fallback line ("unavailable (…)" for the rate book) has none of its own; the tile's Fix and the Rate-book tile beside it carry the rate-book fix. Open: the Unavailable states of other pages (see Deferred).
W1-P25. A day-one setup checklist (connected, billing export, rate book or list price, budgets, label map, K8s access), each item with to-do, in-progress and done states.
   *Status:* **done** (cd1180f, G6) — at the top of Integrations (`setupChecklist`): each step to do, in progress, done or not applicable from what the portal reads, with the page of the next step. Review fix: a read still loading is "checking" and one that failed (a 500) is "unavailable" with its error, neither counted in "N of 6 done" (the title names them); only a refusal (403) says "Not readable with your role" (`Unread`, `setupProgress`; unit and e2e cases for a slow reply, a 500 and a 403). "Label map" is read as the nip-* attribution (resources with no labels and nothing that explains them, the Explorer's Unattributed rule).
W1-P26. Coverage stated against the docs catalog (docs/reference/nebius-docs.md): "reads N services; not read: …", each with reason and impact. Pairs with #11.
   *Status:* **done** (02b172a, G6) — `docsCoverage`: "Reads N of M service sections of the Nebius docs catalog; not read: …", each section with the calls that read it, and for one not read or not answering, why and what it leaves out (applications: no call; standalone applications are not listed). `DOCS_SECTIONS` classifies every catalog section; a test fails on one it does not know. On the Nebius docs page and on Integrations. Review fixes: the Nebius docs page states coverage only once `/integrations` answers (loading, or "Coverage unavailable: <error>" with no "not read" verdicts; e2e routes it to a 500); Slurm (Soperator) is read only through the Kubernetes calls of clusters identified as Soperator (`soperatorClusterIds` on `/integrations`, the Workloads card's rule), else "No Soperator cluster in scope"; both pages read the calls through `observedState`.

### Proposal 16 — Integrations signal hygiene (Medium)

W1-P27. Group failures into incidents ("1 sync failed across 35 calls; recovered 16:38"); a call is flaky only on independent or recurring failures. Same root cause as #28 and #35.
   *Status:* **done** (9670e20, G6) — same change as #28 and #35: one Integrations callout lists each incident with its time, connector, call count and recovery.
W1-P28. A grey "not applicable" state (no cluster) excluded from gap counts. Pairs with #54.
   *Status:* **done** (9670e20, G6) — optional and not-needed connectors are a grey "not applicable" group: grey chips in the counts, never in the attention figure, folded on Integrations (#54); the setup checklist marks Kubernetes not applicable without a cluster.
W1-P29. Every count chip is a filter link, and the summary and the filter share one count. Same as #7.
   *Status:* **done** (9670e20, G6) — each count on the Overview and above the Integrations table links `/integrations?connectors=<state>`; the table then lists exactly that many (`connectorFilterState`), e2e for every chip. Review fix: the Healthy group reads "Healthy connectors (H of N ok)", and an ok connector open for a look is named with why ("GPU telemetry: flaky …") under "Counted ok, open here for a look" (`lookReason`); e2e checks the two counts.

## Wave 1 verification follow-ups (2026-10-13)

From the section-by-section verification of `wave1` (stub, live read-only and `main` as the before; report kept
locally, not in git). #55 stays with the owner (a Nebius write).

V1. [a11y serious] Estate Explorer graph: every node and expand toggle failed WCAG 2.5.3 Label in Name (axe 4.14
   `label-content-name-mismatch`); the suite's pinned axe-core 4.13 has the rule experimental and off.
   *Status:* **done** (8394859, ecd52ec) — every e2e axe run starts from `e2e-tests/axe.ts`, which enables the rule
   (no dependency upgrade). A node's name starts with what it shows, label then type line, the full ones after a
   colon when the box cut either (`graphNodeName`); the toggle is "+5 Expand …". The rule then found the Budgets
   "Open in Costs →" link named "Open budget … in Costs"; it is "Open in Costs: budget …".
V2. [a11y serious] Alerts, dark theme: a selected row's "critical" badge was 4.34:1.
   *Status:* **done** (9623dfc) — dark `--ne-danger` #f07167 → #f27a70 (4.67:1 on a selected row); every other badge
   tone on a selected row is 4.79:1 or more in both themes, light unchanged. e2e: each alert row selected, both themes,
   1440 and 390 px. The full run then caught the live price faded to 3.67:1 while updating (5be09f9: a dotted
   underline instead of opacity).
V3. [Confusing] Rate book: "done / optional" on Integrations, "Unavailable" on the Overview, and Provisioning blocked.
   *Status:* **done** (d4b37f9) — the code's model (W1-P6): a rate book is optional while the calculator answers.
   `/runrate` says `rateBookOptional`; the Overview tile reads "Not set (optional)" with no Fix (Unavailable with its
   Fix only when the calculator is down too); `/provisioning/estimate` prices at the list price with no book in use and
   its coverage names the missing prices; 409 only with neither.
V4. [Confusing] Provisioning hid the diff until a request reference was typed (W1-P5).
   *Status:* **done** (e6087f1) — an empty reference parses and is the error that disables Prepare; the diff and the
   estimate preview without it; the run sheet (nip-run, RUN=) waits for it. Quota ids in messages wrap at 390 px,
   200 % text.
V5. [Freshness] Empty Overview and Capacity tiles showed no as-of time.
   *Status:* **done** (d192c45) — as of the list that answered: the cluster list (GPU demand, pod requests), the VM
   list ("No GPUs running"), the priced inventory lists (the live run-rate's "nothing running").
V6. [Polish] Logs opened on a bucket with no lines.
   *Status:* **done** (172abf9) — `/logs/buckets` gives each listed bucket's newest line (`newest`); with no query in
   the link the page keeps the serial-console errors preset while that bucket has lines, else opens on the bucket
   that wrote last and says why.
V7. [Polish] Budgets config row, Commercial select, Solutions labels.
   *Status:* **done** (c3aa8d9) — a config budget says "billing through …"; the New scenario Rate book field is two
   columns wide (the list-price name no longer cut at 1440 px); Solutions rows read "Recipe proof (evidence)" and
   "Solution status (README)". The drift check's R-number limit stays as documented under W1-P12.

## Work groups (open items only)

Seven groups by page and area, so that no two groups edit the same files where that can be avoided,
in risk order: data safety and misleading figures first, then accessibility, confusing, polish. Within a
group the same order applies. Done items (1, 3, 8, 14, 23) are not listed. Known shared files are named
under each group; the later group rebases onto the earlier one.

| # | Group | Items | Shared files |
|---|---|---|---|
| G1 | Provisioning and run profiles (data safety) | 27 (with 3 and 14 done: one run-profile model for Provisioning and the Capacity calculator, same inputs as `scripts/preflight.py`), W1-P1, W1-P2, W1-P3, W1-P4, W1-P5, 13 (Provisioning quota card stamp), 43, 74 (Calculator 503) | `capacity/Calculator.tsx` is G1's only |
| G2 | Money: Commercial, Costs, Budgets and credits | W1-P9, W1-P6, W1-P7, W1-P8, W1-P10, 36, W1-P19, W1-P21, W1-P20, W1-P22, W1-P23, 12, 47, 49, 50, 69, 70, 67, 68, 71, 72, 74 (Commercial, Costs, Budgets parts) | `overview/parts.tsx` (credit and rate-book tiles) with G6 |
| G3 | GPU and Capacity (done: W1-P14..W1-P18, 52, 58, 59; 33 partly done) | 33, W1-P14, W1-P15, W1-P16, W1-P17, W1-P18, 52, 58, 59 | `ui/components/charts.tsx` (#52) |
| G4 | Inventory, Fleet, Workloads, AI services (data correctness; done) | 13 (remaining full-sync-only stamps), 15, 16, 17, 34, 53, 18, 20, 22, 60, 61, 62 | `ui/components/primitives.tsx` (#60) with G7 (#40); `styles.css` |
| G5 | Evidence and Solutions (proof claims; done) | 38, W1-P11, W1-P12, W1-P13, 48, 9, 73, 10, 74 (Solutions, Evidence parts) | `EvidencePage.tsx` with G7 (#39, one line) |
| G6 | Overview and Integrations (counts, fixes, coverage) | 7 / W1-P29, 35, 28 / W1-P27, W1-P24, 2, 4, 44, 25, 24, W1-P28, W1-P25, W1-P26, 11, 5, 6, 54, 57 | `overview/parts.tsx` with G2 |
| G7 | Alerts, Logs, Estate Explorer (misleading, then a11y) | 37, 39, 40, 41, 51, 42, 46, 45, 29, 55, 30, 31, 32, 19, 26, 21, 56, 63, 64, 65, 66, 74 (drawer "Not readable") | `styles.css` (Markdown, log rows, chips); `primitives.tsx` with G4 |

## Deferred

- Gates (G5 run, 2026-10-13): the full e2e suite is not clean on a quiet machine, for a reason outside G5. When it
  runs in about 3.5 min, the later price tests (`pricing-tables` F1.17, `solutions-budgets` "Price this footprint",
  `live-audit-commercial` W1-P7) get "Too many live-price requests: try again in 1 s (each user may price 30 at once,
  then one every 1 s)": one backend serves the whole run, and the per-user calculator bucket (`CALCULATOR_RATE`,
  `lib/limits.ts`) empties. Shown not to be G5's: the suite without `proof-evidence.test.ts` failed the same way
  (2 failed, 295 passed); G5's own e2e answers its live-price requests itself (76640a0). A slower, loaded run (5.6 min)
  did not hit it. Two other failures seen once each under heavy load and passing on rerun: `budgets-ai` W1-P21 (credit
  delete toast) and timeouts across Capacity pages. Next step (owner's choice): a test-only calculator rate in the e2e
  config, or price tests that answer their own calculator calls.
- W1-P13 (G5), results files: the "last live run" date comes from evidence files only. `results/<date>/` is not on the
  portal's read allowlist; every committed results folder is cited by an evidence file of the same date, so the date is
  the same today. Next step, with Wave 2's indexing of results/*.json: allowlist `results/<date>/*.json`, map each to
  its recipe through the evidence file that cites it, and take the newer date.

- W1-P6 (G2), discount-% overlay on the built-in live list price: not built. A rate book is still chosen instead of
  the live price, not layered on it; layering needs a rule for which lines a percentage applies to and how it is
  shown beside the live total. Next step: a `discountPercent` on the scenario when the source is `nebius-list-price`,
  applied through the existing discount-rule path.
- W1-P7 (G2), preview step for the JSON import: the JSON import stores a schema-valid book at once, as before; the
  preview covers the list-price and CSV paths. Changing it changes every e2e test that imports the test book.
- Gates (G2 run, 2026-10-13), closed after the G2 review: the full e2e suite was run on the base 0ea0fa4 and on wave1.
  Base, two runs: 256 passed; then 1 failed (`owner-review.test.ts` N5, nebius-light: "Expected > 10, Received 0"
  recipe cards), so N5 is not G2's. Wave1 before the fixes, one run: 4 failed: N5 (dark), F1.37b (dark and light,
  0 resource ids counted) and G2's own #67 test (`maxHeight` 633 px, not "none"). Causes: N5 and F1.37b read a
  count with `count()` / `evaluateAll`, which do not wait, before the page's data rendered (slower under a loaded full
  run); they now wait for the 11th card or id first. #67 was a real defect on screen: after a Costs tab change
  `useGet` kept the resource rows under the "by project" heading, in a tall box, until the reply came; the
  breakdown now shows as loading until its reply answers the tab and metric (`reportShows`), and the test waits for
  the project rows. Wave1 after the fixes, two full runs: 267 passed each, no retries. The dark-theme Logs failure
  seen earlier did not recur in these four runs; not investigated further.
- #33 (G3), the rest: billing rows are not used for the backfill. A day's GPU-hours from billing give no peak count of
  GPUs present, and telemetry already counts each GPU that reported; billing would only add VMs without DCGM series.
  vCPUs on backfilled days stay as recorded (no source). The live check of peaks during a sync window needs the live
  account. Next step: on the live portal, read `/history?days=30` after a restart and confirm 10-11 and 10-12 show the
  GPUs that ran, marked incomplete.
- Shared files (G3): `OverviewPage.tsx` (Trends pass the incomplete reason, two lines; G6's page), `operate.ts`
  (returns its sample store) and `ui/styles.css` (one block after the Capacity rules).
- W1-P24 (G6), the other pages: only the Overview's Unavailable tiles and attention rows carry a Fix link. The shared
  `StatTile` and the Capacity, Fleet and Provisioning "Unavailable" states still show their reason without one; they
  belong to other groups' pages and need their own source-to-page map. Next step: give `StatTile` an optional `fix`
  (`fixFor` from overview/model.ts) and extend the click test to each page.
- W1-P25 (G6): the checklist is on Integrations only, not summarised on the Overview (that would add three reads to the
  Overview and its phone budget). Next step, if wanted: a one-line "Day-one setup: N of 6 done →" beside the
  connector counts.
- #11 (G6): the e2e runs without the docs mirror (this checkout has none; it is written by `make docs-catalog` on the
  network). The mirrored drawer was checked by hand with three mirror pages; MDX components other than the common
  ones (cards, tabs, notes, icons) may still show as text.
- Gates (G6 run, 2026-10-13): tsc, lint:all, `CI=1 yarn test` (1,211 passed, 3 skipped), config:check,
  `make ci-docker TARGETS="ci"`, gitleaks on the branch diff and the real-id grep pass. Full `CI=1 yarn test:e2e`: the
  first run found ten G6 regressions, fixed in a2ed8d3; the second run had 334 passed and 2 failed, `pricing-tables`
  F1.17 and `live-audit-commercial` W1-P7, both the live-price rate limit already listed above ("Too many live-price
  requests" in the W1-P7 page; F1.17's preemptible row did not share the region reason). Both files pass alone
  under CI (25 passed). G6 changes no pricing code; the next step is the one named above.
- Gates (G7 run, 2026-10-13): tsc, lint:all, `CI=1 yarn test` (1,255 passed, 3 skipped), config:check,
  `make ci-docker TARGETS="ci"`, gitleaks on the branch diff and the real-id grep pass. Full `CI=1 yarn test:e2e`, three
  runs: the first found one G7 regression (owner-review S4 addressed the tenant node by its id; fixed in 98d932b), then
  373 passed and 2 failed in each of the last two runs, every failure a live-price test whose page reads "Too many
  live-price requests" (W1-P7, G5.12, G5.14, G4 #15: a different pair each run; they pass alone). G7 changes no
  pricing code; the next step is the one named above. During the run another session's worktree took ports
  3100/7107/7199 while this one restarted its servers, so one e2e run read the other checkout's app; it was discarded.
  Parallel groups need their own e2e ports (a port offset in `playwright.config.ts` and `app-config.e2e.yaml`).
- #19 (G7): no e2e; the stub has no running root within six hours of its TTL (the signal, the stored title and the
  rule are unit-tested). Next step, if wanted: a stub VM whose `nip-ttl-expires` is set relative to the stub's clock.
- #29 (G7): `status.assignment` on pools is documented (Terraform provider reference) but not yet seen in a live list
  answer. Next step: on the live portal, open an `auto-…` pool in the Explorer and check it reads "attributed via
  subnet …"; if not, the field is absent live and the pool keeps the plain "No nip-* labels" sentence.
- #32 (G7): not reproduced; guarded. The route's `pending` flag has no route test (the test backend cannot be held
  inside its first sync); the frontend rule is unit-tested.
- #55 (G7): the live `tfstate-nip-foundation-…` bucket was created before the bootstrap labelled buckets and stays
  unattributed until the owner runs the `nebius storage bucket update --id … --labels …` command the bootstrap now
  prints (a Nebius write: not done here).

- Merge of main v0.3.1 (a3c4730): the state-bucket create keeps both sides (the region's storage class for lab in
  uk-south1, and #55's nip-* labels); the bootstrap test checks both on one create. After the merge the evidence index
  computed R1 as Live run (its 2026-10-13 row records session 1, then the Measured retry) and R10 as Measured (planned
  in the same file); fixed in 0e2a6f9 (any clause starting "Measured" counts; a measurement is the run's own recipe's).
- Independent G4 review (2026-10-13, after the G7 pass): each of 13, 15, 16, 17, 18, 20, 22, 34, 53, 60, 61, 62 closes
  its item and has a test that fails without it (unit tests for the mappers, quantities, job outcome, node state,
  read times, drawer link and estate-check.sh; inventory-workloads e2e for the drawer, the unpriced disk, the
  workloads page, AI services and the Fleet layout). Fixed: #20 a list with no capability record counted as answered
  (d48aba1); #53 the Workloads empty state carried the full-sync time (ec02b36); #17 a sub-millicore total rounded to
  0.001 (f371f88). Left as they are, with the reason: `readTime` leaves a list that never answered out of the oldest
  time (the card's own note or the Integrations page names the failed list; marking every card "not read" is a
  wording change for the next pass); a suspended Job reads "not ready" (not in the item; the stub has none); a plain
  count of 1000 or more is written in k or Ki form (equal value; requests are CPU and bytes in practice).
- e2e flakes (2026-10-13): N5 measured each page after networkidle and a 500 ms sleep (a page still loading passed
  its height budget and skipped the value-column check); it waits for each page's loaded marker and no skeleton.
  F1.37b pressed "Expand all" before the graph loaded; it waits for the tenant node and the table rows. The
  dark-theme Logs "Test data" note: `useMeta` fetched `/meta` once and kept a failure for the page's life, so one
  failed call under load left the page without its banner; it now asks again every 3 s (b660e97, unit-tested). Not
  reproduced directly; the e2e sweep also waits for no loading skeleton before axe (71979c9). The same kind of race
  in `capacity-overview` F1.38 review (Capacity's blocked-roots badge counted before it rendered: 0 against the
  Overview's 2) now reads the count once the capacity reply rendered and waits for the badge.
- Gates (verification follow-ups V1–V7, 2026-10-13): tsc, lint:all, `CI=1 yarn test` (1,276 passed, 3 skipped),
  config:check, `make ci-docker TARGETS="ci soperator-check scan links"`, gitleaks on the branch diff and the real-id
  grep pass. Full `CI=1 yarn test:e2e`: enabling `label-content-name-mismatch` found the Budgets "Open in Costs" link
  (ecd52ec); the runs then found a faded live price below contrast (5be09f9), a select test racing the scenario
  list and the W1-P25 checklist read mid-load (09fa337, b32dc64); the last two runs passed 388 of 388 each. No
  live-price rate-limit failure in these runs; it stays a known risk (above).
