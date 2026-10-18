#!/usr/bin/env bash
# The R1 load method (tests/load/sweep.sh + bench.py) against any OpenAI-compatible server, run in
# the pinned vLLM image under Docker from wherever this runs: R10 (GPU VM), R11 (Token Factory),
# R6 (serverless endpoint, from the operator host). Same sweep, bars and JSON shape as R1.
#   tests/load/bench.sh --target r10 --base-url http://127.0.0.1:8000 --model <repo> [--vantage in-vpc]
#   CONFIRM=yes tests/load/bench.sh --target r11 [--model <id>] [--tokenizer <hf repo>] [--base-url https://api.tokenfactory.nebius.com]
# Model and tokenizer: --model or BENCH_MODEL, --tokenizer or BENCH_TOKENIZER (the flag wins).
# vllm bench serve loads the tokenizer from Hugging Face by the model id (or --tokenizer). A Token
# Factory id is a serving name, not always a repo: R11 checks the tokenizer repo anonymously on
# Hugging Face before the paid run and refuses if it does not resolve or is gated (free; skip with
# BENCH_HF_CHECK=0). With --tokenizer the token counts are the named tokenizer's, so approximate.
# Key: BENCH_API_KEY (R11 falls back to NEBIUS_API_KEY in the environment; nothing reads .env). It
# reaches the container as OPENAI_API_KEY by name, never as an argument.
#   R10: the key is generated on the VM and only readable over SSH, by the recipe's own command:
#        export BENCH_API_KEY="$(eval "$(terraform -chdir=terraform/live/<stage>/gpu-vm output -json how_to_reach | jq -r .api_key)")"
#   R11: an API key from the Token Factory console. R11 bills per token, so it refuses without CONFIRM=yes.
# Sweep shape BENCH_*, bars BAR_*, cost BENCH_USD_PER_HOUR / BENCH_USD_PER_1M_OUTPUT: tests/load/README.md.
# Writes results/bench-<target>.json ({step,status,timestamp,details}) and the raw log next to it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${here}/../.." && pwd)"
RESULTS_DIR="${RESULTS_DIR:-${repo_root}/results}"
# Exact digest the R1 Deployment uses (workloads/inference/base/deployment.yaml, platform/versions.yaml).
IMAGE="${VLLM_IMAGE:-vllm/vllm-openai:v0.31.0@sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3}"
# R11 defaults: the public base URL (vllm bench serve adds /v1/chat/completions) and a served model
# whose id is also a public, ungated Hugging Face repo, so its own tokenizer loads (smoke.py's
# nvidia/Nemotron-3_5-Lightning is not one: 401 on 2026-10-12).
TF_BASE_URL="https://api.tokenfactory.nebius.com"
TF_MODEL="Qwen/Qwen3-30B-A3B-Instruct-2507"
HF_API="https://huggingface.co/api/models"
usage() { echo "usage: $0 --target r1|r6|r10|r11 [--base-url URL] [--model M] [--tokenizer T] [--vantage V] [--server-startup-s N] [--first-request-ms N --first-request-source S]" >&2; exit 2; }

target="" base_url="" model="${BENCH_MODEL:-}" tokenizer="${BENCH_TOKENIZER:-}" vantage="operator-host" startup=()
while (( $# )); do
  case "$1" in
    --target) target="${2:-}"; shift 2 ;;
    --base-url) base_url="${2:-}"; shift 2 ;;
    --model) model="${2:-}"; shift 2 ;;
    --tokenizer) tokenizer="${2:-}"; shift 2 ;;
    --vantage) vantage="${2:-}"; shift 2 ;;
    --server-startup-s) startup+=(--server-startup-s "${2:-}"); shift 2 ;;
    # The cold first request, from the caller's own probe (the sweep's first request is not cold).
    --first-request-ms) startup+=(--first-request-ms "${2:-}"); shift 2 ;;
    --first-request-source) startup+=(--first-request-source "${2:-}"); shift 2 ;;
    *) usage ;;
  esac
done
case "$target" in
  r11) base_url="${base_url:-$TF_BASE_URL}"; model="${model:-$TF_MODEL}"; BENCH_API_KEY="${BENCH_API_KEY:-${NEBIUS_API_KEY:-}}" ;;
  r1|r6|r10) [[ -n "$base_url" && -n "$model" ]] || usage ;;
  *) usage ;;
esac
# shellcheck source=tests/load/lib-bench.sh
source "${here}/lib-bench.sh"
bench_check || exit 2   # a shape that is not positive integers never reaches Docker or a paid endpoint
CONCURRENCY="${BENCH_CONCURRENCY:-1 8 32}"
NUM_PROMPTS="${BENCH_NUM_PROMPTS:-200}"
INPUT_LEN="${BENCH_INPUT_LEN:-256}"
OUTPUT_LEN="${BENCH_OUTPUT_LEN:-128}"
WARMUP_PROMPTS="${BENCH_WARMUP_PROMPTS:-10}"

if [[ "$target" == r1 ]]; then
  # A port-forward to the sandbox vLLM Service needs no API key. Preserve its real recipe/vantage.
  BENCH_API_KEY="${BENCH_API_KEY:-}"
elif [[ -z "${BENCH_API_KEY:-}" ]]; then
  case "$target" in
    r10) echo "Refusing: set BENCH_API_KEY. The R10 key is generated on the VM and read over SSH: terraform output how_to_reach (.api_key) prints the command (terraform/stacks/gpu-vm/README.md)" >&2 ;;
    r11) echo "Refusing: set BENCH_API_KEY or NEBIUS_API_KEY (a Token Factory API key) in the environment" >&2 ;;
    r6) echo "Refusing: set BENCH_API_KEY to the endpoint token (recipes/serverless/endpoint.sh measure does this)" >&2 ;;
  esac
  exit 2
fi
if [[ "$target" == r11 && "${CONFIRM:-}" != yes ]]; then
  points=0; for _ in $CONCURRENCY; do points=$((points + 1)); done
  requests=$(( 1 + WARMUP_PROMPTS + NUM_PROMPTS * points ))
  echo "Refusing: this sends ${requests} requests (about $(( requests * (INPUT_LEN + OUTPUT_LEN) )) tokens, ${OUTPUT_LEN} out each) to ${base_url} as ${model}, billed per token to the key's Token Factory account; set CONFIRM=yes" >&2
  exit 2
fi

# hf_check <repo id>: the tokenizer repo must resolve anonymously on Hugging Face and not be gated,
# since the container gets no Hugging Face token. Returns 2 with the reason otherwise.
hf_check() {
  local id="$1" out code gated hint
  hint="A Token Factory id is a serving name, not always a Hugging Face repo: pass --tokenizer <public repo> (or BENCH_TOKENIZER) with a compatible tokenizer (token counts then approximate), or --model (BENCH_MODEL) a served model whose id is a public repo (tests/load/README.md)"
  [[ "$id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || { echo "Refusing: tokenizer '${id}' is not a Hugging Face repo id (owner/name). ${hint}" >&2; return 2; }
  out="$(curl -sS --max-time 20 -w '\n%{http_code}' "${HF_API}/${id}" 2>&1)" \
    || { echo "Refusing: could not reach Hugging Face to check tokenizer '${id}' (${out##*$'\n'}); offline, BENCH_HF_CHECK=0 skips the check" >&2; return 2; }
  code="${out##*$'\n'}"
  [[ "$code" == 200 ]] || { echo "Refusing: tokenizer '${id}' does not resolve on Hugging Face (HTTP ${code} from ${HF_API}/${id}); vllm bench serve would fail before sending a request. ${hint}" >&2; return 2; }
  gated="$(jq -r '.gated // false' <<<"${out%$'\n'*}" 2>/dev/null || echo unreadable)"
  [[ "$gated" == false ]] || { echo "Refusing: tokenizer '${id}' is gated on Hugging Face (gated=${gated}); the bench container has no Hugging Face token. ${hint}" >&2; return 2; }
}
if [[ "$target" == r11 && "${BENCH_HF_CHECK:-1}" != 0 ]]; then
  hf_check "${tokenizer:-$model}" || exit 2
fi
if [[ -n "$tokenizer" ]]; then
  echo "Tokenizer ${tokenizer} stands in for ${model}'s: input and output token counts (and tokens/s) are approximate" >&2
fi

mkdir -p "$RESULTS_DIR"
log="${RESULTS_DIR}/bench-${target}.log"
export OPENAI_API_KEY="$BENCH_API_KEY" BASE_URL="$base_url" MODEL="$model" TOKENIZER="$tokenizer" CONCURRENCY NUM_PROMPTS INPUT_LEN OUTPUT_LEN WARMUP_PROMPTS
docker run --rm --network host --entrypoint /bin/sh \
  -e OPENAI_API_KEY -e BASE_URL -e MODEL -e TOKENIZER -e CONCURRENCY -e NUM_PROMPTS -e INPUT_LEN -e OUTPUT_LEN -e WARMUP_PROMPTS \
  -v "${here}/sweep.sh:/bench/sweep.sh:ro" "$IMAGE" /bench/sweep.sh > "$log" 2>&1 || rc=$?
# A container that died (OOM, a dropped tunnel) fails the run even if its log looks complete.
details="$(python3 "${here}/bench.py" parse "$log" --target "$target" --vantage "$vantage" --image "$IMAGE" ${startup[@]+"${startup[@]}"} \
  | jq --argjson rc "${rc:-0}" '. + {generator_exit_code:$rc} | if $rc != 0 then .status="fail" else . end')"
jq -n --arg step "bench-${target}" --arg ts "$(date -u +%FT%TZ)" --argjson d "$details" \
  '{step:$step,status:$d.status,timestamp:$ts,details:$d}' | tee "${RESULTS_DIR}/bench-${target}.json"
[[ "$(jq -r .status <<<"$details")" == pass ]]
