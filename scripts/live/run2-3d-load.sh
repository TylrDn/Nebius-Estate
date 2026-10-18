#!/usr/bin/env bash
# Run 2 step 3 (part d): headroom check, BENCH_USD_PER_HOUR=<step 1> tests/validate/05-load.sh with
# the plan's Pending rule (a bench pod Pending about 2 min with Insufficient cpu/memory is stopped
# and the Job deleted), then results/summary.json with run-all.sh's jq expression; it must print true.
# Executed: bash run2-3d-load.sh   Optional: bash run2-watch-bench.sh in a second terminal.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-3d-load
header "Run 2 step 3d - 05-load (F3.1) and summary.json" \
  "the 1/8/32 sweep as a Job beside vLLM on the GPU node; then summary.json over the six step results" \
  "\$0 extra, but up to 60 min of L40S + MLflow/PostgreSQL time if the Job hangs (about \$1.40/h together)" \
  "about 15-30 min" "the RESULT block (05 points, summary check true/false)"
need kubectl jq python3
check_repo
load_env
state_load run2
kube_env
[[ "${F31_BLOCKED:-0}" != 1 ]] || die "F3.1 is recorded as blocked by node capacity: do not start 05-load again; continue with run2-4-r8-acceptance.sh"
USD="${BENCH_USD_PER_HOUR:-${BENCH_USD_PER_HOUR_STATE:-}}"
[[ -n "${USD}" ]] || die "no BENCH_USD_PER_HOUR: run run2-1-reprice.sh (or pass BENCH_USD_PER_HOUR=...)"
[[ "$(jq -r .status results/04-workload.json 2>/dev/null)" == pass ]] || die "results/04-workload.json is not a pass: run run2-3c-storage-workload.sh"
if [[ -n "${VLLM_LOWERED_AT:-}" ]]; then
  t04="$(nip_epoch "$(jq -r .timestamp results/04-workload.json)")"
  (( t04 > VLLM_LOWERED_AT )) || die "vLLM was re-rolled after the last 04-workload: ONLY_WORKLOAD=1 bash run2-3c-storage-workload.sh first"
fi
headroom || die "headroom short: bash run2-3b-headroom.sh first"

say ">>> BENCH_USD_PER_HOUR=${USD} tests/validate/05-load.sh   (Pending watch active)"
BENCH_USD_PER_HOUR="${USD}" tests/validate/05-load.sh &
pid=$!
bench_guard inference "${pid}"   # Ctrl-C or a failure: stop the bench and delete its Job
w=0; watch_bench inference "${pid}" || w=$?
rc=0; wait "${pid}" || rc=$?
bench_unguard
if (( w == 3 )); then
  if [[ "${VLLM_LOWERED:-0}" == 1 ]]; then
    state_set run2 F31_BLOCKED 1
    die "bench Pending for capacity with vLLM already at cpu=3/memory=16Gi: F3.1 BLOCKED by node capacity (record it); continue with run2-4-r8-acceptance.sh"
  fi
  die "bench Pending for capacity: bash run2-3b-headroom.sh; if it lowered vLLM: ONLY_WORKLOAD=1 bash run2-3c-storage-workload.sh (note: model cache warm); then rerun this step"
fi

npoints="$(jq '[.details.points[]?] | length' results/05-load.json 2>/dev/null || echo 0)"
if (( npoints == 0 )); then
  say "05-load has no points: did the pod ever run?"
  kubectl -n inference get pod -l job-name=vllm-bench || true
  kubectl -n inference logs job/vllm-bench 2>/dev/null | tail -40 || true
  say "a Hugging Face Hub error points at allow-bench-tokenizer-egress (c75b760, untested live)"
  die "05-load produced no points (exit ${rc})"
fi

# Step 3's summary.json: the same expression as tests/validate/run-all.sh.
jq -s '{
  generated: (now|todate),
  steps: (map({(.step): .status}) | add),
  versions: {
    kubelet: (map(select(.step=="00-nodes"))[0].details.nodes[0].kubelet // null),
    node_os: (map(select(.step=="00-nodes"))[0].details.nodes[0].os // null),
    nvidia_smi: (map(select(.step=="01-gpu"))[0].details.nvidia_smi // null),
    nccl_image: (map(select(.step=="02-interconnect"))[0].details.image // null),
    vllm_image: (map(select(.step=="04-workload"))[0].details.image // null),
    model: (map(select(.step=="04-workload"))[0].details.model // null)
  }
}' results/00-nodes.json results/01-gpu.json results/02-interconnect.json \
   results/03-storage.json results/04-workload.json results/05-load.json > results/summary.json
check="$(jq -e '[.steps[]] | length == 6 and all(. == "pass")' results/summary.json || true)"

result_begin
say "05-load exit ${rc}; BENCH_USD_PER_HOUR=${USD}"
bench_summary results/05-load.json
jq -c '.details.placement? // empty' results/05-load.json || true
jq -c '.steps' results/summary.json
say "summary check (must print true): ${check}"
say "F3.1 result file: results/05-load.json (step 8's compare.py reads it)"
if [[ "$(session_mode)" == r1-only ]]; then say "next: bash ${LIVE_DIR}/run2-6-r14-acceptance.sh (R1-only: no R8/R12 acceptance)"
else say "next: bash ${LIVE_DIR}/run2-4-r8-acceptance.sh"; fi
