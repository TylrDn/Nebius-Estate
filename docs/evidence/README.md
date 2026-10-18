# Evidence

Every measured claim in this repository points at a file here or in `results/`. Two kinds of evidence
live here, and the header of every file says which:

1. **Runs of this repository's roots and scripts**, on 2026-10-11 (the federated plan ran at 03:23Z
   on 2026-10-12 UTC) and 2026-10-12. On 2026-10-11:
   - applies, each read back and torn down: five of the sandbox inference root (R1: two partial, two
     teardown verifications in one file, one serving Qwen2.5-1.5B), the first of R10 (GPU VM), R12
     (registry, MLflow, PostgreSQL), R8 (data) and R9 governance (one spot cap); billed figures come
     from the FOCUS export as it catches up;
   - one apply kept, not torn down: the first apply of the foundation (R2) with R13 federation for
     sandbox (IAM only);
   - the first federated CI plan (R13 plan side, after the audience finding R13-3);
   - live plans, nothing applied: R7, R3, R4 (and R9 and the foundation before their applies);
   - one paid request: R11 `smoke.py --yes`
     ([`2026-10-11-token-factory-smoke.md`](2026-10-11-token-factory-smoke.md)); the read-only model
     listing is in its [recipe](../../recipes/token-factory/README.md#evidence);
   - read-only: R9 `price.py --contract --advice` on every S1–S9 footprint, R14 `metrics.sh` and
     `logs.sh`, the portal's connectors and `yarn verify:live`, its AI-service and tenant-level reads,
     and its Budgets & credits against the live FOCUS export (local data only; the export import, 261
     rows, is recorded in the second sandbox apply).

   On 2026-10-12, runs 1 and 2 of the [live-run plan](../plans/2026-10-12-live-runs.md): the
   R11 concurrency sweep (the first figure judged against a pass bar), applies of R8, R12 and R1 with
   their acceptance scripts and R14's, each torn down with the stage gate clean, and the portal
   watching them. Raw step output is scrubbed into `results/2026-10-12/`.

   On 2026-10-13, the first R1-only session ([`2026-10-13-sandbox-r1-session.md`](2026-10-13-sandbox-r1-session.md)):
   an R1 apply that stopped on the Alertmanager PVC, torn down clean, and a retry without R14 that
   validated the node and gave the first measured R1 serving sweep (operator-host vantage).

   R5, R6, R15 and R16 have no run of this repository yet (R5's step stopped on its precondition on
   2026-10-12); R3, R4 and R7 have planned live, not applied; R13's apply side has not run. The level
   per recipe and the next live run for each: [README, What is proven](../../README.md#what-is-proven).
   The harnesses (bench sweep, acceptance scripts) write `results/*.json`; a run's evidence file cites
   the scrubbed copy under `results/<date>/` (What is committed, below).
2. **Prior validation runs of the upstream recipes** (2026-10-07/08, `uk-south1`, one B300 and CPU
   presets). They show that the *patterns* this repository encodes work on Nebius; they are **not**
   measurements of this repository's `eu-north1` defaults, and none of them measured InfiniBand
   bandwidth. Their verbatim output is in [`raw/`](raw/README.md); the upstream gaps they exposed are in
   [`upstream-findings.md`](../upstream-findings.md).

| File | Kind | Run | Proves |
|---|---|---|---|
| [`2026-10-08-mk8s-b300-gpu-smoke.md`](2026-10-08-mk8s-b300-gpu-smoke.md) | prior | MK8s + 1 preemptible B300 from the `k8s-training` recipe, driver image `cuda13.0` | driver, device plugin, NCCL 2.27.7 init and bf16 compute on B300; **busbw not measurable on one GPU** |
| [`2026-10-08-soperator-4.1.13-cpu.md`](2026-10-08-soperator-4.1.13-cpu.md) | prior | Soperator 4.1.13 from the recipe at `soperator-v4.1.13-2`, CPU worker | `sbatch` job COMPLETED end to end on run 7; five configuration findings on runs 1–2 and 4–6 (fixed in `terraform/stacks/soperator`) and one operational lesson on run 3 (an interrupted apply; `runbooks/incident.md`) |
| [`2026-10-11-portal-live-read-only.md`](2026-10-11-portal-live-read-only.md) | this repository | portal connectors, `yarn verify:live` and direct REST reads with a project-`viewer` service account, 9 projects in 9 regions; no compute | JWT exchange at `sts.nebius.com`, write refused (403), about 30 per-project lists readable with project `viewer`, which calls need tenant grants, page-size limits, quota limits absent from the API, one calculator list price, provider-metrics PromQL path; **no workloads, no GPU telemetry series** |
| [`2026-10-11-sandbox-inference-portal-connectors.md`](2026-10-11-sandbox-inference-portal-connectors.md) | this repository | first apply of `live/sandbox/inference`: cluster + 1 preemptible L40S node, `eu-north1`, then destroy | cluster discovery and viewer-only Kubernetes reads by the portal, GPU telemetry series, clean teardown; **CPU nodes blocked by a non-GPU vCPU quota of 0; no pod used the GPU** |
| [`2026-10-11-sandbox-inference-populate.md`](2026-10-11-sandbox-inference-populate.md) | this repository | `live/sandbox/inference` with `cpu_node_count = 0`: cluster + 1 preemptible L40S, `eu-north1`, 3 h TTL | GPU allocatable 1 on a GPU-only cluster, model weights load on the L40S, portal discovery/telemetry/billing on real data; **vLLM engine start failed (read-only root FS)**, fixed in the manifest; served in a later apply ([serving](2026-10-11-sandbox-inference-serving.md)) |
| [`2026-10-11-token-factory-smoke.md`](2026-10-11-token-factory-smoke.md) | this repository | R11 `smoke.py --yes`: one chat completion on Token Factory | key, base URL and client path work (HTTP 200, 947 ms, 31 tokens); **no throughput or percentile** |
| [`2026-10-11-observability-read-only.md`](2026-10-11-observability-read-only.md) | this repository | R14 `metrics.sh` and `logs.sh`, read-only with the `nip-portal-viewer` profile, one project | provider (952) and ingested (445) metric names, per-service metric buckets, log buckets and labels, control-plane error lines; `platform/alerts` metrics present or absent in Nebius Monitoring; **no Grafana, no trace, no journald** |
| [`2026-10-11-solutions-pricing.md`](2026-10-11-solutions-pricing.md) | this repository | `price.py --contract --advice` on every S1–S9 footprint (billing calculator + capacity advisor, `eu-north1`, `eu-west1`, `eu-west2`), Token Factory model listing and quota-name listing, read-only, 09:05–09:13Z | the list, spot and advisor figures in section 6 of every [solution](../../solutions/README.md); no reserved rate (no commitment on the account); **an estimate, not a quote; no solution deployed** |
| [`2026-10-11-portal-ai-services.md`](2026-10-11-portal-ai-services.md) | this repository | the portal's Hugging Face, Token Factory and tenant-level Nebius reads repeated by hand with `curl`, read-only, 09:50–09:51Z | HF token valid, both workload Qwen models readable, a gated model without access answers 403; Token Factory lists 25 models; tenant capacity block groups (200, 0 items) and tenant project list (200, 9 items) readable by the portal service account; **no connector code exercised, no completion, no weights** |
| [`2026-10-11-sandbox-inference-teardown-verify.md`](2026-10-11-sandbox-inference-teardown-verify.md) | this repository | third and fourth applies of `live/sandbox/inference` (1 preemptible L40S, 35 min, then a second identical run) to verify the destroy path and the portal lifecycle | `make destroy-plan` writes and removes the provider override unattended (12 destroyed); portal connects the cluster itself, retires its connector without false alerts, resolves per-VM alerts; **"being deleted" stale state not seen (15 min sync cadence)** |
| [`2026-10-11-sandbox-inference-serving.md`](2026-10-11-sandbox-inference-serving.md) | this repository | fifth apply of `live/sandbox/inference` plus the Qwen2.5-1.5B overlay (applied by the owner) on 1 preemptible L40S | **vLLM served**: Ready in 110 s after two live-found manifest fixes; 5 requests ~0.55 s each; portal Workloads 1/1 ready; **one client, no throughput or percentiles** |
| [`2026-10-11-sandbox-gpu-vm-live-recipe.md`](2026-10-11-sandbox-gpu-vm-live-recipe.md) | this repository | first apply of `live/sandbox/gpu-vm` (R10): 1 preemptible L40S VM, public address allowlisted to one /32, 17 min | VM up, vLLM under systemd answering 401 without the key 8 min after apply; portal attribution, run-rate, Fleet telemetry, serial logs; clean teardown; **no completion with the key (needs SSH)** |
| [`2026-10-11-sandbox-ml-services-live-recipe.md`](2026-10-11-sandbox-ml-services-live-recipe.md) | this repository | first apply of `live/sandbox/ml-services` (R12) without the node identity: registry, MLflow `medium`, PostgreSQL 16 | all three `RUNNING`; three live-only API behaviours found, two fixed (MLflow keeps no labels, PostgreSQL description charset) and one documented (MLflow has no update) and a residue-check gap (PostgreSQL list key); **no client used the services** |
| [`2026-10-11-sandbox-data-live-recipe.md`](2026-10-11-sandbox-data-live-recipe.md) | this repository | first apply of `live/sandbox/data` (R8): two buckets and a 256 GiB filesystem, 6 min | documented classes, versioning and lifecycle rules read back; clean teardown; **no throughput, transfer or restore** |
| [`2026-10-11-sandbox-live-plans.md`](2026-10-11-sandbox-live-plans.md) | this repository | live `make plan` (no apply) of R9 governance, R7, R3, R4 Soperator and the foundation with R13 `ci_federation` | all plan against the real API; two Soperator plan-path defects fixed; **nothing applied** |
| [`2026-10-11-sandbox-governance-live.md`](2026-10-11-sandbox-governance-live.md) | this repository | first apply of `live/sandbox/governance` (R9): one H100 spot price cap, applied, read back and destroyed | the cap is created `STATE_ACTIVE` / `SCHEDULING_STATE_ALLOWED`; L40S takes no spot cap; the API keeps no labels and stores the price canonically (both fixed); no leftovers |
| [`2026-10-11-foundation-ci-federation-live.md`](2026-10-11-foundation-ci-federation-live.md) | this repository | first apply of `live/foundation` (R13) with `ci_federation` for sandbox, IAM only | both GitHub federated credentials exist with the immutable subject GitHub sends; CI apply `editor`, plan `viewer`; the bootstrap's membership is adopted (fixed). The GitHub → Nebius token exchange itself is proven by the first federated CI plan (`2026-10-11-sandbox-ci-federated-plan.md`) |
| [`2026-10-11-sandbox-ci-federated-plan.md`](2026-10-11-sandbox-ci-federated-plan.md) | this repository | first federated `terraform.yml` plan (sandbox/network) from the `sandbox-plan` environment with no stored key | GitHub OIDC → Nebius STS token for the plan identity (audience `sts.nebius.com` only, 12 h), read-only state, plan 18 to add; **apply side not run, keys not retired** |
| [`2026-10-11-portal-budgets-live.md`](2026-10-11-portal-budgets-live.md) | this repository | the portal's Budgets & credits API on the local dev backend (guest identity): one credit entered and kept, one temporary monthly budget entered, read back and deleted | a budget's spend to date is the live FOCUS actual plus the run-rate estimate, each labelled by source, with a coherent burn rate, forecast and status; **local data, no console budget compared, no Token Factory draw-down yet** |
| [`2026-10-12-token-factory-bench.md`](2026-10-12-token-factory-bench.md) | this repository | R11 `tests/load/bench.sh --target r11`: 200 prompts at each of 1, 8 and 32 concurrent, `Qwen/Qwen3-30B-A3B-Instruct-2507`, from the operator host | **Measured**: 600/600 answered; E2E p99 14.1 s at c=1 (**fails** the 10 s bar), 3.9 s at c=8 and 4.4 s at c=32 (pass); 30, 463 and 1,195 output tok/s; $0.30 per 1M output (list). Earlier attempts with a serving name as tokenizer sent nothing (ours) |
| [`2026-10-12-sandbox-session-lifecycle.md`](2026-10-12-sandbox-session-lifecycle.md) | this repository | R2 and R9 around run 2: preflight, re-price, TTL jobs, teardown and the stage gate for the data, ml-services and inference roots | plan-scoped preflight GO (after a tenant-wide NO-GO was fixed), L40S preemptible $0.7492/h on the day, TTL jobs armed before every apply, a teardown that stopped safely on a non-empty registry and finished clean on rerun, stage gate clean; **no TTL job fired, no billed total yet** |
| [`2026-10-12-sandbox-data-acceptance.md`](2026-10-12-sandbox-data-acceptance.md) | this repository | second apply of `live/sandbox/data` (R8, 4 resources), `03-storage.sh` fio from the R1 GPU node, the restore drill | shared filesystem 2,066 MiB/s write and 1,757 MiB/s read (4 jobs, one short run, above the 450 MiB/s floor); **restore drill not run** (harness `aws` wrapper) |
| [`2026-10-12-sandbox-ml-services-acceptance.md`](2026-10-12-sandbox-ml-services-acceptance.md) | this repository | second apply of `live/sandbox/ml-services` (R12, 8 resources, node identity) and its check Job | one-pass apply (No changes), SecretStash secret from a request file, registry push/pull, node pull with no pull secret, PostgreSQL 16 `select 1` over `verify-full`; **MLflow check failed (cause unknown)**; image list id at `.id` (R12-1) |
| [`2026-10-12-sandbox-inference-validate.md`](2026-10-12-sandbox-inference-validate.md) | this repository | sixth apply of `live/sandbox/inference` (R1, 1 preemptible L40S, 11 resources) and `tests/validate` 00–03 | cluster and node up in 9 min, L40S 46,068 MiB on driver 580.173.02, headroom for vLLM; a `01-gpu` false positive fixed; **NCCL step timed out; no vLLM, so nothing served or benchmarked** |
| [`2026-10-12-sandbox-inference-o11y-acceptance.md`](2026-10-12-sandbox-inference-o11y-acceptance.md) | this repository | R14 `recipes/observability/acceptance.sh` against the o11y releases of the R1 apply | Grafana and Alertmanager answer, a test alert routes (to `null`); **no data source provisioned**; rules check read the Grafana service, so whether rules load is unknown |
| [`2026-10-12-portal-estate-live-session.md`](2026-10-12-portal-estate-live-session.md) | this repository | the portal watching run 2 (read-only) and a real Wi-Fi outage | discovery within one sync with labels and TTL, cluster auto-connected, L40S telemetry, run-rate, `GpuIdle` pending then resolved, retries absorb a short outage and degrade cleanly on a long one; **slow-tier lists stale after deletion; owner's record, no raw file** |
| [`2026-10-13-sandbox-r1-session.md`](2026-10-13-sandbox-r1-session.md) | this repository | the first R1-only session (`scripts/live/run-r1.sh`, `R10_TOO=1`): seventh apply of `live/sandbox/inference` on 1 preemptible L40S with its own filestore, then R10's plan; a retry with `R14=0` (eighth apply, validate 00–04 and the load sweep) in the same file | session 1: one-SIGINT stop with state intact, teardown and stage gate clean; **apply stuck 59 min on the Alertmanager PVC (R1-20); R10 plan failed on `subnet_id`**. Retry: apply 8 min, 00–04 pass, **Measured** from the operator host via port-forward: 200/200 at 1, 8, 32 concurrent, E2E p99 ≤ 1.47 s (bar 10 s), up to 3,696 output tok/s, $0.056 per 1M output at 32; **in-cluster bench blocked by egress (R1-21)**; teardown and stage gate clean |
| [`costs.md`](costs.md) | prior | all 11 runs (4 passed), including a serverless bench attempt and an fio run that left only a cost estimate (no figure from either may be quoted) | billed total from the FOCUS export ($8.19) and the lab harness's per-run estimates ($13.29, about 1.6× the bill) |
| `<date>-<stage>-<stack>-<what>.md` (e.g. `2026-11-02-sandbox-inference-validate.md`), `<date>-serverless-comparison.md` | this repository | future runs of `tests/validate`, `tests/load/bench.sh`, the acceptance scripts, `runbooks/*`, `recipes/serverless/compare.py` | the recipe's row in [What is proven](../../README.md#what-is-proven) moves up a level ("Measured" only with a pass bar) |
| `../../results/<date>/*.json` | this repository | `tests/validate/*.sh`, `tests/load/bench.sh`, the acceptance scripts, `recipes/serverless/*.sh`, scrubbed | machine-readable step results of the run of that date |

**What is committed.** The scripts write `results/*.json` (and `bench-*.log`); that raw output names
real clusters, nodes, registries and hosts, so it stays local (git-ignored). What is committed is a
scrubbed copy under `results/<date>/`, next to the evidence file that cites it:
`scripts/scrub-evidence.py --write results/<date> results/<step>.json …` replaces every resource id
with a placeholder (`computeinstance-<id>`, `cr.<region>.nebius.cloud/<id>/…`), replaces a recorded
kube context that is not a `nebius-mk8s-…` session context with `<unrelated-context>`, and keeps
digests, versions and timestamps. `make selftest` (`tests/scripts/test-evidence.sh`) fails if any committed
file under `docs/evidence/` (but `raw/`) or `results/` still carries an id, or if a dated evidence file
has no row here. `results/private/` (anything that may hold customer data) and `results/*.state`
(live endpoint IDs and tokens) are git-ignored too.

File names start with the date (`YYYY-MM-DD-<subject>.md`); for a run of a live root the subject is
`<stage>-<stack>-<what>`.

## Header every evidence file carries

```markdown
# <what ran> — <date>
- Kind: prior live run of the upstream recipe | run of this repository
- Date / region / platform / presets
- Versions: recipe tag + sha, operator/driver/NCCL/Kubernetes versions as observed
- Method: the exact command or script, flags and sizes
- Cost: minutes and USD actually billed (console figure), capacity type
- Caveats: what this run does NOT show
```

Template for a run of this repository (`<date>-<stage>-<stack>-<what>.md`):

```markdown
# <stage>/<stack> run — <date>
- Kind: run of this repository (commit <sha>)
- Operator, project, region, presets (from terraform output; no real resource IDs)
- Versions: docs/compatibility-matrix.md at commit <sha>
- Steps: paste results/summary.json
- Load: method tests/load/README.md; numbers from results/05-load.json
- Rollback drill: times from runbooks/rollback.md steps 1–4
- Spend: console figure for the run; teardown residue check output
- Deviations from the runbook and why
```
