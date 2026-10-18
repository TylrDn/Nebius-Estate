# Changelog

This repository starts with a cleaned source snapshot on 2026-10-18. The entries below
record development milestones; their old tags and commit history are not published here.
Publication polish updates repository links, first-run instructions and verification records,
and removes obsolete history-specific scanner exceptions. No new live deployment is claimed.

## Unreleased

Public release preparation. No recipe, stack or portal behaviour changes.

- Apache License 2.0 (`LICENSE`) and a `NOTICE` with the Nebius Solutions Library attribution for the
  Soperator patch and overrides.
- README: an independence disclaimer, a shorter opening with a "Start here" path, a one-paragraph status
  summary under "What is proven", and a License section.
- Repository conventions: the project policy is now `AGENTS.md`; dated plans moved to `docs/plans/` (every
  link, script comment and the portal's allowed-path rule updated).
- `SECURITY.md` (private reporting through GitHub, scope, what to do on finding a secret or real ID), issue
  forms (bug report with a recipe picker and an ID-hygiene check, recipe request) and a pull request checklist.
- `.gitleaksignore`: six test fixtures and a vendored Yarn release in `fb08179` listed by fingerprint, so
  scanners without the `.gitleaks.toml` allowlist report a clean history.

## v0.4.0 — 2026-10-14

Wave 1 of the Nebius Estate portal, "correct and trustworthy": the follow-ups from the 2026-10-12 live session
and its verification (items 1–74) and the Wave 1 items of the SA journey redesign (W1-P1…W1-P29), in seven
groups, then the fixes from a section-by-section verification of the branch (V1–V7). After this release nothing on
screen should be wrong where the portal is still incomplete: no silent stateful shrink in Provisioning, no total
built on an unpriced line, no proof claim that contradicts the evidence index, no count that disagrees with its own
table. Every item, its commit and root cause: [Wave 1 backlog](docs/plans/2026-10-13-wave1-backlog.md).
No live run is part of this release; the portal still only reads Nebius (GET plus the billing calculator POST).

### Provisioning and run profiles (G1, data safety)

- One run-profile model (`runProfileSizing`: the sizing file, then the profile's vars, as `make plan PROFILE=` and
  `scripts/preflight.py`) for the Overview's planned quota check, the Capacity calculator and Provisioning, which
  gets a Run profile select (#3, #14, #27).
- The form starts from the chosen stage's committed sizing and badges each field "from sizing file" or "changed by
  you"; only the variables that differ are written (W1-P1). A smaller shared filesystem is an error until reset or
  an explicit "I intend to shrink/replace" (W1-P2).
- A quota that stops the plan disables Prepare unless "Prepare anyway: quota request pending", with "Fits in:
  <region>" and a one-click switch (W1-P3); reserved requests are checked against the tenant's capacity block
  groups, with an InfiniBand fabric picker (W1-P4).
- The diff, the live price and the estimate show whenever the stage and region resolve, also before a request
  reference is typed; Prepare and the run sheet wait for it (W1-P5, V4).
- Calculator quota lines say their units ("in use 0 GiB + needs 4.27 TiB > limit 4 TiB"; #43).

### Money: Commercial, Costs, Budgets and credits (G2)

- A built-in "Nebius list price (live calculator)" price source: a scenario is priced with no rate book (W1-P6);
  a rate book can be built from current list prices or a CSV, previewed before Save (W1-P7), archived, restored and
  set as the portal default (W1-P8).
- A rate book is optional while the calculator answers, and the pages agree: Integrations says done, the Overview
  tile "Not set (optional)", and a Provisioning estimate without a book is priced at the list price, naming the
  prices it lacks (V3).
- With an unpriced GPU, vCPU or RAM line a headline reads "Incomplete: N lines unpriced", with no total and no
  selling price; any other total names the lines it leaves out (W1-P9, #50). The two run-rate tiles count the same
  resources in the same words (W1-P10).
- Credits without spend entered are "Unverified", "≤" their amount and grey, never green "Active" (#36, W1-P21); a
  credit-exhausting alert; budget alerts re-evaluate on every budget, credit or spend write, and a deleted budget's
  alerts resolve at once (W1-P19); two forecast lines with what each assumes (W1-P20); one spend entry per day, and
  "billing through …" on every budget row, configured ones included (W1-P22, V7); "Open in Costs" scoped to the
  budget and a scope preview while typing (W1-P23).
- Costs, Budgets and the Overview say the next export pull and, when the cadence is regular, the next file expected
  as an estimate (#12); resource labels carry their type, usage hours replace the billing month, and polish (#47,
  #67, #68, #69, #70, #71, #72).

### GPU and Capacity (G3)

- Capacity cards lead with the effective limit, min(project cap, tenant), say "capped by project" or "Project cap
  unknown", and badge "GPU clusters cap 0: 8-GPU presets cannot join an InfiniBand GPU cluster" (W1-P14); a
  "Usable by K8s recipes" line per region (W1-P15); search over every quota row (W1-P16); GPU platforms the live
  API offers without a listed quota get their own card, e.g. GB300 (W1-P17); the empty Reservations state links the
  capacity-request runbook and the Nebius docs (W1-P18).
- History days recorded before the per-day peak are back-filled once from GPU telemetry and drawn hollow with the
  reason (#33, partly); charts use whole-number ticks and say "No samples in these days" (#52); layout fixes
  (#58, #59).

### Inventory, Fleet, Workloads and AI services (G4, data correctness)

- Figures carry the read time of the lists they span, not the snapshot time; empty states are as of the list that
  answered them, on the Overview and Capacity too (#13, #53, V5).
- CSI disks read every documented size unit, and a size-less disk is named unpriced (#15); failed Jobs read red
  "failed (<reason>)" (#16); Kubernetes quantities are summed (#17); namespaces and node state on Workloads, the
  Soperator card only with a Soperator cluster in scope (#18); registries and MLflow on AI services (#20);
  `estate-check.sh` uses the portal's attribution (#22); a deleted node group is not linked from Fleet (#34); tile
  and card layout (#60, #61, #62).

### Evidence and Solutions (G5, proof claims)

- Each Solution card shows a proof line and one chip per recipe derived from `docs/evidence/` (level, last live
  date that opens the file, or Not measured), beside the README's own status, labelled as the whole solution's
  (W1-P11, V7). A banner, and a CI test in `solutions.test.ts`, flag a README proof row that names a recipe as not
  run or not measured while the evidence says otherwise; the README rows of S1–S7 and S9 were
  reconciled with the evidence (W1-P12, #38). Evidence recipe cards say their last live run (W1-P13).
- ADR and runbook summaries skip commands and the notes on code blocks (#8, #9, #73); a recipe card leads with its
  own runs (#48); evidence titles keep their date on one line (#10).

### Overview and Integrations (G6, counts, fixes, coverage)

- Connector counts name each state once, and every count chip is an Integrations filter that lists exactly that
  many (#7, W1-P29); failures are grouped into incidents by connector, so one connector's failed sync is not "every
  connector at once" (#28, #35, W1-P27); optional and not-needed connectors are a grey "Not applicable" group (#54,
  W1-P28).
- Every Unavailable tile and attention row on the Overview has one "Fix: … →" link to where the fix happens
  (W1-P24, Overview only); a day-one setup checklist on Integrations (W1-P25); coverage stated against the Nebius
  docs catalog (W1-P26) and a Nebius docs page (`/nebius-docs`, the sixteenth page) with a document drawer (#11).
- Quota-cap rows name the project and suggest acknowledging an intended cap (#2, #4); "Needs attention" is a list
  that cannot stay folded on a wide screen (#25, #44); on a phone the filters fold into one control and the first
  figure is on the first screen (#24); the billing export's last import is information, by file name and month (#5,
  #6); the capability matrix fits its card (#57).

### Alerts, Logs, Estate Explorer and accessibility (G7)

- Audit events with an ERROR, FAILED or CANCELLED status read "failed" (#37); alert values say their unit and what
  they count (#42); a TTL-near-expiry alert rule with a runbook section (#19); budget rules with no budget say so
  (#65); alert titles say "GPU" once (#66); the Alerts scope leaves out what the summary says (#64).
- Logs open on the project that wrote last (#31) and on a bucket with lines there (V6); the audit list says where it
  stops and offers "Show 50 more" (#30); long label names and phone layout (#63); a project link judged only once
  scope is known (#32, guarded).
- Explorer: "managed" resources said once for table and drawer (#45, #46); an unlabelled subnet pool inherits its
  attribution from the subnet or network it is assigned to (#29); the tenant node reads its name (#26); on a phone
  an expanded graph is an indented tree (#21); "active" said once (#56). The bootstrap labels the state bucket it
  creates and prints the label command for an existing one (#55, the live bucket waits for the owner).
- Accessibility: one shared Markdown view whose scrolling code blocks take focus and whose highlight colours pass
  4.5:1 (#39, #51); drawer bodies scroll with the keyboard (#40); the selected log row's time (#41) and the dark
  theme's selected "critical" badge (V2) pass contrast; graph nodes and links are named starting with their visible
  text (WCAG 2.5.3, V1), and the e2e axe checks enable `label-content-name-mismatch`, which the pinned axe-core 4.13
  leaves off.

### e2e stability

- Tests measure the loaded page with web-first waits instead of a sleep (N5, F1.37b, the page sweep) and read a
  count once its reply rendered (F1.38, G2's Costs breakdown); a failed `/meta` is asked again every 3 s, so a page
  never stays without its Test data banner; the proof tests answer their own live-price requests.
- Final gates on `wave1`: `CI=1 yarn test` 1,276 passed (3 skipped); `CI=1 yarn test:e2e` 388 passed, twice in a
  row; the W1-P25 checklist test now waits for each step's state (a full run read one still "checking").

### Known gaps

- W1-P6: no discount-% overlay on the live list price; a reserved scenario's compute stays a pricing gap.
  W1-P7: the JSON rate-book import still stores at once, without the preview step.
- W1-P13: the "last live run" date comes from evidence files only; `results/` is not on the portal's allowlist.
- W1-P24: only the Overview's Unavailable states carry a Fix link; W1-P25: the setup checklist is not summarised on
  the Overview.
- #33: billing rows are not used for the backfill, vCPUs on back-filled days stay as recorded, and the peaks still
  need a live check during a sync window.
- #29: `status.assignment` on pools has not been seen in a live answer; #55: the live state bucket stays
  unattributed until the owner runs the printed `nebius storage bucket update … --labels` command.
- #11: the e2e runs without the docs mirror; #19: no e2e (the stub has no root near its TTL); #32: not reproduced,
  guarded, no route test.
- The e2e suite shares one backend's per-user calculator budget (30 at once, then 1 a second): on a fast run the
  later live-price tests can read "Too many live-price requests" (seen in the Wave 1 group runs, not in the final ones).

## v0.3.1 — 2026-10-13

The owner-run tooling for the remaining live items, a CPU-only `lab` stage, the Soperator v1 IAM patch,
and the first R1-only sessions (2026-10-13, sandbox, `eu-north1`). R1 moves to **Measured** in [What is
proven](README.md#what-is-proven): the first serving sweep on 1 preemptible L40S, from the operator host.

### From the 2026-10-13 live session

- First R1-only session ([evidence](docs/evidence/2026-10-13-sandbox-r1-session.md)), `run-r1.sh` with
  `R10_TOO=1`: preflight GO, re-price (preemptible L40S $0.7492/h), plan 12 to add, TTL job armed; the
  apply **stuck 59 min** on the `grafana-and-prometheus` release because the Alertmanager PVC took the
  default StorageClass `csi-mounted-fs-path-sc` (promoted by the filestore CSI) and never bound
  ([R1-20](docs/upstream-findings.md#2026-10-13-findings-from-this-repositorys-own-runs), our stack
  design). One SIGINT ended it with state written and the lock released; teardown (12 destroyed, 11 min)
  and the stage gate were clean. R10's plan failed on a missing `subnet_id` (nothing created). Verdict
  PARTIAL, clean.
- `R14=0` for `run-r1.sh`: leaves Alertmanager and the R14 data-source Secret out of an R1 session; the R14
  step reports SKIP with the reason.
- Retry (R1 only, `R14=0`, `R5=0`, same evidence file; verdict PARTIAL, torn down and clean): apply 8 min (12 added); `00-nodes`, `01-gpu`
  (L40S, driver 580.173.02, 46,068 MiB; the DaemonSet fix held), `02-interconnect` and `03-storage` (fio
  2,228 MiB/s write, 2,423 MiB/s read on R1's own filestore) pass; vLLM served Qwen2.5-1.5B (first
  request 393 ms). **R1 Measured**: the `tests/load/bench.sh` sweep from the operator host through a
  port-forward, 200/200 at 1, 8 and 32 concurrent, E2E p99 0.85, 1.15 and 1.47 s (bar 10 s), 153, 1,145
  and 3,696 output tok/s, $1.36, $0.18 and $0.056 per 1M output tokens (list, preemptible); latency
  includes the tunnel. Scrubbed result: [`results/2026-10-13/bench-r1-operator-host.json`](results/2026-10-13/bench-r1-operator-host.json).
  The in-cluster sweep failed: the bench pod had no route to Hugging Face for the tokenizer
  ([R1-21](docs/upstream-findings.md#2026-10-13-findings-from-this-repositorys-own-runs), ours).
- The portal showed the cluster, the pending Alertmanager pod with its scheduling reason (Workloads) and
  the L40S (Fleet) during the session.
- Upstream finding [R2-17](docs/upstream-findings.md#2026-10-13-findings-from-this-repositorys-own-runs)
  (Nebius behaviour, observed): the CLI's federation token lifetime is fixed at the first sign-in; a
  refresh, logout or private window returns the same `expires_at` until it passes.

### Live-session tooling (offline-tested; not run live unless said)

- R1-only session in one command, `scripts/live/run-r1.sh`: R1 on `l40s-gpu-only` with its own 64 GiB
  filestore and no R8 or R12 root; the R14 data-source token Secret named before the plan and created
  from `.env` in step 6; `R10_TOO=1` runs R10 after R1's teardown, `R5=0` leaves R5 out. **Ran live on
  2026-10-13** (above).
- R13 federated apply in one owner command, `scripts/live/A4-r13-federated-apply.sh`: dispatches the
  sandbox/data apply in CI, reports the token exchange, always tears the root down locally with the TTL job
  armed first, never tears down under a CI apply still running, and retires the sandbox CI keys only on a
  typed `RETIRE` after a green apply.
- Run 4 in the lab stage, one command each (`run4-r7.sh`, `run4-r4.sh`); `L0` creates `nip-lab` with
  `iam v2 project`. A [morning checklist](runbooks/live-session.md#morning-checklist) names one owner
  command per remaining live item, also from a phone.
- R14 token Secret is created with server-side apply, so the token never lands in the last-applied
  annotation. Runbook: `BENCH_PATH=public` for R10 when Docker host networking is off. `ttl-armed.sh`
  reads the job's command line from `/proc` where `ps` is absent.

### Lab stage (offline-verified, not yet run live)

- `lab` stage: CPU only, its own project `nip-lab` in `uk-south1`, network and Soperator roots, kept
  GPU-free and TTL-bound by policy (`policy/stages.rego`); ADR-0009 later change.
- Bootstrap: a state bucket in a region without Standard gets the region's class; a project bound to
  another stage is refused. Preflight `STACK=soperator` checks the stage directory and names the TTL
  safety net. `make soperator-destroy-plan` / `soperator-destroy`, scheduled by
  `ttl-teardown STACK=soperator`; `soperator-apply` refuses a TTL-bound stage until its TTL job runs.

### Soperator patch B (upstream issue drafted)

- Owner decision "B patch + A issue": the vendored recipe is patched, the one deviation from "wrapped,
  not forked" (ADR-0008). [`patches/0001-drop-iam-v1-data-sources.diff`](terraform/stacks/soperator/patches/0001-drop-iam-v1-data-sources.diff)
  removes `data.nebius_iam_v1_project` (its five reads become `var.iam_project_id`) and the unused
  `data.nebius_iam_v1_tenant`, both on v1 APIs supported until 2026-12-16. `scripts/fetch-soperator.sh`
  applies `patches/*.diff` before the overrides (a patch that no longer applies stops the fetch) and
  re-fetches a checkout that is not the pinned commit plus the patch set. `make soperator-check` fails
  whenever either data source is in the patched tree. Drop the patch at the first upstream tag without
  both ([README](terraform/stacks/soperator/README.md#patches), R4-14); the upstream issue is drafted, not
  posted ([draft](docs/plans/2026-10-13-soperator-upstream-issue.md), [options](docs/plans/2026-10-13-soperator-options.md)).
  Not yet run live.

### R6

- The serverless L40S endpoint's price derived from Compute pricing: about $1.57/h on-demand (VM $1.5484/h
  + 200 GiB disk $0.0194/h, calculator 2026-10-13); not billed yet.

### Known gaps

- R1-21 is not fixed: the in-cluster load generator cannot load its tokenizer from Hugging Face; R1's
  figure is operator-host only (tunnel included), one model, one GPU.
- R1-20 is not fixed: Alertmanager's PVC is not pinned to `compute-csi-default-sc` and the k8s_release
  resources have no `timeouts`; until then an R1 session runs with `R14=0`.
- `run3-2-plan` has no `subnet_id` in an R1-only session (R10 with `R10_TOO=1` fails at plan).
- The device-plugin release took 34 min on 2026-10-13 (cause unknown); Grafana's `download-dashboards`
  back-off is not diagnosed.
- Both sessions' billed figures are pending the FOCUS export (estimates $0.97 and $0.69). R13's apply
  side, the lab stage (run 4) and the Soperator patch have not run live.

## v0.3.0 — 2026-10-12

### From the 2026-10-12 live session

- Load results add `highest_passing_concurrency` (the highest level that passed) and `failed_levels`;
  `max_passing_concurrency` keeps its meaning (every level up to it passed) and is now documented. The
  2026-10-12 R11 run (1 failed on one tail outlier, 8 and 32 passed) showed only `null` before.
- R11 load bench: the default model is `Qwen/Qwen3-30B-A3B-Instruct-2507` (`--model` / `BENCH_MODEL`),
  since `vllm bench serve` loads the tokenizer from Hugging Face by the model id and the smoke default
  `nvidia/Nemotron-3_5-Lightning` is no repo (the 2026-10-12 run failed before any request,
  [R11-3](docs/upstream-findings.md#r11-token-factory)). New `--tokenizer` / `BENCH_TOKENIZER` (token
  counts then approximate, recorded as `tokenizer`); `bench.sh` checks the tokenizer repo on Hugging
  Face before the paid run (`BENCH_HF_CHECK=0` skips it).
- R14: the in-cluster Grafana gets the four Nebius data sources of `recipes/observability/grafana/datasources.yaml`
  once a Secret with an OBSERVABILITY static key is named (`grafana_datasource_token_secret`; the plan output
  `o11y_provisioning` says when it is missing). On 2026-10-12 it had none: nothing sent them. Rules now load
  whenever Prometheus runs; a receiver Secret uses the alertmanager subchart's keys (`configFromSecret` does not
  exist there). `recipes/observability/acceptance.sh` names a cause class for every failing part instead of
  zero counts ([classes](recipes/observability/README.md#acceptance-cause-classes)).
- The owner-run live-session tooling is in git: `scripts/live/` (runs 1-3, the one-command run-2
  batch, `abort.sh`), with no ids in it (the sandbox target comes from `.nip-targets/sandbox` or exported
  variables), offline tests in `make selftest` (`tests/scripts/test-live-*.sh`) and
  [`runbooks/live-session.md`](runbooks/live-session.md) (running a session, from a phone over SSH and
  tmux, abort, the 2026-10-12 lessons). `run2-all.sh` now reports a failed GPU layer and skips the
  steps that need vLLM by name instead of carrying on silently; the AWS CLI image of the R8 drill is
  pinned in `platform/versions.yaml`.
- `make preflight` checks this plan's quota demand (derived from the stack, profile, tfvars, `TF_VAR_*`
  and `--set`) against min(tenant limit, the project's real cap), less reported usage, and refuses only
  when the demand does not fit; caps and tenant zeros the plan does not need now warn. On 2026-10-12 the
  tenant-wide `quota-plan.py --strict` audit made a GPU-only sandbox run NO-GO although it fitted.
  `scripts/quota-plan.py --json` feeds it; `make quota-check` is unchanged.

### Earlier in this release

First live runs of this repository (2026-10-11, sandbox, `eu-north1`), R13 federation with a working
federated CI plan, an offline hardening pass that turns the remaining live steps into scripted checks,
with pass bars where the docs give one, and a coherence, live-data and resilience pass on the Nebius
Estate portal. Per recipe, what is proven and the next live run: [README, What is
proven](README.md#what-is-proven). Findings, acceptance checks and gate results of the 2026-10-12 pass:
[overnight brief](docs/plans/2026-10-12-overnight-hardening.md).

**Live runs** (2026-10-11; [evidence](docs/evidence/README.md))
- Applies, read back and torn down: five of `live/sandbox/inference` (R1: two partial, two lifecycle and teardown verifications; the last served Qwen2.5-1.5B
  on one preemptible L40S after two live-found manifest fixes), and the first of R10, R12, R8 and R9
  governance (one H100 spot cap). Live plans of R7, R3 and R4 (two Soperator plan-path fixes); their
  applies wait on the non-GPU vCPU quota. One paid R11 request; R14 read-only.
- R13: the foundation applied for sandbox with `ci_federation` (IAM only). GitHub sends its immutable
  subject (`repo:<owner>@<owner id>/<repo>@<repository id>:…`), so `subject_claims = "immutable"` was
  added; the bootstrap's group membership is adopted (`adopt_bootstrap.membership_id`).
- R13 audience finding ([R13-3](docs/upstream-findings.md#2026-10-11-findings-from-this-repositorys-own-runs)):
  Nebius STS refused GitHub's default audience and five other candidates and accepted `aud` = `sts.nebius.com`;
  `scripts/ci-token.sh` asks for it, and the first federated `terraform.yml` plan ran green with no stored
  key (token `expires_in` 43200 s). The apply side and the key retirement are not run yet.

**Offline hardening** (W2–W6; every item has a fixture or stub test in `make ci`, none has run live)
- Reproducible runs (W2): committed run profiles (`platform/profiles/<stack>/<name>.json`,
  `make plan PROFILE=<name>`, reused by `make destroy-plan`) that render the 2026-10-11 shapes and their
  TTL labels; `make preflight STAGE= STACK= [PROFILE=]` (`scripts/preflight.py`: key expiry,
  `quota-plan.py --strict`, capacity advice, region/platform and spot-cap pairs, stage caps, TTL) prints
  `GO` before `make plan`; `make ttl-teardown` schedules the safety-net teardown in UTC whatever the local
  `TZ`; `make env-status` warns 14 days before a CI key expiry recorded in `platform/ci-keys.yaml`.
- Bench and pass bars (W3): R1 `05-load.sh` sweeps concurrency (`BENCH_CONCURRENCY`, default 1, 8, 32)
  and records p50/p99 TTFT, TPOT and E2E, output tokens/s, cold vs warm start and cost per 1M output
  tokens against bars (default E2E p99 ≤ 10 s, every request answered), with the bench Job off the GPU
  node when a CPU node exists; the same sweep for R10 and R11 (`tests/load/bench.sh --target r10|r11`);
  R6 measured in-region (`MEASURE_FROM=cluster`) with `compare.py` saying when a comparison is
  like-for-like; R3 DDP samples/s (`tests/validate/ddp.sh`) and per-platform NCCL bars from the docs
  (`tests/validate/nccl-bars.tsv`; B200 and B300 figures unknown).
- Acceptance scripts (W4): R8 fio write and read with parallel jobs against `DATA_MIN_MIBPS` (default
  450 MiB/s, a floor to replace with a measured baseline) and a checkpoint-restore drill; R12 a check Job
  that uses the registry, MLflow and PostgreSQL as clients, a one-pass apply test and
  `scripts/mlflow-artifacts.sh`; R14 `recipes/observability/acceptance.sh` (Grafana data sources, every
  alert rule loaded, a test alert routed); R16 `tests/validate/kueue.sh` (admission, borrow, reclaim).
  `tests/validate/lib.sh` no longer overwrites a recorded failure with "command failed".
- Rescoping (W6): R1's model and engine arguments (`workloads/inference/render.sh`), bench shape
  (`BENCH_*`, recorded in `05-load.json`) and NCCL bar (`NCCL_MIN_BUSBW`) are documented inputs;
  [`docs/rescoping.md`](docs/rescoping.md) lists per recipe the inputs to change for a client, what each
  costs and which check proves the result.

**Portal** (W1, summarised; one entry per finding in the [brief](docs/plans/2026-10-12-overnight-hardening.md#progress-log))
- One number, one name: shared GPU-utilisation window, spend definition (excl. tax and credits),
  duration, quota-count and number formatters across pages; project names instead of ids.
- Budgets lead with the FOCUS actual; the run-rate estimate is a separate projected line and alert; a
  currency mismatch is "no data"; plain-word form checks.
- Solutions is its own page (Assurance), making fifteen pages in four nav groups; the header badge says
  "Read-only to Nebius"; a run against the test stub shows "Test data — not your tenant" on every page.
- Live data and resilience (audit against the real tenant, read-only): connect-class errors retried
  within a sync and shown with their cause, failed calls mark a connector degraded, the last tenant and
  project names survive a failed read, a missing input makes an alert unknown instead of resolving it,
  one token exchange per expiry, an overdue sync deferred while the API is unreachable, and empty
  results that say why (no GPU running, a list that did not answer, region unknown).
- Layout at 390 px and 1440 px: folded reference sections, wrapping badges, tabs and log lines, a sort
  control on phone tables, "N more rows below" cues, an estate graph that opens one level expanded.
- Backstage 1.55.0 → 1.55.3.

**Upgrades**
- Applied (patch and minor, every gate green): toolbox base `python:3.13.16-slim-trixie`, conftest
  0.71.1, trivy 0.75.0, Backstage release 1.55.3. Already newest for their line: Terraform 1.16.5, the
  Nebius CLI, the providers, vLLM `v0.31.0`.
- Proposed, not applied: `actions/checkout` v4.4.0 → v7.0.1 (major), `busybox` 1.36.1 → 1.38.0 (only
  exercised by live validation), Backstage 1.56 once released (React 19 and MUI v5 follow Backstage).

**Live-run plan**
- [`2026-10-12-live-runs.md`](docs/plans/2026-10-12-live-runs.md): zero-cost owner tasks (live preflight, CI key expiry, Soperator
  tag check, R13 apply side), then a Token Factory bench, one L40S sandbox session (R1, R8, R12, R14,
  R5, optional R6) and one R10 GPU VM bench; about $3.16 to $6.64 at prices recorded on 2026-10-11 plus
  the R6 endpoint (price unknown), an estimate, not a quote. Awaiting the owner's approval.

**Known gaps**
- Every harness above is offline-ready only: no recipe has a figure judged against a pass bar yet.
- The `eu-north1` non-GPU vCPU quota is 0: R3, R4, R7, R16 and R1 with CPU nodes cannot be applied.
- R15 needs a GB300 reservation (`max_gpu_nodes.nvl` is 0 in every stage).
- Soperator: no upstream tag drops `data.nebius_iam_v1_project`; `make soperator-check` fails from
  2026-11-16 (support ends 2026-12-16). Re-check the tags before then.
- R13's apply side and key retirement are not run. (The sandbox-plan CI state key's expiry is recorded
  exactly: 2026-11-11, as printed when it was minted.)
- The portal's final deep audit (F8.1) and the live-data re-checks marked in the brief are not recorded
  as done.

The entries below were listed as Unreleased after v0.2.0 and ship in this release
([design](docs/design/2026-10-10-harden-and-align.md)).

**Toolchain**
- Toolbox Terraform raised from 1.11.4 to 1.16.5 (`platform/versions.yaml`, `docs/compatibility-matrix.md`):
  the `terraform test` harness in 1.11–1.15 refuses an `apply` run that leaves an ephemeral variable
  unset, which broke the SecretStash apply-refusal tests in `stacks/data`, `stacks/ml-services` and
  `modules/o11y`; 1.16.0 fixed the harness. Configurations still require `>= 1.11`; the Soperator recipe
  stays on 1.12.2.

**Recipes**
- New **R7** private network perimeter (`terraform/stacks/network`: private workload subnet, custom NAT
  gateway, optional WireGuard bastion) and **R8** dataset and checkpoint data plane (`terraform/stacks/data`,
  `workloads/data/copy-job`). R1 and R3 consume their outputs through existing inputs.
- `comparisons/` is now `recipes/` (`physical-ai` → `team-platform`); R2 is "Foundation & lifecycle".
- R1: optional GPU node-group autoscaling (`gpu_autoscaling`, off by default) and a prod overlay with
  `RollingUpdate`. R1 cites the MK8s GPU docs and the `vllm` application, since upstream removed `k8s-inference`.
- Stage policy is resolved once in `modules/stage-policy` and shared by every stack except Soperator.
- New **R9** finance and governance (`recipes/finance`: budgets, periodic FOCUS export, cost
  allocation labels and a pricing method, `price.py`, over the billing calculator and capacity
  advisor; `terraform/stacks/governance`: spot price caps, project limits on capacity block groups,
  quota reads). Runbook `runbooks/finance.md`. `price.py --dry-run` runs in `make ci`.
- New **R10** GPU VM quickstart (`terraform/stacks/gpu-vm`): one GPU VM serving vLLM, private by
  default. `platform/stages.yaml` caps it at `max_gpu_nodes.gpu-vm` 1 in sandbox and staging and 0 in
  prod, so prod has no live root. Runbook `runbooks/gpu-vm.md`.
- New **R11** Token Factory (`recipes/token-factory`): client configuration for the OpenAI-compatible
  API (`https://api.tokenfactory.nebius.com/v1/`, `NEBIUS_API_KEY`), a free read-only
  `list-models.sh` (run live 2026-10-11: 25 models), and a one-request `smoke.py` that refuses to
  spend without `--yes` (run live 2026-10-11: HTTP 200, 31 tokens); its dry run and refusals are checked offline in `make ci`.
  Rate limits, dedicated endpoints, cost model and risks; runbook `runbooks/token-factory.md`.
- New **R12** ML platform services (`terraform/stacks/ml-services`): Container Registry with a node
  service account so R1/R3 pull without pull secrets, optional Managed MLflow and PostgreSQL with
  write-only passwords from SecretStash. Runbook `runbooks/ml-services.md`.
- New **R13** identity and CI federation (`terraform/modules/foundation/ci-federation`, wired into the
  foundation as `ci_federation` / `team_groups`, off by default): GitHub OIDC federated credentials
  for the CI accounts and project-scoped team groups. Runbook `runbooks/identity.md`. Run live: see Live runs above.
- New **R14** observability (`recipes/observability`): which signal comes from where (provider and
  ingested metrics, log buckets, journald, traces, console alerts, `platform/alerts`) with a decision
  table; read-only clients `metrics.sh` (PromQL, per-service buckets, `coverage` of the alert rules'
  metrics) and `logs.sh` (Loki API, refuses the documented unsupported LogQL); a Grafana
  provisioning file with no secret; `test.sh` (dry runs, refusals) in `make recipes-check`. Read live
  2026-10-11 with `nip-portal-viewer` (`docs/evidence/2026-10-11-observability-read-only.md`): found
  that `DCGM_FI_DEV_CLOCK_THROTTLE_REASONS` (used by `GpuThermalOrPowerThrottling`) is not in Nebius
  Monitoring, which has `DCGM_FI_DEV_CLOCKS_EVENT_REASONS`. Runbook `runbooks/observability.md`.
- New **R15** rack-scale GB300 NVL72 (`terraform/stacks/nvl`): per rack one NVLink instance group
  (`GB300`, 18 VMs) and a fixed 18-node node group joined to it, no surge, STRICT reservation;
  joins R3's cluster. Mocked tests only. `platform/stages.yaml` adds `max_gpu_nodes.nvl: 0` and
  `require_strict_reservation.nvl: true` in every stage, so no live root is rendered; `policy/stages.rego`
  allows an `nvl` cap only in whole racks and with STRICT. Runbook `runbooks/nvl.md`.
- New **R16** team scheduling (`workloads/kueue`): Kueue v0.20.1 (pinned with the release manifest's
  sha256 in `platform/versions.yaml`, installed by `install.sh`), a Topology over the
  `topology.nebius.com/*` labels, a flavor on R3's InfiniBand GPU nodes, two team ClusterQueues in one
  cohort sized per stage, LocalQueues and a two-node TAS sample job. `policy/kueue.rego` checks the
  rendered overlays in `make policy`. Runbook `runbooks/team-scheduling.md`.
- Live roots for `gpu-vm` (sandbox, staging), `ml-services` and `governance` (every stage) are
  rendered by `scripts/render-live-roots.py` and selectable in the deploy pipeline.
- Consistency fixes: R9, R10 and R12 set `nip-stack` like the other stacks; R12's `subnet_name` has
  no `default-subnet` default (as in R1/R3); R13 credentials are `nip-<stage>-gha-<job>`; the R9
  project-limit ceiling now counts the `gpu-vm` cap (sandbox 56, staging 88, prod 320 GPUs).

**Solutions**
- New Solutions layer [`solutions/`](solutions/README.md) S1–S9: customer scenarios (private serving
  with VPN, 70B fine-tune, LLM API, preemptible burst training, Slurm migration, multi-region DR, EU
  residency, batch inference, data-science notebooks) composed from the recipes, each with first-call
  questions, the nine design sections, sizing, quota checklist, a cost model from `price.py` on its
  `footprint*.json` (live calculator and capacity advisor, 2026-10-11, an estimate, not a quote;
  [evidence](docs/evidence/2026-10-11-solutions-pricing.md)), risks, delivery steps, portal demo path and
  proven vs not. None deployed. README Solutions table, a "Used by" line in every composed recipe,
  Solution links in [`docs/solutions/`](docs/solutions/README.md); open variants are in the
  [design backlog](docs/design/2026-10-11-solutions-and-recipes.md#backlog-not-done-with-reason).

**Repeatability**
- Pinned toolbox image (`make toolbox`, `make ci-docker`; linux/amd64) with every tool at its
  `platform/versions.yaml` version and sha256; CI runs the same make targets inside it.
- `make pins` fails when an image, action, script default or toolbox tool drifts from `versions.yaml`;
  validation and NCCL images are pinned by digest.
- Soperator runs through `make soperator-plan` / `make soperator-apply` and `scripts/tf-run.sh`.
- `make md-links` (part of `make ci`, offline, `scripts/md-links.py`): every relative Markdown link
  resolves to a file and every `#anchor` to a GitHub heading slug (duplicate suffixes, `<a id>`). Its
  first run fixed five broken links (`costs.md` anchors in R1 and R6, a `capacity.md` anchor typo, a
  removed README section).

**Delivery and security**
- Deploy pipeline (still disabled): no saved plan is uploaded; the apply re-plans and refuses unless the
  resource-change digest matches the reviewed one; private-endpoint stages need a self-hosted runner;
  `run` and `ttl` inputs set the run labels; `network` and `data` stacks added.
- State bucket `prevent_destroy`; RFC 5737 documentation ranges refused in `allowed_cidrs`; ingress
  isolation for job, data and team namespaces; the R5 `skypilot` Role no longer writes Roles, RoleBindings
  or ServiceAccounts (the platform pre-creates SkyPilot's identity).
- Separate CI identities per stage: `viewer` for plan, `editor` for apply; first authorized keys are
  registered with the CLI (Terraform cannot upload a service account's first key).
- Deploy pipeline: a federated credential path next to the key path (R13). `id-token: write` only on
  the plan and apply jobs; an environment without `NIP_SA_PRIVATE_KEY` takes the federated path
  (`scripts/ci-token.sh` with `NIP_CI_FEDERATED=1`, and `scripts/tf-run.sh` checks the token instead
  of a CLI profile). The gate refuses a stage/stack without a live root. New environment variables
  `NIP_SUBNET_ID` and `NIP_SSH_PUBLIC_KEY` become `TF_VAR_subnet_id` / `TF_VAR_ssh_public_key` when
  set, since no stack defaults a subnet name. `docs/change-management.md` now names the separate plan
  identity per `<stage>-plan` environment.
- Stated rather than fixed: a long-lived CI state key with a rotation runbook; vLLM runs as root because
  of the shared-filesystem cache; job namespaces isolate ingress only ([security](docs/security.md)).

**Correctness against the official docs** (full sweep of docs.nebius.com, 555 pages)
- B200 1-GPU nodes use the `cuda13.0` driver preset (the docs require 580.x); node-group reservation
  `null` means the API default `AUTO`, so regular GPU groups now pin `FORBID` unless a reservation is set.
- R8 picks a storage class the region offers (`STANDARD` is absent in five regions); new regions
  `eu-south1`, `uk-south2` and the RTX PRO 6000 / L40S AMD platforms in `platform/regions.yaml`.
- R6 serverless scripts: jobs succeed on `COMPLETED`, the 1 h minimum timeout, managed `https://` endpoint URLs.
- Private cluster endpoints are reachable only from the cluster's subnet (runner and operators placed there);
  allowlist CIDRs must have zero host bits; preemptible only on GPU groups; GPU clusters only on IB platforms.
- Observability agent: node-label allowlist so GPU-node metrics are not silently dropped; logs go to
  Nebius Logging (14 days); opt-in instance labels for cost allocation and journald logs; virtiofs read-ahead.

**Operator tooling**
- Quota allowance check. On 2026-10-11 a console AI assistant created 27 project quota allowances in
  eu-west2: some above the tenant limit, with no effect, and some below the inherited value, silently cutting
  the project's limit ([R9-2](docs/upstream-findings.md)).
  - New `scripts/quota-plan.py` and `make quota-check` (read-only; `NEBIUS_PROFILE` honoured). For every
    listed project they report real caps above the tenant limit (no effect), below it, and at 0. They also
    report the tenant limits of 0 that the stacks need in their region, each with a request line and a
    justification.
  - `--plan-align` prints the updates to the tenant limit. `--apply` needs `CONFIRM=yes`, writes a rollback
    file first, and only updates (never deletes).
  - Offline tests run against a stub `nebius` (`tests/scripts/test-quota-plan.sh`, part of `make selftest`).
  - Portal: an Allowance check under GPU & Capacity → Quotas, an Overview row when a cap cuts a project, and
    the `ProjectAllowanceBelowTenant` alert (signal `nebius_estate_project_allowance_below_tenant`).
  - Docs: [capacity](docs/capacity.md#project-allowances-vs-tenant-quotas) and
    [runbook](runbooks/capacity-request.md#project-allowances-below-the-tenant-quota).
- Teardown of a live root with in-cluster resources: `make destroy-plan` failed with `Get
  "http://localhost/api?timeout=32s": connection refused` (2026-10-11, `live/sandbox/inference`), because the
  cluster outputs that configure helm/kubernetes/kubectl are null in a destroy plan. New
  `scripts/destroy-providers-override.sh` (run by `make destroy-plan`) writes a git-ignored, mode-600
  `zz_destroy_override.tf` that pins those providers to the endpoint and CA in state, only when the state
  holds a cluster and in-cluster resources; `make destroy` removes it after success. Offline tests with a
  fake `terraform show -json` in `tests/scripts/` ([R2-15](docs/upstream-findings.md), [teardown](runbooks/teardown.md#in-cluster-resources-and-the-provider-override)).
- An expired sandbox TTL does not block teardown: Terraform 1.16 skips resource preconditions in a destroy
  plan, so `ttl_window` stays as it is; `tests/scripts/test-ttl-destroy.sh` proves a normal plan is refused
  and a destroy plan is not ([R2-16](docs/upstream-findings.md)).
- [`docs/reference/nebius-docs.md`](docs/reference/nebius-docs.md): a generated catalog of the official
  docs (key pages, section anchors, redirects, 58 tasks linked to exact sections and to this repository);
  `make docs-catalog`, `make docs-check` (weekly drift job) and `make docs-links` (every docs link and anchor
  in the repository resolves; offline, part of `make ci`). `make help` lists targets by section.
- [`docs/solutions/`](docs/solutions/README.md): a sourced field guide (regions, compute and capacity,
  storage, networking and security, platforms, use cases, pricing, troubleshooting, documented gaps).
- [`docs/credentials.md`](docs/credentials.md), `.env.example` and `make env-status`: every credential in one
  place, stored in a git-ignored `.env` and `secrets/` (mode 600), never printed.

**Portal**
- Live-only: demo mode and synthetic fixtures removed. `app-config.local.yaml` for a loopback-only operator
  run; projects and credentials come from the environment; nothing is pre-loaded.
- A full read-only Nebius catalog (~35 documented lists across compute, Kubernetes, VPC, storage,
  registries, managed PostgreSQL/MLflow, Serverless, tunnels, KMS, secret metadata, DNS, maintenance,
  quotas, capacity) with per-call status (ok / permission-denied with the grant / not-found / rejected /
  unreachable / schema-drift), last-good data kept stale, per-host rate limits.
- Live list prices from the Nebius billing calculator (contract prices when the billing group is
  readable); user rate books kept for negotiated / what-if.
- GPU telemetry from Nebius Monitoring (no cluster needed); in-cluster Prometheus optional.
- Connector and per-call health: 24 h success rate, p50/p95 sync time, consecutive failures, recent runs;
  first sync no longer blocks start-up; concurrent sync returns 409.
- Read-only service account (custom group with one `viewer` permit per project; deletes are refused with
  403); service-account tokens via `https://sts.nebius.com`. `yarn verify:live` (`make portal-verify-live`)
  probes every capability against the configured account (2026-10-11: all per-project capabilities ok on a
  real tenant through a read-only identity).
- e2e runs against a loopback stub of the documented API shapes (`portal/e2e-stub/`).
- FOCUS `Tags` parsed for label breakdowns, with an inventory-join fallback and the source shown per value.
- Hardening: project-id masking, scoped import list, upload authorization before body read, CSV limits,
  sync single-flight and cooldown, CSP `connect-src 'self'`, legacy backend key removed.
- Lifecycle-aware fast re-sync: while an MK8s cluster or node group is PROVISIONING / UPDATING / DELETING,
  or a VM is CREATING / STARTING / UPDATING / STOPPING / DELETING, an extra sync of the fast tier (VMs,
  clusters, node groups, the discovered clusters' Kubernetes API) runs every `nebius.fastSyncSeconds`
  (default 120 s; 60–900, 0 = off), through the same single-sync lock, rate limiters and "Sync now"
  cooldown, and stops once nothing is changing. A cluster is now connected about 2 min after it reaches
  RUNNING (was up to 15 min, observed live 2026-10-11) and shown as being deleted before it is gone.
  Capped at `nebius.fastSyncMax` (default 30, about an hour) in a row, then the normal cadence with a note
  on Integrations; the inventory card reads "Next run in 2 min (a cluster is provisioning)".

**Security** (fixes from a security and correctness review; each has a failing test first)
- GPU caps could be bypassed through the CPU node group: R1/R3 now refuse a non-`cpu-*`
  `cpu_platform` or an `<n>gpu-*` `cpu_preset` and cap `cpu_node_count` at 16 (training: 1–16);
  `modules/node-group` refuses an `<n>gpu-*` preset on a non-GPU platform; conftest `policy/sizing.rego`
  checks the committed sizing files. `cpu_platform = "gpu-h100-sxm"` is refused at plan time.
- The pipeline's plan job held a read-write state key. The foundation now creates a read-only state
  identity per CI stage (`storage.object-viewer`, output `ci_plan_state_identities`) for the
  `<stage>-plan` environment; the plan job plans with `PLAN_LOCK=false` (a read-only key cannot write the
  lock), and the apply job re-plans under the lock and checks the digest. Docs and the rotation runbook
  now say which key goes where; `sandbox-plan` branch-rule guidance added.
- Allowlists: where an allowlist is required (staging, prod, a public bastion in any stage) the stage
  policy refuses entries wider than /8 (`0.0.0.0/0`, the `/1` halves); R7 and R10 refuse them in every
  stage; conftest checks committed files. prod's private control-plane endpoint is now enforced: a
  request for `public_endpoint = true` in prod is refused ("may tighten, never loosen").
- Stage policy: etcd may be raised but never lowered below the stage value (staging too, not only prod);
  the sandbox `nip-ttl-expires` must be in the future and at most 7 days after the plan
  (`plantimestamp()`); `governance` now runs the shared stage policy for that rule. Test fixtures use a
  relative TTL.
- CI credentials: `scripts/ci-token.sh` mints from a throwaway CLI config that reads the key by path
  (`--private-key-file-path`) and deletes it at once, so no profile outlives the token step; in CI
  (`NIP_CI=1`) `scripts/tf-run.sh` requires `TF_VAR_iam_token` on the key path as on the federated one.
  Tokens are no longer passed in argv (GitHub OIDC request header from a file descriptor, the JWT on
  stdin; serverless `curl` headers and `docker -e OPENAI_API_KEY` by name).
- R13 federated subjects pin GitHub's immutable `repository_owner_id` and `repository_id` by default
  (`subject_claims = "ids"`; the repository's OIDC `sub` template must include them, `runbooks/identity.md`);
  the name-only subject is an explicit opt-in (`subject_claims = "name"`).
- The training GPU-Operator gate (`scripts/wait-for-ofed.sh`) works without a CLI profile: it uses
  `TF_VAR_iam_token` as `NEBIUS_IAM_TOKEN` and, in CI, a throwaway config whose profile reads the token
  from a file (the CLI refuses to run without a config even with `NEBIUS_IAM_TOKEN`, observed with CLI
  0.12.285).
- `NIP_SSH_PUBLIC_KEY` is exported for the `gpu-vm` stack only (on cluster stacks it became a `NOPASSWD`
  sudo user on every node), and the node-group cloud-init renders the key and user name as escaped
  strings, so a value with newlines cannot add users or sudo rules.
- The plan job's summary carries the digest, counts and resource addresses only (`make plan-summary`),
  and its plans keep the diff out of the log (`PLAN_LOG=false`); no full plan text is published.
- `scripts/leftovers.sh` lists Managed MLflow and PostgreSQL clusters, Container Registries, NVL
  instance groups and labelled disks; `--stage` lists every disk. A failed listing still stops the check.
- `recipes/serverless/endpoint.sh create` refuses without `CONFIRM=yes`, writes the endpoint id before
  polling, tolerates transient polling errors and prints the delete command on any failure.
- `scripts/bootstrap-backend.sh` captures every create/lookup answer and stops on an empty id, also in
  shells without `pipefail`; the bucket listing pages through `--all`.
- Supply chain: `scripts/fetch-soperator.sh` refuses a checkout whose commit differs from
  `upstream.nebius-solutions-library.ref`; the Training Operator is applied at the commit of v1.9.3
  (`workloads.kubeflow-training-operator.ref`); `make pins` checks both.
- New offline script tests against stub CLIs (`tests/scripts`, part of `make selftest`) and conftest unit
  tests (`conftest verify`, part of `make policy`). `docs/compatibility-matrix.md` regenerated (it was
  stale against `platform/versions.yaml`).

**Removed**
- `make portal-demo` and the portal fixtures (see Portal), `runbooks/restore/` (replaced by the R8 copy
  job), unused `moved` blocks, and two run-log evidence pages (folded into
  [`docs/evidence/costs.md`](docs/evidence/costs.md)).

**Documentation**
- README recipe table R1–R8 with upstream citations; [building blocks](docs/building-blocks.md); runners,
  dispatch inputs and digest review in [change management](docs/change-management.md); new upstream
  findings (R1-15, R1-16, R2-11, R4-14, R7-1); trimmed primer; dated notes on ADRs 0001, 0004, 0005, 0009.

## v0.2.0 — 2026-10-10

Production-shaped release: stages, policy, evidence and onboarding. Still static — this repository's
roots have not been applied; the core patterns are backed by prior runs of the upstream recipes.

**Environments and delivery**
- Stage × stack model ([ADR-0009](docs/decisions/0009-environment-and-promotion-model.md)): stage-agnostic
  stacks, generated live roots for `sandbox`, `staging`, `prod`, and a foundation root for projects,
  state buckets and identities.
- Stage policy (`platform/stages.yaml`) enforced at plan time by the inference and training stacks;
  protections are minimums a root cannot switch off; conftest rules for prod sizing. The Soperator root
  layers stage tfvars over the upstream recipe and gets none of these guards (reviewed by hand).
- Deploy pipeline shipped disabled: staging from `main`, prod from a `vX.Y.Z` tag, reviewed saved plan
  applied by a separate approved job, pinned and checksum-verified Nebius CLI.

**Correctness against Nebius and the upstream recipes** ([register](docs/upstream-findings.md))
- Soperator: jail and submount filesystems, AppArmor, active checks, quota-safe sizing, Kubernetes 1.35 pin.
- B300/B200 regions and fabrics; drivers preset as the default GPU path; reservations only on regular
  GPU node groups; GPU node groups created only when `gpu_node_count > 0`.
- NCCL pass bar from the docs; CSI chart 0.1.10 and `nofail` mounts; tenant-safe state IAM.

**Operations**
- Guardrails: required run/TTL labels, per-stack residue report and stage gate (`make leftovers`,
  `make leftovers-stage`), interrupt-safe applies.
- Alerting rules with receivers configured from a Kubernetes Secret; backup/restore Job; upgrade,
  maintenance, capacity and credential-rotation runbooks.

**Documentation**
- Onboarding-first README with a recipe chooser and an eight-line first deploy; Nebius primer and
  glossary; one page per recipe; cost and capacity guides; runbook index; evidence of the prior runs
  with raw output.

## v0.1.0 — 2026-10-09

First customer-reviewable release. Static only: nothing deployed, no numbers claimed.

- R2 Terraform lifecycle: pinned toolchain, Object Storage state bootstrap, network and
  cluster modules, CI (fmt/validate/tflint/test/gitleaks/Trivy/shellcheck/links).
- R1 inference lab: node groups (driver image), Filestore + CSI, device plugin, o11y,
  vLLM workload pinned by digest and revision, bottom-up validation 00–05, rollback drill.
- R3 training: InfiniBand GPU cluster, Network + GPU Operators, NCCL MPIJob overlays
  (1 GPU / 1×8 / 2×8), PyTorch DDP job, NCCL parser.
- R4 Soperator: upstream recipe wrapped at `soperator-v4.1.13-2`, compatibility report,
  job runbook.
- R5/R6: serverless endpoint/job twins with a comparison generator; team namespace +
  SkyPilot pattern.
- ADRs 0001–0008; compatibility matrix generated from `platform/versions.yaml`;
  weekly upstream-version drift check.
