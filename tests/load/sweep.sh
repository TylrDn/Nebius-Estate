#!/bin/sh
# Concurrency sweep with `vllm bench serve`, one generator for every target (R1 Job, R6, R10, R11).
# Runs inside the pinned vLLM image (POSIX sh: the image's /bin/sh), or anywhere `vllm` is on PATH.
# Prints `=== nip-bench` markers around each phase for tests/load/bench.py:
#   first   one request before the warm-up, reported as first_sweep_request_ms. It is NOT a cold
#           request: the caller's own probe (R1 04-workload, R6 measure) and vllm bench serve's
#           test request come before it. The cold figure comes from the caller (bench.py).
#   warmup  WARMUP_PROMPTS at concurrency 8, discarded
#   point   NUM_PROMPTS closed-loop (request rate inf) at each CONCURRENCY value
# A failed phase prints an `error` marker and the sweep goes on, so one bad point never hides the
# others. Inputs (environment; defaults in tests/load/README.md):
#   BASE_URL (required), MODEL (required), ENDPOINT=/v1/chat/completions, BACKEND=openai-chat,
#   CONCURRENCY="1 8 32", NUM_PROMPTS=200, INPUT_LEN=256, OUTPUT_LEN=128, WARMUP_PROMPTS=10,
#   TOKENIZER (optional: a Hugging Face repo used in place of MODEL's tokenizer; counts then approximate).
# The API key, when the server needs one, is OPENAI_API_KEY in the environment (read by vllm bench
# serve's OpenAI backends); it is never an argument.
set -u
: "${BASE_URL:?BASE_URL is required}" "${MODEL:?MODEL is required}"
ENDPOINT="${ENDPOINT:-/v1/chat/completions}"
BACKEND="${BACKEND:-openai-chat}"
CONCURRENCY="${CONCURRENCY:-1 8 32}"
NUM_PROMPTS="${NUM_PROMPTS:-200}"
INPUT_LEN="${INPUT_LEN:-256}"
OUTPUT_LEN="${OUTPUT_LEN:-128}"
WARMUP_PROMPTS="${WARMUP_PROMPTS:-10}"

bench() { # <prompts> <concurrency> [extra args]
  n="$1"; c="$2"; shift 2
  if [ -n "${TOKENIZER:-}" ]; then set -- "$@" --tokenizer "$TOKENIZER"; fi
  vllm bench serve --backend "$BACKEND" --base-url "$BASE_URL" --endpoint "$ENDPOINT" --model "$MODEL" \
    --dataset-name random --random-input-len "$INPUT_LEN" --random-output-len "$OUTPUT_LEN" \
    --num-prompts "$n" --request-rate inf --max-concurrency "$c" \
    --percentile-metrics ttft,tpot,itl,e2el --metric-percentiles 50,99 "$@" 2>&1
}
phase() { # <name> <prompts> <concurrency>
  echo "=== nip-bench $1 concurrency=$3 prompts=$2"
  if [ "$1" = warmup ]; then bench "$2" "$3" >/dev/null; else bench "$2" "$3"; fi
  rc=$?
  [ "$rc" -eq 0 ] || echo "=== nip-bench error phase=$1 concurrency=$3 rc=$rc"
}

echo "=== nip-bench params base_url=$BASE_URL endpoint=$ENDPOINT model=$MODEL${TOKENIZER:+ tokenizer=$TOKENIZER} input_len=$INPUT_LEN output_len=$OUTPUT_LEN num_prompts=$NUM_PROMPTS warmup_prompts=$WARMUP_PROMPTS concurrency=$(echo "$CONCURRENCY" | tr ' ' ',')"
phase first 1 1
phase warmup "$WARMUP_PROMPTS" 8
for c in $CONCURRENCY; do phase point "$NUM_PROMPTS" "$c"; done
echo "=== nip-bench end"
