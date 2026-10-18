#!/usr/bin/env bash
# tests/load/bench.sh (R10 GPU VM, R11 Token Factory, R6 from the operator host) against a stub
# docker: the same sweep.sh and bench.py as R1, so the result has the same JSON shape; the key
# reaches the container by name only; R11 spends nothing without CONFIRM=yes; R10 refuses
# without a key and names the recipe's SSH command for it. R11 defaults to a model whose id is a
# public Hugging Face repo, takes --model / BENCH_MODEL and --tokenizer / BENCH_TOKENIZER, and checks
# the tokenizer repo on Hugging Face (curl stub) before the paid run: a Token Factory serving name
# that is not a repo made vllm bench serve fail before any request (2026-10-12).
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
bench="${repo_root}/tests/load/bench.sh"
export RESULTS_DIR="${work}/results" FIXTURE="${repo_root}/tests/load/fixtures/sweep-pass.log"
unset BAR_MAX_TTFT_P99_MS BAR_MAX_TPOT_P99_MS BAR_MAX_E2E_P99_MS BAR_MIN_OUTPUT_TPS BAR_MIN_SUCCESS_RATIO \
  BENCH_USD_PER_HOUR BENCH_UTILISATION BENCH_USD_PER_1M_OUTPUT BENCH_API_KEY NEBIUS_API_KEY CONFIRM \
  BENCH_MODEL BENCH_TOKENIZER BENCH_HF_CHECK
sentinel="bench-key-sentinel-0000"
# The container's view: the key and the sweep inputs arrive as environment variables.
stub docker 'echo "ENV OPENAI_API_KEY=${OPENAI_API_KEY:-unset} BASE_URL=${BASE_URL:-unset} MODEL=${MODEL:-unset} CONCURRENCY=${CONCURRENCY:-unset} TOKENIZER=${TOKENIZER:-unset}" >> "$LOG"; cat "$FIXTURE"'
# Hugging Face model API as seen anonymously: a serving name that is no repo (401, as on 2026-10-12),
# a gated repo (metadata public, files not), an unreachable network, and public repos.
stub curl 'case "$*" in
  *huggingface.co/api/models/nvidia/Nemotron-3_5-Lightning*) printf "%s\n401" "{\"error\":\"Repository Not Found\"}" ;;
  *huggingface.co/api/models/gated/model*) printf "%s\n200" "{\"id\":\"gated/model\",\"gated\":\"manual\"}" ;;
  *huggingface.co/api/models/down/model*) echo "curl: (6) Could not resolve host: huggingface.co" >&2; exit 6 ;;
  *huggingface.co/api/models/*) printf "%s\n200" "{\"id\":\"public\",\"gated\":false}" ;;
  *) exit 7 ;;
esac'

test_name="bench-r1-host-fallback-keeps-recipe-and-vantage"
set +e
"${bench}" --target r1 --base-url http://127.0.0.1:8000 --model Qwen/Qwen2.5-1.5B-Instruct --vantage operator-host-port-forward >/dev/null 2>"${work}/err"; rc=$?
set -e
[[ "$rc" == 0 ]] || fail "R1 host fallback must work without an API key (got $rc): $(cat "${work}/err")"
jq -e '.details.target == "r1" and .details.vantage == "operator-host-port-forward" and .status == "pass"' "${RESULTS_DIR}/bench-r1.json" >/dev/null || fail "R1 fallback must retain its recipe and distinct host vantage"
ok "R1 fallback does not masquerade as a different recipe or an in-cluster result"
: > "${LOG}"

test_name="bench-r11-needs-confirm"
set +e; NEBIUS_API_KEY="${sentinel}" "${bench}" --target r11 --model some/model >/dev/null 2>"${work}/err"; rc=$?; set -e
[[ "${rc}" -eq 2 ]] || fail "R11 without CONFIRM=yes must exit 2 (got ${rc})"
grep -q '^docker' "${LOG}" && fail "R11 without CONFIRM=yes reached docker"
{ grep -q 'CONFIRM=yes' "${work}/err" && grep -qE '[0-9]+ requests' "${work}/err"; } || fail "the refusal must give the request count and CONFIRM=yes: $(cat "${work}/err")"
grep -qF "${sentinel}" "${work}/err" && fail "the refusal printed the key"
grep -q '^curl' "${LOG}" && fail "the CONFIRM refusal must stay offline (it called curl)"
ok "no Token Factory spend without CONFIRM=yes"

test_name="bench-r11-same-shape-key-by-name"
: > "${LOG}"
CONFIRM=yes NEBIUS_API_KEY="${sentinel}" "${bench}" --target r11 --model some/model >/dev/null 2>"${work}/err" || fail "R11 bench failed: $(cat "${work}/err")"
grep '^docker ' "${LOG}" | grep -qF "${sentinel}" && fail "the key appeared in docker's argv"
grep '^docker ' "${LOG}" | grep -q -- '-e OPENAI_API_KEY ' || fail "docker must take OPENAI_API_KEY by name"
grep -q "ENV OPENAI_API_KEY=${sentinel} BASE_URL=https://api.tokenfactory.nebius.com " "${LOG}" || fail "the key and the Token Factory base URL must reach the container: $(grep ENV "${LOG}")"
grep '^docker ' "${LOG}" | grep -q 'vllm/vllm-openai:v0.31.0@sha256:' || fail "docker must run the pinned vLLM image"
grep '^docker ' "${LOG}" | grep -q 'tests/load/sweep.sh:/bench/sweep.sh:ro' || fail "docker must run tests/load/sweep.sh"
r="${RESULTS_DIR}/bench-r11.json"
jq -e '.step=="bench-r11" and .status=="pass" and .details.schema=="nip-bench/1" and .details.target=="r11"
  and .details.vantage=="operator-host" and ([.details.points[].concurrency]==[1,8,32]) and .details.cost.model=="per-token" and (.details.cost.note|test("BENCH_USD_PER_1M_OUTPUT"))' "${r}" >/dev/null \
  || fail "bench-r11.json: $(cat "${r}")"
grep -qF "${sentinel}" "${r}" && fail "the key reached the result file"
ok "R11 result has the R1 shape; key passed by environment"

test_name="bench-r11-default-model-is-a-public-repo"
: > "${LOG}"
CONFIRM=yes NEBIUS_API_KEY="${sentinel}" "${bench}" --target r11 >/dev/null 2>"${work}/err" || fail "R11 bench failed: $(cat "${work}/err")"
grep -q "ENV .* MODEL=Qwen/Qwen3-30B-A3B-Instruct-2507 .*TOKENIZER=unset" "${LOG}" || fail "the R11 default model must be Qwen/Qwen3-30B-A3B-Instruct-2507, no tokenizer override: $(grep ENV "${LOG}")"
grep -q '^curl .*https://huggingface.co/api/models/Qwen/Qwen3-30B-A3B-Instruct-2507' "${LOG}" || fail "the tokenizer repo must be checked on Hugging Face first"
grep '^curl ' "${LOG}" | grep -qF "${sentinel}" && fail "the Token Factory key reached the Hugging Face check"
ok "R11 defaults to Qwen/Qwen3-30B-A3B-Instruct-2507 and checks it on Hugging Face"

test_name="bench-r11-model-input"
: > "${LOG}"
CONFIRM=yes NEBIUS_API_KEY="${sentinel}" BENCH_MODEL=openai/gpt-oss-120b "${bench}" --target r11 >/dev/null 2>"${work}/err" || fail "R11 bench failed: $(cat "${work}/err")"
grep -q "ENV .* MODEL=openai/gpt-oss-120b " "${LOG}" || fail "BENCH_MODEL must set the model: $(grep ENV "${LOG}")"
: > "${LOG}"
CONFIRM=yes NEBIUS_API_KEY="${sentinel}" BENCH_MODEL=openai/gpt-oss-120b "${bench}" --target r11 --model some/model >/dev/null 2>"${work}/err" || fail "R11 bench failed: $(cat "${work}/err")"
grep -q "ENV .* MODEL=some/model " "${LOG}" || fail "--model must win over BENCH_MODEL: $(grep ENV "${LOG}")"
ok "BENCH_MODEL sets the R11 model; --model overrides it"

test_name="bench-r11-refuses-a-model-without-a-public-repo"
: > "${LOG}"
set +e; CONFIRM=yes NEBIUS_API_KEY="${sentinel}" "${bench}" --target r11 --model nvidia/Nemotron-3_5-Lightning >/dev/null 2>"${work}/err"; rc=$?; set -e
[[ "${rc}" -eq 2 ]] || fail "a tokenizer repo that does not resolve must exit 2 (got ${rc})"
grep -q '^docker' "${LOG}" && fail "the refused run reached docker"
{ grep -q 'nvidia/Nemotron-3_5-Lightning' "${work}/err" && grep -q '401' "${work}/err" && grep -q -- '--tokenizer' "${work}/err" \
  && grep -q 'BENCH_TOKENIZER' "${work}/err"; } || fail "the refusal must name the id, the HTTP status and --tokenizer / BENCH_TOKENIZER: $(cat "${work}/err")"
ok "a Token Factory serving name with no public Hugging Face repo is refused before any spend"

test_name="bench-r11-refuses-gated-and-unreachable"
for m in gated/model down/model 'not a repo'; do
  : > "${LOG}"
  set +e; CONFIRM=yes NEBIUS_API_KEY="${sentinel}" "${bench}" --target r11 --model "${m}" >/dev/null 2>"${work}/err"; rc=$?; set -e
  [[ "${rc}" -eq 2 ]] || fail "${m}: must exit 2 (got ${rc})"
  grep -q '^docker' "${LOG}" && fail "${m}: the refused run reached docker"
  grep -qF "${m}" "${work}/err" || fail "${m}: the refusal must name the id: $(cat "${work}/err")"
done
: > "${LOG}"
set +e; CONFIRM=yes NEBIUS_API_KEY="${sentinel}" "${bench}" --target r11 --model down/model >/dev/null 2>"${work}/err"; set -e
grep -q 'BENCH_HF_CHECK=0' "${work}/err" || fail "an unreachable Hugging Face must say how to skip the check: $(cat "${work}/err")"
set +e; CONFIRM=yes NEBIUS_API_KEY="${sentinel}" "${bench}" --target r11 --model gated/model >/dev/null 2>"${work}/err"; set -e
grep -qi 'gated' "${work}/err" || fail "a gated repo must be called gated: $(cat "${work}/err")"
ok "gated, unreachable and malformed tokenizer ids are refused before any spend"

test_name="bench-r11-tokenizer-override"
: > "${LOG}"
CONFIRM=yes NEBIUS_API_KEY="${sentinel}" "${bench}" --target r11 --model nvidia/Nemotron-3_5-Lightning \
  --tokenizer Qwen/Qwen3-30B-A3B-Instruct-2507 >/dev/null 2>"${work}/err" || fail "R11 with --tokenizer failed: $(cat "${work}/err")"
grep -q "ENV .* MODEL=nvidia/Nemotron-3_5-Lightning .*TOKENIZER=Qwen/Qwen3-30B-A3B-Instruct-2507" "${LOG}" || fail "model and tokenizer must reach the container: $(grep ENV "${LOG}")"
grep '^docker ' "${LOG}" | grep -q -- '-e TOKENIZER ' || fail "docker must take TOKENIZER by name"
grep -q '^curl .*api/models/nvidia/Nemotron-3_5-Lightning' "${LOG}" && fail "with --tokenizer, the tokenizer is checked, not the serving name"
grep -q '^curl .*api/models/Qwen/Qwen3-30B-A3B-Instruct-2507' "${LOG}" || fail "the named tokenizer must be checked"
grep -qi 'approximate' "${work}/err" || fail "a tokenizer override must warn that token counts are approximate: $(cat "${work}/err")"
: > "${LOG}"
CONFIRM=yes NEBIUS_API_KEY="${sentinel}" BENCH_TOKENIZER=openai/gpt-oss-120b "${bench}" --target r11 --model nvidia/Nemotron-3_5-Lightning \
  >/dev/null 2>"${work}/err" || fail "R11 with BENCH_TOKENIZER failed: $(cat "${work}/err")"
grep -q "ENV .*TOKENIZER=openai/gpt-oss-120b" "${LOG}" || fail "BENCH_TOKENIZER must reach the container: $(grep ENV "${LOG}")"
ok "--tokenizer / BENCH_TOKENIZER bench a serving name with a named tokenizer, checked first"

test_name="bench-r11-check-skippable-offline"
: > "${LOG}"
CONFIRM=yes NEBIUS_API_KEY="${sentinel}" BENCH_HF_CHECK=0 "${bench}" --target r11 --model nvidia/Nemotron-3_5-Lightning >/dev/null 2>"${work}/err" \
  || fail "BENCH_HF_CHECK=0 must skip the check: $(cat "${work}/err")"
grep -q '^curl' "${LOG}" && fail "BENCH_HF_CHECK=0 must not call curl"
grep -q '^docker' "${LOG}" || fail "BENCH_HF_CHECK=0 must still run the bench"
ok "BENCH_HF_CHECK=0 skips the Hugging Face check"

test_name="sweep-passes-tokenizer"
stub vllm 'exit 0'
: > "${LOG}"
BASE_URL=http://x MODEL=vendor/served CONCURRENCY=1 TOKENIZER=Qwen/Qwen3-30B-A3B-Instruct-2507 sh "${repo_root}/tests/load/sweep.sh" > "${work}/sweep.out"
[[ "$(grep -c '^vllm ' "${LOG}")" -eq 3 ]] || fail "three vllm bench serve calls expected (first, warm-up, one point)"
grep '^vllm ' "${LOG}" | grep -v -q -- '--tokenizer Qwen/Qwen3-30B-A3B-Instruct-2507' && fail "every vllm call must carry --tokenizer"
grep -q 'params .* model=vendor/served tokenizer=Qwen/Qwen3-30B-A3B-Instruct-2507 ' "${work}/sweep.out" || fail "the params line must record the tokenizer: $(head -1 "${work}/sweep.out")"
: > "${LOG}"
BASE_URL=http://x MODEL=vendor/served CONCURRENCY=1 sh "${repo_root}/tests/load/sweep.sh" > "${work}/sweep.out"
grep -q -- '--tokenizer' "${LOG}" && fail "no TOKENIZER, no --tokenizer"
grep -q 'tokenizer=' "${work}/sweep.out" && fail "no TOKENIZER, no tokenizer= in the params line"
ok "sweep.sh passes TOKENIZER as --tokenizer and records it"

test_name="bench-r10-needs-key"
: > "${LOG}"
set +e; "${bench}" --target r10 --base-url http://127.0.0.1:8000 --model Qwen/Qwen2.5-1.5B-Instruct >/dev/null 2>"${work}/err"; rc=$?; set -e
[[ "${rc}" -eq 2 ]] || fail "R10 without BENCH_API_KEY must exit 2 (got ${rc})"
grep -q 'how_to_reach' "${work}/err" || fail "the refusal must point at the recipe's key command (how_to_reach.api_key): $(cat "${work}/err")"
ok "R10 refuses without a key and says how to get it"

test_name="bench-r10-runs-with-key"
: > "${LOG}"
BENCH_API_KEY="${sentinel}" BENCH_CONCURRENCY="1 4" BENCH_USD_PER_HOUR=1.5 "${bench}" --target r10 --base-url http://127.0.0.1:8000 \
  --model Qwen/Qwen2.5-1.5B-Instruct --vantage in-vpc --server-startup-s 480 >/dev/null 2>"${work}/err" || fail "R10 bench failed: $(cat "${work}/err")"
grep -q "BASE_URL=http://127.0.0.1:8000 MODEL=Qwen/Qwen2.5-1.5B-Instruct CONCURRENCY=1 4" "${LOG}" || fail "inputs must reach the container: $(grep ENV "${LOG}")"
jq -e '.details.target=="r10" and .details.vantage=="in-vpc" and .details.cold_start.server_startup_s==480
  and .details.cost.usd_per_hour==1.5 and .details.points[0].cost_per_1m_output_tokens_usd!=null' "${RESULTS_DIR}/bench-r10.json" >/dev/null \
  || fail "bench-r10.json: $(cat "${RESULTS_DIR}/bench-r10.json")"
ok "R10 result carries vantage, start-up and cost"

test_name="bench-refuses-bad-target"
set +e; "${bench}" --target r99 --model m >/dev/null 2>&1; rc=$?; set -e
[[ "${rc}" -eq 2 ]] || fail "an unknown target must exit 2 (got ${rc})"
ok "unknown target refused"

test_name="bench-generator-exit-fails"
: > "${LOG}"
stub docker 'cat "$FIXTURE"; exit 137'
set +e; BENCH_API_KEY="${sentinel}" "${bench}" --target r10 --base-url http://127.0.0.1:8000 --model m >/dev/null 2>&1; rc=$?; set -e
grep -q '^curl' "${LOG}" && fail "R10 serves its model from Hugging Face already; no tokenizer check"
[[ "${rc}" -ne 0 ]] || fail "a generator that exited non-zero must fail the run"
jq -e '.status=="fail" and .details.generator_exit_code==137' "${RESULTS_DIR}/bench-r10.json" >/dev/null || fail "bench-r10.json: $(cat "${RESULTS_DIR}/bench-r10.json")"
ok "a killed generator fails the run and its exit code is recorded"
