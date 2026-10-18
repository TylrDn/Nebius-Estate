# Live session (owner-run): runs 1-4 (sandbox and lab)

How to run the paid live runs of [the 2026-10-12 plan](../docs/plans/2026-10-12-live-runs.md)
with the step scripts in [`scripts/live/`](../scripts/live/): one Token Factory bench (run 1), one L40S
sandbox session with R1, R8, R12, R14 and R5 (run 2, optional R6 and F6.1) and one R10 GPU VM bench
(run 3); since 2026-10-13 also R1 alone in one command (`run-r1.sh`), the R13 federated apply with the
CI key retirement (`A4-r13-federated-apply.sh`) and run 4 in the `lab` stage (`run4-r7.sh`,
`run4-r4.sh`). What each step proves, how to stop everything, and what the 2026-10-12 session taught.
**Start with the [morning checklist](#morning-checklist): one command per item.**

**Risk: spend.** Every apply, every `CONFIRM=yes` and every paid API call is started by the owner, in a
terminal, after reading the step's header (what it does, cost, time). Nothing here runs unattended
unless the owner starts the one-command batch (`run2-all.sh`), which has a TTL safety net on every root
it applies. Costs are the plan's estimates (prices of 2026-10-11): run 2 about $2.91 for 2 h, at most
$5.04 if every root ran to its TTL; run 3 $0.22 to $1.54; R6 at about $1.57/h while its endpoint exists (derived from Compute pricing: [R6 README](../recipes/serverless/README.md#price-derived-2026-10-13)).

## Morning checklist

Every remaining live item, one command each, in this order. Run them in **tmux** in the session's
checkout (outside `/tmp`), from the Mac or from a phone ([below](#from-a-phone-tailscale-and-tmux)).
Each asks once before it spends, arms a TTL job before every apply, tears down what it applied and ends
with a `VERDICT`; paste back its RESULT block (or the batch's summary file).

**At the Mac, before anything (browser needed):**

1. The scripts are on branch `live-prep` (reviewed: [`docs/plans/2026-10-12-live-runs.md`](../docs/plans/2026-10-12-live-runs.md)).
   Bring them into the checkout you run from, after your review: `git merge --ff-only live-prep` (or
   `git switch live-prep`).
2. `bash scripts/live/refresh-login.sh` (fresh CLI token: every TTL job inherits it; 12 h).
3. Docker Desktop running (`open -a Docker`); the Mac on power, set not to sleep.
4. `.env` (mode 600): `NEBIUS_TENANT_ID`, `NEBIUS_PROFILE`; for R14's Grafana data sources also
   `PROMETHEUS_TOKEN` (an OBSERVABILITY static key, [credentials](../docs/credentials.md#observability-static-key);
   without it R14 still runs and records the cause class); `gh auth status` for A4.

**Then, one command each (tmux window `live`):**

| # | Command | What, cost, time | Evidence it leaves |
|---|---|---|---|
| 1 | `bash scripts/live/A4-r13-federated-apply.sh` | R13: dispatch the federated CI apply of `sandbox/data` (`ttl=1`), watch it, tear it down here (TTL job first), then list both sandbox CI accounts' keys and delete them **only if you type `RETIRE`**. ≈ $0.03, 15-25 min | `.cache/live/state/r13-run-<id>.{json,log}`, `r13-keys-*-{before,after}.json` → `docs/evidence/<date>-sandbox-ci-federated-apply.md` |
| 2 | `RESET_SESSION=1 R10_TOO=1 bash scripts/live/run-r1.sh` | R1 alone (own 64 GiB filestore, Alertmanager) → 00-02, vLLM, 03, 04, 05-load sweep, R14, R5 → teardown → R10 (run 3) → stage leftovers gate. ≈ $1.61 (2 h) to $2.42 (TTL) + R10 $0.22-$1.54; about 3 h. Not at the same time as #1: its gate sees `sandbox/data`. R10's bench uses an SSH tunnel that needs Docker Desktop host networking; without it add `BENCH_PATH=public` | `.cache/live/logs/run-r1-<UTC>.summary`, `results/0*.json`, `summary.json`, `o11y-acceptance.json`, `bench-r10.json` → the R1, R14, R5, R10 evidence files |
| 3 | `bash scripts/live/L0-create-nip-lab.sh` then `… --apply` | the `nip-lab` project in `uk-south1` (labels `nip-owner=platform`, `nip-env=lab`); $0 | its RESULT block (vCPU allowances, empty) |
| 4 | `bash scripts/live/run4-r7.sh` | R7 in `lab`: first bind of the stage, NAT VM + route acceptance, teardown, stage gate. ≈ $0.05-$0.41, 15-20 min | `results/lab-network.json` → `docs/evidence/<date>-lab-network.md` |
| 5 | decide [Soperator options](../docs/plans/2026-10-13-soperator-options.md), then `bash scripts/live/run4-r4.sh` | R4 in `lab`: Soperator (lab profile), sbatch through the login pod, teardown, stage gate. ≈ $1.40 (45 min) to $5.67 + IO_M3 (TTL), 60-90 min. **Never interrupt its apply** | `results/lab-soperator.json` → `docs/evidence/<date>-lab-soperator.md` |

Not in the list: R6 (optional serverless endpoint, ≈ $1.57/h while it exists): `run2-8-r6.sh` needs an
R1 cluster up, which the batches tear down; run it by hand during a step-by-step session. When a batch
ends `PARTIAL`, its summary names the step: rerun that step by hand while its root is up, or the batch.
If anything says `TEARDOWN FAILED`: `bash scripts/live/abort.sh` (sandbox); for `lab`, the RESULT block
prints the destroy commands and the TTL job that still guards the root.

## Before you start

- **One checkout, outside `/tmp`.** Run the whole session from one checkout of this repo. Session
  state (`.cache/live/state/`: run ticket, labels, `APPLIED_*`, secret ids, prices) and logs
  (`.cache/live/logs/`) live in its git-ignored `.cache/`; the TTL jobs' pid files live in its
  `terraform/live/sandbox/<stack>/.terraform/`. Every step refuses a checkout under a temporary
  directory (`/tmp`, `/private/tmp`, `/var/folders`), which macOS clears; `abort.sh` only warns.
- **Target.** The sandbox project and region come from the stage binding the stage's first bootstrap
  wrote, `.nip-targets/sandbox` (git-ignored, `<project id> <region>`; see
  [`scripts/bootstrap-backend.sh`](../scripts/bootstrap-backend.sh)). Without it, export
  `NEBIUS_PROJECT_ID` and `NEBIUS_REGION` before starting a step. A `NEBIUS_PROJECT_ID` in `.env` is never
  used for the session: it can name another project (it did on 2026-10-11 and 2026-10-12). No id is
  written in `scripts/live/`.
- **`.env`** (mode 600): `NEBIUS_TENANT_ID`, `NEBIUS_PROFILE` (the CLI profile whose cached token the TTL
  jobs inherit); `NEBIUS_API_KEY` for run 1 (else a silent prompt); `R12_MLFLOW_ADMIN_PASSWORD` and
  `R12_POSTGRESQL_PASSWORD` for the batch (else asked once at its start). Values are read by name, as
  bash parses `.env`; none is printed. Every step unsets the `.env` credentials it does not use before it
  starts a child process, so a TTL job (which lives for hours, and whose environment `ps eww` shows) never
  holds them.
- **Fresh login, at the Mac:** `bash scripts/live/refresh-login.sh` right before run 2 and right before
  run 3. A TTL job inherits the CLI's *cached* token, which can already be hours old, and nothing
  refreshes it. An access token is valid for 12 hours
  ([access tokens](https://docs.nebius.com/iam/authorization/access-tokens); mirror
  `.cache/nebius-docs/iam/authorization/access-tokens.md`); how the CLI refreshes its cache is unknown.
  Every step that arms a TTL job refuses, before it cancels anything, unless the cached token lives until
  the TTL time + 60 min. The login opens a browser, so it cannot be done over SSH from a phone.
- **Docker running** (run 1 and run 3 benches, the R8 restore drill's `aws` client: `scripts/live/bin/aws`
  runs the AWS CLI image pinned in [`platform/versions.yaml`](../platform/versions.yaml); nothing is
  installed on the host).
- **Run 2:** project `admin` (step 2b creates the node service account). **Run 3:** an SSH key pair
  (`SSH_PUBKEY`, default `~/.ssh/id_ed25519.pub`). **Run 1:** a Token Factory key with a balance.

## Running it

Every script is **executed** (`bash scripts/live/<script>`), never sourced, in a real terminal: several
steps read secrets at silent prompts or ask you to type `yes`, and refuse on a stdin that is not a
terminal. Each one re-sources `.env` and the bootstrap itself, so your shell is never changed and run 2
and run 3 can go in two terminals at the same time.

Each step prints a header (what, cost, time, target), logs everything to
`.cache/live/logs/<step>-<UTC>.log`, and ends with a block that starts
`=== RESULT (paste back everything from here down)`. A step that ran to its end says `finished`, and
its status lines (and `VERDICT` line, where it has one) say whether what it checked passed; a failed
step says `FAILED`, `VERDICT: FAIL`, what is armed and billing at that moment, and the 40 log lines
before the failure.

`ASSUME_YES=1` answers every `yes` prompt (and `abort.sh`'s `ABORT`). Use it only to re-run a step you
have already reviewed: every header prints a loud banner and waits 5 s. It is the only toggle read from
your shell: `CONFIRM`, `RUN`, `TTL`, `NIP_NOW` and the other variables the Makefile and the repo scripts
read are cleared at the start of every step.

### Run 1: Token Factory bench (R11)

`bash scripts/live/run1.sh`: a dry call that must refuse, then the paid `CONFIRM=yes` sweep (611 requests).
The model is `tests/load/bench.sh`'s R11 default (the header names it); `R11_MODEL=<id>` overrides it.
The model's Token Factory id must also be a public, ungated Hugging Face repo, because the bench loads
its tokenizer from there. `BENCH_USD_PER_1M_OUTPUT=<listed rate>` records the cost per 1M output tokens.
**Proves** F3.2 for R11 (`results/bench-r11.json`); the RESULT block ends with `VERDICT`.

### Run 2: one L40S sandbox session

Step by step, in this order, or all of it with `bash scripts/live/run2-all.sh` (next section).

| Step | Script | What it does | Proves |
|---|---|---|---|
| 0 | `run2-0-preflight.sh` | Starts the session (run ticket, labels with now + 4 h 30 min); bootstraps and preflights data, ml-services and inference: each must print `GO` | F2.2 |
| 1 | `run2-1-reprice.sh` | `price.py` dry run, then priced; keeps the GPU node's hourly price for step 3d | the session's price on the day |
| 2a | `run2-2a-data.sh` | R8: plan, provisional TTL job **before** the apply, apply | F2.1, F2.3 (TTL armed against a real root) |
| 2b | `run2-2b-ml-services.sh` | R12: SecretStash secret (payload from a 0600 request file, never argv), run inputs, plan, provisional TTL, apply, then a plan that must say `No changes` | F4.5 one-pass apply |
| 2c | `run2-2c-inference.sh` | R1 on `l40s-gpu-only` with R8's filesystem and R12's node SA: plan, TTL (3 h) before the apply, apply. Checks your egress address is in `TF_VAR_allowed_cidrs` | F2.1, F2.3 |
| 2d | `run2-2d-rearm.sh` | Moves the data and ml-services TTL jobs to R1's expiry + 30 min, so a TTL teardown never removes the filesystem or node SA under a running cluster. **Run it right after 2c** | F2.3 |
| 3a | `run2-3a-validate-gpu.sh` | `00-nodes`, `01-gpu` (must pass), `02-interconnect` (recorded, does not stop the step); then the vLLM overlay | layers 00-02 |
| 3b | `run2-3b-headroom.sh` | The bench Job must fit beside vLLM on the one GPU node; lowers vLLM's requests once if not | F3.1 placement |
| 3c | `run2-3c-storage-workload.sh` | `03-storage` (fio on R8's filesystem), then `04-workload` | F4.1 baseline, vLLM first request |
| 3d | `run2-3d-load.sh` | `05-load` 1/8/32 sweep with a Pending watch, then `summary.json` (must print `true`) | F3.1 |
| 4 | `run2-4-r8-acceptance.sh` | R8 restore drill with a drill-only identity and 2 h key, deleted afterwards (also on failure) | F4.1 |
| 5 | `run2-5-r12-acceptance.sh` | Registry push/pull, MLflow run, `select 1`, node pull; empties the registry | F4.2 |
| 6 | `run2-6-r14-acceptance.sh` | Port-forwards Grafana/Prometheus/Alertmanager to local 13000/19090/19093; data sources, alert rules, test alert. Confirm delivery at the receiver by hand | F4.3 |
| 7 | `run2-7-r5.sh` | vLLM to 0; team namespaces; SkyPilot (pinned version, in a venv under `.cache/live/state/r5`) launches the DDP task on the L40S and tears it down | R5 first run |
| 8 | `run2-8-r6.sh` (optional) | R6 serverless endpoint: create, measure from the cluster, delete. **No TTL job**: every exit of the step deletes it, and steps 10 and 11 refuse while it exists | F3.3 |
| 8b | `run2-8b-f61.sh` (optional) | F6.1 on another model; step 3's results are kept and restored | F6.1 |
| 9 | `run2-9-evidence.sh` | Read-only bundle for the evidence files (results, TTL jobs, spend estimate per root, GPU layers). Run again after step 11 | — |
| 10 | `run2-10-teardown.sh` | PVCs first, then R1, R12 (registry images, MLflow artifact bucket), R8: destroy-plan, destroy, leftovers, `ttl_cancel` each; then the SecretStash secret. Re-runnable | teardown, F2.3 disarm |
| 11 | `run2-11-leftovers.sh` | **After runs 2 and 3 are both destroyed:** `make leftovers-stage STAGE=sandbox` must be clean and no R6 endpoint may exist; only then cancels the TTL jobs and removes the run inputs | residue check |

`run2-watch-bench.sh [inference|nip-bench]` watches the bench pod from a second terminal (read-only).
Step 7's SkyPilot writes outside the repo: its state and API-server logs in `~/.sky`, and an `Include`
line in `~/.ssh/config` (for `ssh ddp`); remove them after the session if you do not keep SkyPilot.

### Run 2 in one command: `run2-all.sh`

`bash scripts/live/run2-all.sh` asks once (`yes`, and the R12 passwords if `.env` lacks them), then runs
steps 0 to 7, 9, 10, 11 and 9 again unattended (about 4 h), printing one line per step to
`.cache/live/logs/run2-all-<UTC>.summary`. R6 and F6.1 are not run. The rules:

- An apply step (0 to 2d) failing stops the applies: whatever was applied keeps its TTL job, and the
  batch goes straight to teardown.
- A check (3a to 7) failing is recorded and the batch carries on, so a failed check never leaves the
  cluster billing. Teardown always runs.
- Step 3a: when `00-nodes` or `01-gpu` fails, vLLM is **not** deployed. The batch prints the layer
  results, **skips 3b and 3d by name** with the reason, and runs 3c with `NO_WORKLOAD=1` (03-storage
  only: step 4's R8 baseline does not need vLLM); steps 4 to 7 still run. A failed `02-interconnect`
  does not stop vLLM: it is recorded and printed. Nothing is retried automatically (see
  [Re-running a check](#re-running-a-check)).
- A failed teardown stops the batch and says to run `abort.sh`.
- Exit code and final `VERDICT`: `0` PASS (every step passed, torn down, leftovers gate clean); `3`
  PARTIAL (torn down and clean, but a step failed or was skipped); `1` FAIL (teardown or the leftovers
  gate failed: something may bill).

The R12 passwords reach the step processes in `R12_BATCH_*` only; each step stops exporting them at
once, so no `make` target or TTL job inherits them.

### R1 alone in one command: `run-r1.sh`

`bash scripts/live/run-r1.sh` (add `RESET_SESSION=1` after an earlier session, `R10_TOO=1` for run 3
after R1's teardown, `R5=0` to leave R5 out). R1 on `l40s-gpu-only` **without** R8 and R12: the
inference stack creates its own 64 GiB filestore (`existing_filesystem_id` null) and runs its nodes
without a service account (`node_service_account_id` null; every image it pulls is public). Step 0
records `SESSION_MODE=r1-only` in `.cache/live/state/run2.env` (only while nothing is applied), and the
step scripts read it: step 1 prices `recipes/finance/examples/inference-l40s-r1-only.json`, 2c skips the
R8/R12 prerequisites, there is no step 2d (nothing can be deleted under the cluster), step 10 tears down
R1 only. Then: 3a-3d (00-02, vLLM, 03-storage on R1's own filestore, 04, the 05-load sweep with its pass
bars, priced with step 1's gpu-node line), step 6 (R14), step 7 (R5), evidence, teardown, [run 3],
step 11 (stage gate), evidence again. The batch rules are run 2's (next section); a failed R1 teardown
stops it before R10 starts. **R14 data sources:** step 2c names the token Secret
(`grafana_datasource_token_secret = grafana-nebius-token`) before the plan, in both modes; step 6 fills
it from `.env`'s `PROMETHEUS_TOKEN` through stdin and restarts Grafana; without the key the acceptance
runs anyway and the summary prints its cause classes (for example `datasource_token_rejected`).

### R13: the federated apply, then the CI key retirement (script A4)

Plan task Z5 steps 2-5 ([identity](identity.md#first-federated-run)). Refuses while either GitHub
environment (`sandbox`, `sandbox-plan`) still holds `NIP_SA_PRIVATE_KEY`, while the repository variable
`NIP_TERRAFORM_ENABLED` is not `true`, or while `sandbox/data` has resources. Dispatches
`terraform.yml` (`stage=sandbox stack=data action=apply ttl=1`, `--ref main`; `R13_REF` overrides),
waits, reports the token-exchange line (`expires_in`) and `Apply complete!`, then tears the root down
here: bootstrap, `make init`, the workflow's labels read back from state, the TTL job armed at their
expiry, destroy-plan, destroy, `make leftovers`, `ttl_cancel`. Only after a green apply job it lists the
authorized keys of `ci_identities.sandbox` and `ci_plan_identities.sandbox` and deletes them when you
type `RETIRE` (`ASSUME_YES` does not answer it; a key Terraform registered is refused); the re-list must
be empty, and `secrets/ci-sandbox*.pem` is removed. `--teardown-only` and `--retire-only --run-id <id>`
run one half. Afterwards: [credential rotation](credential-rotation.md#rotating-the-ci-service-account-key).

### Run 4 in the lab stage: `L0-create-nip-lab.sh`, `run4-r7.sh`, `run4-r4.sh`

`lab` is its own project, `nip-lab` in `uk-south1` (ADR-0009 later change), CPU only. `L0` creates the
project (`nebius iam v2 project create`, dry run first). `run4-r7.sh` and `run4-r4.sh` target
`.nip-targets/lab`, else the one `nip-lab` project (refused outside `uk-south1`); the first of them binds
the stage (`NIP_BOOTSTRAP_NEW_STAGE=1`, a new state bucket and identity). Each refuses a project that is
not empty or short of non-GPU vCPU (4 for R7, 52 for R4), arms its TTL job (3 h) before the apply, runs
its acceptance, always tears down after an apply attempt and ends on `scripts/leftovers.sh --stage lab
--expect-empty`. R4 arms `make ttl-teardown STACK=soperator` before `make soperator-apply`, which refuses
without it (`scripts/ttl-armed.sh`); its acceptance runs `sinfo`, `sbatch --wrap hostname` and `sacct`
through the login pod (`kubectl exec login-0 -c sshd -- chroot /mnt/jail …`, as root), and its teardown
removes the `nebius-nip-slurm` kube context and `login.sh`. Exit codes as the batches: 0 PASS, 3 torn down
but acceptance failed, 1 stopped before the apply or teardown/gate failed. `abort.sh` does not handle
`lab`: the RESULT block of a failed step prints its destroy commands.

### Run 3: R10 GPU VM bench

`run3-2-plan.sh` (allowlist `/32` and SSH key, preflight, plan with a 2 h TTL), `run3-3-apply.sh` (TTL
job before the apply, apply, re-price), `run3-4-bench.sh` (waits for `/health`, reads the API key over
SSH, benches through an SSH tunnel or `BENCH_PATH=public`), `run3-5-teardown.sh`. **Proves** F3.2 for
R10 (`results/bench-r10.json`). Run it beside run 2 in a second terminal if you like; run 2's step 11
waits for it.

### Zero-cost and portal helpers

- `A1-preflight-and-key.sh`: plan task Z1, a live preflight of sandbox/inference (must print `GO`).
- `A2-z5-apply-env.sh [--apply]`: plan task Z5 step 1, the GitHub Environment for the federated apply
  job (dry run by default; `--apply` writes GitHub secrets and mints a 30-day state key).
- `A3-outage-test.sh`: the portal's retry behaviour under a real Wi-Fi outage (on the Mac itself, not
  over SSH).
- `L0-create-nip-lab.sh --region <region> [--apply]`: the dedicated `lab` stage project.
- `estate-check.sh [<nip-run>] [--expect "<type>:<n> ..."]`: what the live Nebius Estate portal shows for
  a run (read-only): resources labelled with the run and those the portal attributes to it through their node group
  or cluster (node VMs and their boot disks carry no `nip-run` label), each marked "(via …)".

## From a phone: Tailscale and tmux

A session is 4 to 6 h; the batch is hands-off after its first minute. To watch or answer it away from
the Mac, reach the Mac over SSH (for example with Tailscale, which gives the Mac a private address on
your tailnet) and run everything inside **tmux**, so a dropped phone connection never stops a step:

1. At the Mac, before you leave: `bash scripts/live/refresh-login.sh` (the login needs the browser),
   Docker Desktop running, the Mac on power and set not to sleep. The TTL jobs run under
   `caffeinate -i` ([`scripts/ttl-teardown.sh`](../scripts/ttl-teardown.sh)), which prevents idle sleep
   only; whether a job survives a forced sleep (lid closed on battery) is unknown, so do not rely on it.
2. A launcher saves typing on a phone keyboard. For example, in the Mac's shell profile:

   ```bash
   # live: attach to (or start) the tmux session for live runs, in the session's checkout
   live() { cd "<path to the checkout>" && tmux new-session -A -s live; }
   ```

   From the phone: `ssh <mac>`, `live`, then the [morning checklist](#morning-checklist)'s commands, for
   example `RESET_SESSION=1 R10_TOO=1 bash scripts/live/run-r1.sh` (or `bash scripts/live/run2-all.sh`, or
   one step). Detach with `Ctrl-b d`; `live` again re-attaches. Progress in a second tmux window
   (`Ctrl-b c`): `tail -f .cache/live/logs/run-r1-*.summary` (or `run2-all-*.summary`); switch windows with
   `Ctrl-b n`. A4's `RETIRE` and every `yes` prompt can be answered from the phone; only
   `refresh-login.sh` needs the Mac's browser.
3. Docker over SSH: Docker Desktop's credential helper needs the login keychain, which macOS does not
   unlock for a session without a screen. Over SSH the steps therefore give Docker an empty client
   config (`.cache/live/state/docker-ssh`, no credential helper, no stored login) and the Desktop socket;
   every image they pull is public.
4. `abort.sh` works from the phone like any other step.

## Abort and teardown

- **Normal end:** run 2's step 10, run 3's `run3-5-teardown.sh`, then run 2's step 11 (the gate).
- **Stop everything now:** `bash scripts/live/abort.sh`. It lists the sandbox roots that have state and
  asks you to type `ABORT`, then deletes the R6 endpoint, tears down `inference` (PVCs first), `gpu-vm`,
  `ml-services` (registry images first, then orphaned MLflow artifact buckets and the SecretStash
  secret), `data` and any other sandbox root with state, and runs `make leftovers-stage STAGE=sandbox`.
  - A root another process may be writing (a terraform process on it, a running apply or re-arm step,
    or its state lock object present) is **busy**: left alone with its TTL job armed.
  - While R1 is not verified gone, `ml-services` (node SA) and `data` (filesystem) are **kept** with
    their TTL jobs, so nothing is deleted under a live cluster (`ABORT_UNDER_R1=1` overrides).
  - A TTL job is cancelled only for a root destroyed by this run or whose state read empty. A state
    that cannot be read is never treated as empty.
  - `ABORT_ROOTS="inference data"` limits the roots. Soperator is not handled
    ([teardown runbook](teardown.md)).
- **A step failed, the session is fine:** fix the cause, run the same step again. Steps 2a, 2b, 2c and
  3.3 arm their TTL job before the apply; a rerun cancels the old job before arming a new one. After
  step 2d, 2a and 2b refuse to run again; after re-running 2c, run 2d again.
- **Fresh session** (after a teardown or abort, or another day): `RESET_SESSION=1 bash
  scripts/live/run2-0-preflight.sh` checks that every root is verified empty and no TTL job runs, then
  archives the old session state.
- **SecretStash deletes are soft:** a deleted secret can be restored for 30 days
  ([deleting secrets](https://docs.nebius.com/mysterybox/secrets/delete); mirror
  `.cache/nebius-docs/mysterybox/secrets/delete.md`), and whether its name can be reused meanwhile is
  unknown. If step 2b cannot create `nip-sandbox-ml-services`, look for the deleted one
  (`nebius mysterybox secret undelete --id <id>`) or wait.
- **By hand, one root:** `source scripts/bootstrap-backend.sh sandbox <stack>`, `make destroy-plan
  STACK=<stack> [PROFILE=…]`, `make destroy STACK=<stack> CONFIRM=yes`, `make leftovers STACK=<stack>`;
  then stop its TTL job: `kill "$(cat terraform/live/sandbox/<stack>/.terraform/ttl-teardown.pid)"`
  after checking that pid's command contains `ttl-teardown`.

### Re-running a check

While R1 is up (before step 10), any check step can be run again by hand, for example after a fix to a
validation script: `bash scripts/live/run2-3a-validate-gpu.sh`, then 3b, 3c, 3d. The batch does not
retry on its own: a retry hides the failure it would be retrying, and the RESULT blocks are the evidence.

## Lessons from 2026-10-12

- **Nothing load-bearing outside git.** The step scripts were written in a temporary scratch folder and
  copied by hand into `.cache/live`; fixes made during the session lived only there. They are now
  `scripts/live/`, tested in `make ci` (`tests/scripts/test-live-*.sh`) and shellcheck-clean; only the
  session's state and logs stay in the git-ignored `.cache/live/`.
- **No ids in scripts.** The scripts carried the sandbox project id; `.env` named another project. The
  target now comes from the stage binding (or exported variables) and a missing target is refused.
- **R11 model.** The bench loads the tokenizer from Hugging Face by the model id; a Token Factory id that
  is not a public repo failed before any request. The model is whatever `tests/load/bench.sh` defaults to
  (or `R11_MODEL`), named in the header, never a second copy in the step script.
- **Registry purge.** Images listed by `nebius registry image list` carried a top-level `.id`, not
  `.metadata.id`, so the purge found nothing to delete; a registry that still holds images cannot be
  deleted ([manage registries](https://docs.nebius.com/container-registry/registries/manage); mirror
  `.cache/nebius-docs/container-registry/registries/manage.md`). The purge reads both and re-lists to
  prove the registry is empty.
- **A failed GPU layer must not be silent.** A false `01-gpu` failure (fixed in
  [`tests/validate/01-gpu.sh`](../tests/validate/01-gpu.sh)) stopped step 3a, vLLM was never deployed and
  the batch carried on without saying so; a one-off recovery block re-ran the steps before teardown. The
  batch now reports the layers, skips the vLLM steps by name and still measures what does not need vLLM.
- **Docker over SSH** needs an empty client config (keychain); see [From a phone](#from-a-phone-tailscale-and-tmux).
- **Local ports.** The Nebius Estate portal holds 3000 during a session, so R14's port-forwards use
  13000/19090/19093 and pass the URLs to the acceptance script; a port already taken is refused, so the
  Grafana credentials never go to another local service.
- **"Done" is not "passed".** A RESULT block that ran to its end now says `finished`, with the verdict in
  its status lines; run 1 and step 3a print a `VERDICT`, and the batch ends with one and an exit code.
- **Batch passwords** come from `.env` by name and are never exported past the step that reads them.
