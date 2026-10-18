#!/usr/bin/env bash
# Run 1: Token Factory bench (R11). Plan section "Run 1 - Token Factory bench (R11)".
# Executed (not sourced): bash scripts/live/run1.sh. No cloud resource is created; no bootstrap (the
# key is read from .env by name). Optional: R11_MODEL=<id>, BENCH_USD_PER_1M_OUTPUT=<listed rate>.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run1
# Model: tests/load/bench.sh owns the R11 default (TF_MODEL), so it is never repeated here; R11_MODEL
# overrides it for this run. vllm bench serve loads the tokenizer from Hugging Face by the model id,
# so the model must be one whose Token Factory id is a public, ungated Hugging Face repo: on
# 2026-10-12 a serving name that is not one failed before any request. The header names the model
# that will be used; if bench.sh's default is not such a repo, pass R11_MODEL.
unset BENCH_MODEL
model_args=()
if [[ -n "${R11_MODEL:-}" ]]; then model_args=(--model "${R11_MODEL}"); MODEL_SHOWN="${R11_MODEL} (R11_MODEL)"
else MODEL_SHOWN="$(sed -n 's/^TF_MODEL="\(.*\)"$/\1/p' tests/load/bench.sh | head -1) (tests/load/bench.sh default)"; fi
header "Run 1 - Token Factory bench (R11)" \
  "dry call of tests/load/bench.sh --target r11 (refuses, prints request/token count), then the paid CONFIRM=yes sweep: 611 requests to ${MODEL_SHOWN}" \
  "per token at the model's listed rate (GET /v1/models?verbose=true), billed to the Token Factory account; about \$0.04 for the 2026-10-12 sweep" \
  "about 10-20 min (vLLM image pull on first use, then the 1/8/32 sweep)" \
  "the RESULT block at the end (results/bench-r11.json summary, VERDICT line)"
need docker jq
need_tty
check_repo
docker info >/dev/null 2>&1 || die "Docker is not running (open -a Docker); the bench runs the pinned vLLM image"

# The key comes from .env (NEBIUS_API_KEY, where the owner keeps it; read by name with env_get, as
# bash parses .env), else a silent prompt. Never printed, never on argv.
unset BENCH_API_KEY NEBIUS_API_KEY
NEBIUS_API_KEY="$(env_get NEBIUS_API_KEY)"
if [[ -n "${NEBIUS_API_KEY}" ]]; then say "Token Factory key: read from .env (NEBIUS_API_KEY)"
else read -rs -p "Paste the Token Factory API key (input hidden): " NEBIUS_API_KEY; echo; fi
[[ -n "${NEBIUS_API_KEY}" ]] || die "no key entered"
export NEBIUS_API_KEY
if [[ -n "${BENCH_USD_PER_1M_OUTPUT:-}" ]]; then
  export BENCH_USD_PER_1M_OUTPUT
  say "BENCH_USD_PER_1M_OUTPUT=${BENCH_USD_PER_1M_OUTPUT} (cost per 1M output tokens recorded)"
else
  say "BENCH_USD_PER_1M_OUTPUT unset: the cost per 1M output tokens stays 'per-token' (pass the model's listed output rate to record it)"
fi

say ">>> tests/load/bench.sh --target r11   (no CONFIRM: must refuse)"
rc=0; tests/load/bench.sh --target r11 "${model_args[@]+"${model_args[@]}"}" || rc=$?
(( rc != 0 )) || die "bench.sh ran without CONFIRM=yes; expected a refusal"
say "(refused as expected, exit ${rc})"

confirm "Send the paid R11 sweep to ${MODEL_SHOWN} now?"
FAIL_HINT="no resource exists; results/bench-r11.json and results/bench-r11.log hold what ran"
say ">>> CONFIRM=yes tests/load/bench.sh --target r11 ${model_args[*]+${model_args[*]}}"
rc=0; CONFIRM=yes tests/load/bench.sh --target r11 "${model_args[@]+"${model_args[@]}"}" || rc=$?
unset NEBIUS_API_KEY

result_begin
say "bench.sh exit: ${rc}"
if (( rc == 0 )); then say "VERDICT: PASS"
else say "VERDICT: FAIL (see results/bench-r11.log; generator_exit_code 125 means Docker could not start the container)"; fi
if [[ -f results/bench-r11.json ]]; then
  bench_summary results/bench-r11.json
  jq -c '{timestamp, model: .details.model, base_url: .details.base_url, vantage: .details.vantage, params: .details.params}' results/bench-r11.json 2>/dev/null || true
else
  say "results/bench-r11.json missing"
fi
say "files: results/bench-r11.json results/bench-r11.log  (evidence: docs/evidence/<date>-token-factory-bench.md)"
say "log: ${LOG}"
exit "${rc}"
