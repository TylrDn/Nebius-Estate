# shellcheck shell=bash
# Run tests/load/sweep.sh as a Kubernetes Job (tests/load/bench-job.yaml) and collect its log.
# Sourced by tests/validate/05-load.sh (R1, namespace inference) and recipes/serverless/endpoint.sh
# (R6 measured from inside the R1 cluster). Needs kubectl and jq; the caller sets `set -euo pipefail`.
# Sweep shape (defaults in tests/load/README.md): BENCH_CONCURRENCY, BENCH_NUM_PROMPTS,
# BENCH_INPUT_LEN, BENCH_OUTPUT_LEN, BENCH_WARMUP_PROMPTS. Wait: BENCH_POLL_TRIES x BENCH_POLL_INTERVAL.
BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_CONCURRENCY="${BENCH_CONCURRENCY:-1 8 32}"
BENCH_NUM_PROMPTS="${BENCH_NUM_PROMPTS:-200}"
BENCH_INPUT_LEN="${BENCH_INPUT_LEN:-256}"
BENCH_OUTPUT_LEN="${BENCH_OUTPUT_LEN:-128}"
BENCH_WARMUP_PROMPTS="${BENCH_WARMUP_PROMPTS:-10}"

# bench_safe <name> <value>: values are pasted into YAML by sed; refuse anything that could break it.
bench_safe() {
  [[ "$2" =~ ^[A-Za-z0-9._:/@+=,\ -]+$ ]] || { echo "${1}='${2}' has characters the bench Job cannot carry (allowed: A-Z a-z 0-9 . _ : / @ + = , space -)" >&2; return 2; }
}

# bench_check: the sweep shape must be positive integers (BENCH_CONCURRENCY: one or more,
# space-separated). Returns 2 with a message naming the input otherwise; callers check it before
# touching kubectl or Docker, so a shape that cannot run costs nothing and overwrites no evidence.
bench_check() {
  local v
  for v in BENCH_NUM_PROMPTS BENCH_INPUT_LEN BENCH_OUTPUT_LEN BENCH_WARMUP_PROMPTS; do
    [[ "${!v}" =~ ^[1-9][0-9]*$ ]] || { echo "${v} must be a positive integer (got '${!v}')" >&2; return 2; }
  done
  [[ "$BENCH_CONCURRENCY" =~ ^[1-9][0-9]*( +[1-9][0-9]*)*$ ]] \
    || { echo "BENCH_CONCURRENCY must be positive integers separated by spaces (got '${BENCH_CONCURRENCY}')" >&2; return 2; }
}

# bench_cpu_nodes: how many nodes lack the GPU label (nip.nebius.io/gpu=true, stacks/inference).
bench_cpu_nodes() {
  kubectl get nodes -o json | jq '[.items[] | select(.metadata.labels["nip.nebius.io/gpu"] != "true")] | length'
}

# bench_render <namespace> <base_url> <model> <off_gpu true|false>: the Job manifest on stdout.
bench_render() {
  local ns="$1" url="$2" model="$3" off="$4" drop=()
  bench_check || return 2
  bench_safe namespace "$ns" && bench_safe base_url "$url" && bench_safe model "$model" || return 2
  # No node without the GPU label: a required affinity would never schedule, so the block goes.
  [[ "$off" == true ]] || drop=(-e '/# >>> off-gpu/,/# <<< off-gpu/d')
  sed -e "s|__NAMESPACE__|${ns}|" -e "s|__BASE_URL__|${url}|" -e "s|__MODEL__|${model}|" \
      -e "s|__CONCURRENCY__|${BENCH_CONCURRENCY}|" -e "s|__NUM_PROMPTS__|${BENCH_NUM_PROMPTS}|" \
      -e "s|__INPUT_LEN__|${BENCH_INPUT_LEN}|" -e "s|__OUTPUT_LEN__|${BENCH_OUTPUT_LEN}|" \
      -e "s|__WARMUP_PROMPTS__|${BENCH_WARMUP_PROMPTS}|" ${drop[@]+"${drop[@]}"} "${BENCH_DIR}/bench-job.yaml"
}

# bench_start <namespace> <base_url> <model> <off_gpu>: (re)create the sweep ConfigMap and the Job.
bench_start() {
  local ns="$1" manifest
  manifest="$(bench_render "$@")" || return 2
  kubectl -n "$ns" delete job vllm-bench --ignore-not-found >/dev/null
  kubectl -n "$ns" create configmap vllm-bench-sweep --from-file=sweep.sh="${BENCH_DIR}/sweep.sh" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  printf '%s\n' "$manifest" | kubectl apply -f - >/dev/null
}

# bench_state <namespace>: Complete | Failed | Running.
bench_state() {
  kubectl -n "$1" get job vllm-bench -o json | jq -r '[.status.conditions[]? | select(.status=="True") | .type] | first // "Running"'
}

# bench_wait <namespace> [hook]: poll until the Job ends; the hook runs on every poll. The state
# (Complete | Failed | Running) is left in BENCH_STATE, not printed: call it directly, never in
# $(...), so the hook runs in the caller's shell and what it collects (05-load's DCGM samples) stays.
bench_wait() {
  local ns="$1" hook="${2:-}"
  BENCH_STATE=Running
  for _ in $(seq 1 "${BENCH_POLL_TRIES:-240}"); do
    [[ -n "$hook" ]] && "$hook"
    BENCH_STATE="$(bench_state "$ns")"
    [[ "$BENCH_STATE" == Complete || "$BENCH_STATE" == Failed ]] && break
    sleep "${BENCH_POLL_INTERVAL:-15}"
  done
  return 0
}

# bench_region: the cluster's region from the nodes' topology.kubernetes.io/region label (one value
# when every labelled node agrees; empty when unlabelled or mixed). Recorded so compare.py can tell
# an in-region comparison from one across regions.
bench_region() {
  kubectl get nodes -o json 2>/dev/null \
    | jq -r '[.items[].metadata.labels["topology.kubernetes.io/region"] // empty] | unique | if length==1 then .[0] else "" end' 2>/dev/null || true
}

# bench_node <namespace>: the node the bench pod ran on.
bench_node() {
  kubectl -n "$1" get pod -l job-name=vllm-bench -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null || true
}
