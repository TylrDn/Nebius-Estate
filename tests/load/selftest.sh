#!/usr/bin/env bash
# Fixture self-test for the load harness (runs in CI through tests/validate/selftest.sh; needs only
# bash, jq and python3): bench.py turns a sweep.sh log into the result JSON, applies the pass bars
# per concurrency point, prices output tokens with the docs/evidence/costs.md formula, and never
# reports a point it did not see. The fixtures are synthetic (fixtures/README.md).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
export PYTHONDONTWRITEBYTECODE=1
# Bars and prices come from the environment too; a caller's values must not change this test.
unset BAR_MAX_TTFT_P99_MS BAR_MAX_TPOT_P99_MS BAR_MAX_E2E_P99_MS BAR_MIN_OUTPUT_TPS BAR_MIN_SUCCESS_RATIO \
  BENCH_USD_PER_HOUR BENCH_UTILISATION BENCH_USD_PER_1M_OUTPUT
check() { # <name> <jq-condition> <bench.py parse args...>
  local name="$1" cond="$2" out; shift 2
  out="$(python3 bench.py parse "$@")"
  jq -e "$cond" <<<"$out" >/dev/null || { echo "FAIL ${name}: ${cond}"; echo "$out"; exit 1; }
  echo "ok   ${name}"
}

# Shape: one entry per point, in sweep order, with the documented fields; params from the header.
check pass-shape '.schema=="nip-bench/1" and .target=="r1" and .vantage=="in-cluster" and .status=="pass"
  and ([.points[].concurrency]==[1,8,32]) and .params.input_len==256 and .params.output_len==128
  and .params.num_prompts==200 and .model=="Qwen/Qwen2.5-1.5B-Instruct"
  and .points[1].ttft_ms=={"p50":40.2,"p99":80.3} and .points[1].tpot_ms=={"p50":5.1,"p99":6.2}
  and .points[1].e2e_ms=={"p50":690.7,"p99":900.2} and .points[1].output_tokens_per_s==1523.4
  and .points[1].requests_per_s==11.9 and .points[1].successful_requests==200 and .points[1].failed_requests==0
  and .max_passing_concurrency==32 and .method=="tests/load/README.md"' \
  fixtures/sweep-pass.log --target r1 --vantage in-cluster

# Default bars are recorded with their source; the unset ones say so instead of passing silently.
check default-bars '.bars.max_e2e_p99_ms==10000 and .bars.min_success_ratio==1 and .bars.max_ttft_p99_ms==null
  and .bars.min_output_tokens_per_s==null and (.bars.source|test("docs/slo.md"))' \
  fixtures/sweep-pass.log --target r1

# Cold vs warm: the sweep's first request is not cold (04-workload, a probe or vllm's own test
# request may come before it), so it is reported as first_sweep_request_ms. The cold first request
# is taken from the step that sent it (--first-request-ms); without one it is null, never guessed.
check cold-warm '.cold_start.first_request_ms==90 and (.cold_start.first_request_source|test("04-workload"))
  and .cold_start.server_startup_s==312 and .first_sweep_request_ms==2380
  and .warm.first_point_e2e_p50_ms==600.1 and .warm.concurrency==1 and (.cold_start|has("first_sweep_request_ms")|not)' \
  fixtures/sweep-pass.log --target r1 --server-startup-s 312 --first-request-ms 90 --first-request-source 04-workload
check cold-unknown '.cold_start.first_request_ms==null and .cold_start.first_request_source==null and .first_sweep_request_ms==2380' \
  fixtures/sweep-pass.log --target r10

# Cost per 1M output tokens: (usd/h) / (tok/s x 3600 x utilisation) x 1e6, per point.
# 0.75 / (1523.4 x 3600 x 0.5) x 1e6 = 0.2735...
check cost-formula '.points[1].cost_per_1m_output_tokens_usd==0.2735 and .cost.usd_per_hour==0.75
  and .cost.utilisation==0.5 and (.cost.formula|test("docs/evidence/costs.md"))' \
  fixtures/sweep-pass.log --target r1 --usd-per-hour 0.75 --utilisation 0.5
check cost-unknown '.points[0].cost_per_1m_output_tokens_usd==null and .cost.usd_per_hour==null and (.cost.note|test("BENCH_USD_PER_HOUR"))' \
  fixtures/sweep-pass.log --target r1
# Per-token pricing (R11): the listed price is the cost; no hourly rate applies.
check cost-per-token '.points[2].cost_per_1m_output_tokens_usd==0.4 and .cost.model=="per-token"' \
  fixtures/sweep-pass.log --target r11 --usd-per-1m-output 0.4
# R11 without a price: still per-token, and the note asks for the per-token price, not an hourly rate.
check cost-r11-unknown '.cost.model=="per-token" and .points[0].cost_per_1m_output_tokens_usd==null
  and (.cost.note|test("BENCH_USD_PER_1M_OUTPUT")) and (.cost.note|test("BENCH_USD_PER_HOUR")|not)' \
  fixtures/sweep-pass.log --target r11

# The tokenizer that counted the tokens is recorded: null when vllm bench serve used the model's own,
# the named repo when --tokenizer / BENCH_TOKENIZER replaced it (token counts then approximate).
check tokenizer-default 'has("tokenizer") and .tokenizer==null' fixtures/sweep-pass.log --target r1
check tokenizer-named '.tokenizer=="Qwen/Qwen3-30B-A3B-Instruct-2507" and .model=="vendor/served-name" and .status=="pass"' \
  fixtures/sweep-tokenizer.log --target r11

# A bar broken at one point fails the run and names the point and the bar.
check slow-fails '.status=="fail" and .points[2].pass==false and .points[1].pass==true and .max_passing_concurrency==8
  and (.points[2].failures|any(test("e2e_ms.p99")))' \
  fixtures/sweep-slow.log --target r1
# Only the lowest point fails (a tail outlier on a shared endpoint): capacity at the bar stays null,
# since not every point up to any N passed, while the highest passing point and the failed levels say
# what did pass.
check low-fails '.status=="fail" and .points[0].pass==false and .points[1].pass==true and .points[2].pass==true
  and .max_passing_concurrency==null and .highest_passing_concurrency==32 and .failed_levels==[1]
  and (.points[0].failures|any(test("e2e_ms.p99")))' \
  fixtures/sweep-low-fails.log --target r11
# The new fields on the other shapes: all pass, top point fails, crashed point, nothing passes.
check levels-pass '.highest_passing_concurrency==32 and .failed_levels==[]' fixtures/sweep-pass.log --target r1
check levels-slow '.highest_passing_concurrency==8 and .failed_levels==[32] and .max_passing_concurrency==8' fixtures/sweep-slow.log --target r1
check levels-truncated '.highest_passing_concurrency==8 and .failed_levels==[32]' fixtures/sweep-truncated.log --target r1
check levels-none '.highest_passing_concurrency==null and .failed_levels==[1,8,32] and .max_passing_concurrency==null' \
  fixtures/sweep-pass.log --target r1 --min-output-tps 1000000
# Bars are inputs: raising the E2E bar passes it; a TTFT bar fails it again.
check bar-input '.status=="pass"' fixtures/sweep-slow.log --target r1 --max-e2e-p99-ms 20000
check bar-ttft '.status=="fail" and .max_passing_concurrency==1 and (.points[1].failures|any(test("ttft_ms.p99")))' \
  fixtures/sweep-pass.log --target r1 --max-ttft-p99-ms 50
check bar-env '.status=="fail" and .bars.min_output_tokens_per_s==2000' fixtures/sweep-pass.log --target r1 --min-output-tps 2000
BAR_MIN_OUTPUT_TPS=200 check bar-from-env '.bars.min_output_tokens_per_s==200 and .status=="pass"' fixtures/sweep-pass.log --target r1

# Lost requests fail the success bar; a crashed point is reported, not dropped or invented.
check partial-fails '.status=="fail" and .points[1].failed_requests==10 and (.points[1].failures|any(test("success")))
  and .points[2].concurrency==32 and .points[2].output_tokens_per_s==null and .points[2].pass==false
  and (.points[2].failures|any(test("no result")))' \
  fixtures/sweep-partial.log --target r1
# A sweep that stopped early fails: every expected point (params.concurrency) is reported, the
# missing ones with null figures; a log without the end marker is incomplete even if every point is there.
check truncated-fails '.status=="fail" and .sweep_complete==false and ([.points[].concurrency]==[1,8,32])
  and .points[2].pass==false and .points[2].output_tokens_per_s==null and (.points[2].failures|any(test("not in the log")))
  and .points[0].pass==true and .max_passing_concurrency==8' \
  fixtures/sweep-truncated.log --target r1
check no-end-fails '.status=="fail" and .sweep_complete==false and ([.points[]|.pass]|all)' fixtures/sweep-no-end.log --target r1
check complete-pass '.sweep_complete==true' fixtures/sweep-pass.log --target r1
# An empty log is a failed run with no points, never a pass.
check empty-fails '.status=="fail" and (.points|length)==0' /dev/null --target r1

# Placement (R1) is carried through as given by 05-load.sh.
check placement '.placement.bench_on_gpu_node==false and .placement.cpu_node_available==true' \
  fixtures/sweep-pass.log --target r1 --placement '{"bench_on_gpu_node":false,"cpu_node_available":true}'

echo "load harness self-test passed"
