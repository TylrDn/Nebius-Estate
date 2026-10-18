# Load method (R1, R6, R10, R11)

No number in this repo is quoted without this method and the exact versions in
`results/` (P6). One generator and one parser serve every serving target, so their results
have the same shape and can be set side by side.

| File | Role |
|---|---|
| [`sweep.sh`](sweep.sh) | the generator: `vllm bench serve` from the pinned vLLM image, a first request, a warm-up, then one closed-loop run per concurrency point; prints `=== nip-bench` markers |
| [`bench.py`](bench.py) | the parser: sweep log → result JSON, pass bars per point, cost per 1M output tokens (stdlib) |
| [`bench-job.yaml`](bench-job.yaml), [`lib-bench.sh`](lib-bench.sh) | `sweep.sh` as a Kubernetes Job (R1, and R6 measured from inside the R1 cluster) |
| [`bench.sh`](bench.sh) | `sweep.sh` in the pinned image under Docker, from wherever it runs (R10, R11, R6 from the operator host) |
| [`selftest.sh`](selftest.sh), [`fixtures/`](fixtures/README.md) | offline self-test of the parser on synthetic logs (`make selftest`) |

## Method

### Operator-host fallback

If the in-cluster sweep cannot download the model tokenizer, preserve its failed result.
To reproduce the October 13 host vantage, port-forward the serving endpoint in one terminal:

```bash
kubectl -n inference port-forward svc/vllm 8000:8000
```

In another terminal, use the existing generator against that loopback endpoint:

```bash
RESULTS_DIR=results/private/host-fallback \
  tests/load/bench.sh --target r1 --base-url http://127.0.0.1:8000 \
  --model Qwen/Qwen2.5-1.5B-Instruct --vantage operator-host-port-forward
```

The JSON retains recipe `r1` and the explicit `operator-host-port-forward` vantage;
it is not R1 in-cluster evidence. Record the model, image, input/output lengths,
concurrency and tunnel. No API key is needed for the local unauthenticated sandbox;
set `BENCH_API_KEY` for an authenticated server. Docker host networking must reach the
port-forward (native Linux, or explicitly enabled Docker Desktop host networking).
The generator still needs tokenizer access. No billing or GPU-utilisation claims follow.
Stop the tunnel
afterward. Do not overwrite earlier results or compare unlike vantage points as equivalent.


- **Generator:** `vllm bench serve --backend openai-chat --endpoint /v1/chat/completions` from
  the vLLM image pinned in `platform/versions.yaml`, dataset `random`, request rate `inf`
  (closed loop: concurrency is the only throttle), percentiles 50 and 99.
- **Cold start:** taken from the step that actually meets the fresh server, never from the sweep.
  Server start-up (process start to ready): R1 `04-workload` (`startup_seconds`), R6
  `endpoint.sh create` (`cold_start_seconds`), R10 the caller (`--server-startup-s`, from
  `journalctl -u vllm`); R11 has none. First request (`cold_start.first_request_ms`, with
  `first_request_source`): R1 `04-workload`'s chat completion, R6 the `endpoint.sh measure` probe;
  R10 and R11 `null` unless the caller passes `--first-request-ms`.
- **First sweep request:** one prompt before the warm-up, reported as `first_sweep_request_ms`.
  It is **not** a cold figure: the caller's probe and `vllm bench serve`'s own test request come
  before it.
- **Warm-up:** `BENCH_WARMUP_PROMPTS` at concurrency 8, discarded. `warm.first_point_e2e_p50_ms`
  is the first sweep point's median after it.
- **Sweep:** `BENCH_NUM_PROMPTS` prompts at each value of `BENCH_CONCURRENCY`, in order. A point
  that crashes, or never starts because the sweep stopped early, is reported with null figures and
  fails; a log without the `=== nip-bench end` marker is `sweep_complete: false` and fails; under
  `bench.sh` a non-zero container exit (`generator_exit_code`) fails the run. Nothing is filled in.
- **Placement (R1):** the Job requires a node **without** `nip.nebius.io/gpu` when the cluster
  has one, so the generator never shares the serving GPU node. A GPU-only cluster (the
  2026-10-11 sandbox ran with 0 CPU nodes) has no such node: the Job then runs on the GPU node and
  `placement.note` says the generator's CPU use is inside the measurement. GPU utilisation is
  sampled from DCGM on every poll while the Job runs (`tests/scripts/test-load.sh` checks the
  samples reach the result). `region` is the nodes' `topology.kubernetes.io/region` label.

### Inputs

| Variable | Default | Meaning |
|---|---|---|
| `BENCH_CONCURRENCY` | `1 8 32` | concurrency points, space-separated |
| `BENCH_NUM_PROMPTS` | `200` | prompts per point |
| `BENCH_INPUT_LEN` / `BENCH_OUTPUT_LEN` | `256` / `128` | random prompt and completion lengths (tokens) |
| `BENCH_WARMUP_PROMPTS` | `10` | discarded warm-up prompts |
| `BENCH_POLL_TRIES` × `BENCH_POLL_INTERVAL` | `240` × `15` s | how long a Job is waited for (the Job's own deadline is 1 h) |

The defaults are the method this repository has always documented (one point at 32 is now the
last of three); change them per client and record the change with the result. Set them to the
client's traffic shape (for example a RAG workload: long input, short output);
[`docs/rescoping.md`](../../docs/rescoping.md) says what each costs. The shape that ran is recorded
under `params` in the result. `bench_check` (`lib-bench.sh`) refuses anything but positive integers
with exit 2 before kubectl or Docker is touched, so a refused shape costs nothing and keeps the
previous result: `05-load.sh`, `bench.sh` and `endpoint.sh measure` all go through it.

Example: `BENCH_INPUT_LEN=2048 BENCH_OUTPUT_LEN=256 WITH_LOAD=1 make validate-cluster`.

### Pass bars

Each bar applies to **every** point; the run passes only when every point does. Three fields read
the points together:

- `max_passing_concurrency`: capacity at the bar, the highest swept level N such that every swept
  level up to and including N passed; `null` when the lowest level failed.
- `highest_passing_concurrency`: the highest level that passed, whatever happened below it; `null`
  when none passed.
- `failed_levels`: every level that did not pass (a broken bar, lost requests, or no result), in
  sweep order; `[]` on a passing run.

They differ when a low level fails and higher ones pass. The 2026-10-12 R11 run, on a shared public
endpoint, is an example: concurrency 1 broke the E2E bar (p99 14.1 s > 10 s, one TTFT tail outlier of
9.7 s), and 8 and 32 passed. That reads `max_passing_concurrency: null`,
`highest_passing_concurrency: 32`, `failed_levels: [1]`: the run fails, and the outlier at 1 is not
a capacity limit. Re-run, or look at the failing point's `failures`, before calling it one.

| Bar | Variable / flag | Default | Source of the default |
|---|---|---|---|
| E2E latency p99 | `BAR_MAX_E2E_P99_MS` / `--max-e2e-p99-ms` | `10000` | [`docs/slo.md`](../../docs/slo.md): p95 E2E ≤ 10 s for staging and prod, applied here at p99 (stricter) |
| Requests answered | `BAR_MIN_SUCCESS_RATIO` / `--min-success-ratio` | `1.0` | a lost request is a failure, not a slow one |
| TTFT p99 | `BAR_MAX_TTFT_P99_MS` / `--max-ttft-p99-ms` | none | no documented target; model- and client-specific |
| TPOT p99 | `BAR_MAX_TPOT_P99_MS` / `--max-tpot-p99-ms` | none | no documented target; model- and client-specific |
| Output tokens/s | `BAR_MIN_OUTPUT_TPS` / `--min-output-tps` | none | a capacity figure ([`docs/slo.md`](../../docs/slo.md)); set it from the first recorded baseline on the same preset |

An unset bar is printed as `null` in `bars`, so a result never looks judged on something it was not.

### Cost per 1M output tokens

`$ per 1M output tokens = usd_per_hour / (output_tokens_per_s × 3600 × utilisation) × 1e6`, the
formula in [`docs/evidence/costs.md`](../../docs/evidence/costs.md#cost-per-output-token-a-method-not-a-result),
computed per point. `BENCH_USD_PER_HOUR` is the node's (R1, R10) or endpoint's (R6) rate read from the
console or calculator on the day ([`docs/cost.md`](../../docs/cost.md)); there is no default and,
without it, the cost is `null` with a note. `BENCH_UTILISATION` (default `1.0`) is the share of the
hour the GPU is this busy. R11 bills per token (`cost.model: per-token` with or without a price):
`BENCH_USD_PER_1M_OUTPUT` is the listed price (`list-models.sh --verbose`; the API's price fields
carry no unit), reported as is; without it the cost is `null` and the note asks for it.

## Result

`bench.py parse` prints one JSON object (`schema: nip-bench/1`); `05-load.sh` records it as
`results/05-load.json` `details`, `bench.sh` as `results/bench-<target>.json`.

| Field | Meaning |
|---|---|
| `target`, `vantage` | `r1`/`r6`/`r10`/`r11`; where the generator ran: `in-cluster`, `in-region-cluster-job`, `in-vpc`, `operator-host` |
| `model`, `image`, `base_url`, `params` | what was measured, with the sweep shape |
| `tokenizer` | `null` when `vllm bench serve` used the model's own tokenizer; the Hugging Face repo when `--tokenizer` stood in for it (token counts approximate) |
| `points[]` | per concurrency: requests/s, output tokens/s, TTFT/TPOT/E2E p50 + p99 (ms), successful/failed requests, cost per 1M output tokens, `pass`, `failures` |
| `cold_start`, `first_sweep_request_ms`, `warm` | server start-up (s) and first request (ms) from the step that sent it, with its source; the sweep's first request (not cold); first point median after warm-up |
| `sweep_complete`, `generator_exit_code` | the end marker was seen; the `bench.sh` container's exit code |
| `region` (R1), `endpoint_region` / `generator_region` (R6) | where the lab, the endpoint (`NEBIUS_REGION` at create) and the R6 generator Job ran; `null` when unrecorded |
| `bars`, `cost`, `max_passing_concurrency`, `status` | the bars applied (with their source), the price inputs and formula, capacity at the bar (every level up to it passed), pass/fail |
| `highest_passing_concurrency`, `failed_levels` | the highest level that passed regardless of lower ones; the levels that did not pass ([Pass bars](#pass-bars)) |
| `placement` (R1) | `cpu_node_available`, `bench_node`, `serving_node`, `bench_on_gpu_node`, `note` |
| `gpu_util_pct_during_run` (R1) | DCGM `GPU_UTIL` samples taken while the Job ran: count, mean, max |

**Not recorded, say so:** multi-replica scaling, long-context behaviour, prefix-cache effects
(random prompts share no prefix).

## Run

| Target | Command |
|---|---|
| R1 (in-cluster Job) | `WITH_LOAD=1 tests/validate/run-all.sh` or `tests/validate/05-load.sh` |
| R6 (serverless endpoint) | `MEASURE_FROM=cluster recipes/serverless/endpoint.sh measure` (in-region Job in the R1 cluster), or without `MEASURE_FROM` from the operator host ([recipe](../../recipes/serverless/README.md)) |
| R10 (GPU VM) | `BENCH_API_KEY=… tests/load/bench.sh --target r10 --base-url http://127.0.0.1:8000 --model <repo>` through the recipe's SSH tunnel |
| R11 (Token Factory) | `CONFIRM=yes tests/load/bench.sh --target r11 [--model <id>] [--tokenizer <hf repo>]` (paid per token) |

`bench.sh` runs `sweep.sh` in the pinned vLLM image under Docker (`--network host`) and writes
`results/bench-<target>.json` plus the raw log. The key is `BENCH_API_KEY` (R11 falls back to
`NEBIUS_API_KEY` in the environment; nothing reads `.env`) and reaches the container by name as
`OPENAI_API_KEY`, never as an argument.

- **R10 key without SSH:** not possible by the recipe's design. The key is generated on the VM at
  first start and is never in user data, the plan or state
  ([`stacks/gpu-vm`](../../terraform/stacks/gpu-vm/README.md#what-it-builds)); the only way to read
  it is the `how_to_reach.api_key` SSH command. Server start-up for R10 is passed with
  `--server-startup-s` (from `journalctl -u vllm`), since nothing outside the VM sees it.
- **R11** bills per token to the key's Token Factory account, so `bench.sh` refuses without
  `CONFIRM=yes` and prints the request and token count it would send. Public-endpoint rate limits
  ([recipe](../../recipes/token-factory/README.md#rate-limits)) bound what the higher concurrency
  points can show.
- **R11 model and tokenizer.** `vllm bench serve` loads the tokenizer from Hugging Face by the model
  id. A Token Factory id is a serving name and not always a repo: on 2026-10-12 the run with
  `smoke.py`'s `nvidia/Nemotron-3_5-Lightning` failed before any request (`Repository Not Found …
  401`, [R11-3](../../docs/upstream-findings.md#r11-token-factory)). So the R11 default model is
  `Qwen/Qwen3-30B-A3B-Instruct-2507`, served by Token Factory and a public, ungated repo (checked
  2026-10-12); `openai/gpt-oss-120b` is another.

  | Input | Default | Meaning |
  |---|---|---|
  | `--model` / `BENCH_MODEL` | R11: `Qwen/Qwen3-30B-A3B-Instruct-2507` | served model id (the flag wins); R6 and R10 require one |
  | `--tokenizer` / `BENCH_TOKENIZER` | unset | a public Hugging Face repo whose tokenizer stands in for the model's; recorded as `tokenizer` in the result |
  | `BENCH_HF_CHECK` | `1` | `0` skips R11's tokenizer check (offline use and tests) |

  Before the paid run (after `CONFIRM=yes`) `bench.sh` asks `https://huggingface.co/api/models/<id>`
  anonymously, for the tokenizer or else the model, and refuses with exit 2 when the id is not
  `owner/name`, the request fails, the answer is not HTTP 200, or the repo is gated (the container
  carries no Hugging Face token). The check is free and sends nothing to Token Factory. With
  `--tokenizer`, input and output token counts, and so tokens/s and cost per 1M output tokens, are
  the stand-in tokenizer's: **approximate**, and `bench.sh` says so. Pick a tokenizer from the same
  model family when there is one.
