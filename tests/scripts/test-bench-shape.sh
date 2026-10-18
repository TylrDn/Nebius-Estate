#!/usr/bin/env bash
# Bench shape as inputs (F6.1 on the F3.1 sweep): tests/load/lib-bench.sh renders
# tests/load/bench-job.yaml from BENCH_CONCURRENCY, BENCH_NUM_PROMPTS, BENCH_INPUT_LEN,
# BENCH_OUTPUT_LEN and BENCH_WARMUP_PROMPTS (defaults = the documented method, unchanged);
# bench_check refuses anything but positive integers with exit 2, and 05-load.sh and bench.sh
# refuse before kubectl or Docker is touched, keeping the earlier evidence.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
lb="${repo_root}/tests/load/lib-bench.sh"
unset BENCH_CONCURRENCY BENCH_NUM_PROMPTS BENCH_INPUT_LEN BENCH_OUTPUT_LEN BENCH_WARMUP_PROMPTS BENCH_API_KEY NEBIUS_API_KEY
render() { bash -c 'set -euo pipefail; source "$1"; bench_render inference http://vllm:8000 Qwen/Qwen2.5-1.5B-Instruct true' _ "${lb}"; }
val() { grep -A1 "name: $1\$" <<<"$2" | tail -1 | sed -E 's/.*value: "(.*)"/\1/'; }

test_name=bench-shape-defaults
out="$(render)"
[[ "$(val CONCURRENCY "${out}")" == "1 8 32" && "$(val NUM_PROMPTS "${out}")" == 200 && "$(val INPUT_LEN "${out}")" == 256 \
   && "$(val OUTPUT_LEN "${out}")" == 128 && "$(val WARMUP_PROMPTS "${out}")" == 10 ]] \
  || fail "defaults must stay 1 8 32 / 200 / 256 / 128 / 10: $(grep -A1 'name: [A-Z_]*$' <<<"${out}")"
grep -q '__' <<<"${out}" && fail "a placeholder was left unfilled: $(grep '__' <<<"${out}")"
ok "defaults render the documented method"

test_name=bench-shape-inputs
out="$(BENCH_CONCURRENCY="4 16 64" BENCH_NUM_PROMPTS=400 BENCH_INPUT_LEN=2048 BENCH_OUTPUT_LEN=512 BENCH_WARMUP_PROMPTS=20 render)"
[[ "$(val CONCURRENCY "${out}")" == "4 16 64" && "$(val NUM_PROMPTS "${out}")" == 400 && "$(val INPUT_LEN "${out}")" == 2048 \
   && "$(val OUTPUT_LEN "${out}")" == 512 && "$(val WARMUP_PROMPTS "${out}")" == 20 ]] || fail "inputs not applied"
ok "every input applied"

test_name=bench-shape-refusals
for bad in BENCH_INPUT_LEN=2k BENCH_OUTPUT_LEN=0 BENCH_NUM_PROMPTS=-1 'BENCH_CONCURRENCY=8;x' 'BENCH_CONCURRENCY=1,8' \
           'BENCH_CONCURRENCY=0 8' BENCH_WARMUP_PROMPTS=1.5; do
  set +e; out="$(env "${bad}" bash -c 'set -euo pipefail; source "$1"; bench_render ns http://x m true' _ "${lb}" 2>"${work}/err")"; rc=$?; set -e
  [[ "${rc}" -eq 2 && -z "${out}" ]] || fail "${bad} must be refused with exit 2 and no output (rc ${rc})"
  grep -q "${bad%%=*}" "${work}/err" || fail "${bad}: the refusal names the input"
done
ok "anything but positive integers refused"

test_name=bench-shape-refused-by-05
export RESULTS_DIR="${work}/results"; mkdir -p "${RESULTS_DIR}"
echo '{"step":"05-load","status":"pass","details":{"earlier":true}}' > "${RESULTS_DIR}/05-load.json"
before="$(cat "${RESULTS_DIR}/05-load.json")"
stub kubectl 'exit 0'
: > "${LOG}"
set +e; BENCH_NUM_PROMPTS=abc bash "${repo_root}/tests/validate/05-load.sh" >/dev/null 2>"${work}/err"; rc=$?; set -e
[[ "${rc}" -eq 2 ]] || fail "an invalid BENCH_* input must make 05-load.sh exit 2 (got ${rc}): $(cat "${work}/err")"
grep -q BENCH_NUM_PROMPTS "${work}/err" || fail "the refusal names the input"
[[ "$(cat "${RESULTS_DIR}/05-load.json")" == "${before}" ]] || fail "a refused input must not overwrite 05-load.json"
grep -q '^kubectl' "${LOG}" && fail "05-load.sh touched kubectl before refusing: $(cat "${LOG}")"
ok "05-load.sh refuses a bad shape with exit 2, before kubectl, keeping earlier evidence"

test_name=bench-shape-refused-by-bench-sh
stub docker 'exit 0'
: > "${LOG}"
set +e; BENCH_API_KEY=k BENCH_CONCURRENCY='1 x' bash "${repo_root}/tests/load/bench.sh" --target r10 --base-url http://127.0.0.1:8000 --model m >/dev/null 2>"${work}/err"; rc=$?; set -e
[[ "${rc}" -eq 2 ]] || fail "an invalid BENCH_* input must make bench.sh exit 2 (got ${rc})"
grep -q BENCH_CONCURRENCY "${work}/err" || fail "the refusal names the input"
grep -q '^docker' "${LOG}" && fail "bench.sh ran Docker before refusing"
ok "bench.sh refuses a bad shape before Docker"
