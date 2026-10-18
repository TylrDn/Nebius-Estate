# Token Factory concurrency sweep (R11) — 2026-10-12

- **Kind:** run of this repository (`tests/load/bench.sh --target r11`, the paid `CONFIRM=yes` sweep), run 1
  of the [live-run plan](../plans/2026-10-12-live-runs.md), approved by the owner (≈ $0.03 planned).
- **Date / service:** 2026-10-12, sweep 19:00–19:16 UTC, Nebius Token Factory
  `https://api.tokenfactory.nebius.com`, endpoint `/v1/chat/completions`, model
  `Qwen/Qwen3-30B-A3B-Instruct-2507`. Vantage `operator-host`: the owner's machine over the public
  internet, so every latency includes that path.
- **Versions:** load generator `vllm bench serve` from `vllm/vllm-openai:v0.31.0` (digest-pinned in
  `platform/versions.yaml`), run in Docker on the host, CPU only (`vllm._C` absent and unused by the client).
- **Method:** [`tests/load/README.md`](../../tests/load/README.md): random dataset, 256 input / 128 output
  tokens, 10 warm-up prompts, then 200 prompts at each concurrency 1, 8 and 32, streamed. Pass bars:
  E2E p99 ≤ 10 s ([`docs/slo.md`](../../docs/slo.md), p95 target applied at p99) and every request
  answered; TTFT, TPOT and throughput bars unset (printed `null`). Cost per 1M output tokens from the
  listed price, `BENCH_USD_PER_1M_OUTPUT=0.30`.
- **Cost:** about 158k input and 77k output tokens; ≈ $0.04 at the listed $0.10 / $0.30 per 1M
  (`GET /v1/models?verbose=true` on the day; the API states no unit, [R11-2](../upstream-findings.md#r11-token-factory)).
  Billed to the Token Factory account, not the cloud bill; no usage API, so no billed figure here.
- **Caveats:** one sweep, one vantage, one model; a shared multi-tenant endpoint whose load at the time is
  unknown. Not a latency guarantee and not comparable with R1/R10 numbers measured in-region.

## Results

Raw: [`results/2026-10-12/bench-r11.json`](../../results/2026-10-12/bench-r11.json) (no resource ids;
committed as written).

| Concurrency | Answered | Output tok/s | TTFT p50 / p99 | TPOT p50 / p99 | E2E p50 / p99 | Bar (E2E p99 ≤ 10 s) | $ / 1M output |
|---|---|---|---|---|---|---|---|
| 1 | 200 / 200 | 30.3 | 340 / 9,695 ms | 16.8 / 53.2 ms | 2.47 / **14.1 s** | **fail** | 0.30 |
| 8 | 200 / 200 | 462.6 | 279 / 534 ms | 13.5 / 29.1 ms | 2.03 / 3.95 s | pass | 0.30 |
| 32 | 200 / 200 | 1,195.5 | 310 / 609 ms | 21.8 / 31.4 ms | 3.12 / 4.35 s | pass | 0.30 |

- 600 of 600 sweep requests answered, none failed. The first single request took 3.27 s.
- The run's verdict is **fail**: the bars apply to every point, and c=1 missed E2E p99 by 4.1 s. Its TTFT
  p99 (9.7 s against a 340 ms median) says a few requests waited long before the first token; why is
  unknown (endpoint queueing, the internet path and the client are not separated by this method).
  `max_passing_concurrency` is therefore `null`, although c=8 and c=32 passed.

### Attempts before the sweep

| Time (UTC) | Model | Outcome | Cause |
|---|---|---|---|
| 18:16 | `nvidia/Nemotron-3_5-Lightning` (the bench default then) | no request sent; generator exit 125 | Docker could not start the generator container; the log holds no reason (unknown) |
| 18:51 | `nvidia/Nemotron-3_5-Lightning` | no request sent; no points ([`bench-r11-nemotron.json`](../../results/2026-10-12/bench-r11-nemotron.json)) | `vllm bench serve` loads a Hugging Face tokenizer by the model id, and the Token Factory serving name is not a Hugging Face repo. **This repository's error**, not a Nebius defect: nothing promises that a served name is a tokenizer repo (whether the Token Factory docs say which tokenizer a model uses is unknown here: they are not in the local docs mirror). The fix (a default model whose id is a public repo, a `--tokenizer` input, a tokenizer check before the paid run) is a separate change to `tests/load/bench.sh`; the sweep below named the model explicitly |
| 19:00–19:16 | `Qwen/Qwen3-30B-A3B-Instruct-2507` | the sweep above | — |

## What this does and does not show

- Shows: R11's client path sustains 32 concurrent streams with every request answered, 1,195 output
  tokens/s from one client host, and E2E p99 within the 10 s bar at 8 and 32; the cost per 1M output
  tokens at the listed price. This is the first figure in this repository judged against a pass bar.
- Does not show: behaviour above 32 concurrent requests or under rate limits (none hit); the cause of
  the c=1 tail; latency from inside a Nebius region; a dedicated endpoint; any billed amount.
