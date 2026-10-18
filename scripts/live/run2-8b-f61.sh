#!/usr/bin/env bash
# Run 2 step 8b (optional, after step 8's compare.py): F6.1 rerun on another model. Keeps step 3's
# results, renders MODEL/MODEL_REVISION, scales vLLM to 1, headroom check, a fresh 04-workload (else
# 05-load would carry the old pod's cold start), BENCH_NUM_PROMPTS=<n> 05-load (Pending rule), moves
# the F6.1 files aside, restores step 3's files and the qwen2.5-1.5b overlay.
# Executed: F61_MODEL=<org/name> F61_MODEL_REVISION=<sha> F61_NUM_PROMPTS=<n> bash run2-8b-f61.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-8b-f61
header "Run 2 step 8b - F6.1 (optional): bench another model" \
  "render.sh with F61_MODEL/F61_MODEL_REVISION, scale to 1, headroom, 04-workload, BENCH_NUM_PROMPTS 05-load, restore step-3 files and the qwen2.5-1.5b overlay" \
  "\$0 extra (R1 node); about 30-45 min more of the session (\$0.78/h R1 + \$0.65/h R12 + \$0.03/h R8)" "about 30-45 min" \
  "the RESULT block (F6.1 points, restored files)"
need kubectl jq python3
check_repo
load_env
state_load run2
kube_env
M="${F61_MODEL:-}"; REV="${F61_MODEL_REVISION:-}"; N="${F61_NUM_PROMPTS:-}"
[[ -n "${M}" && -n "${REV}" && "${N}" =~ ^[1-9][0-9]*$ ]] || die "set F61_MODEL=<org/name> F61_MODEL_REVISION=<commit> F61_NUM_PROMPTS=<n> (docs/rescoping.md)"
for f in 04-workload 05-load summary; do [[ -f "results/${f}.json" ]] || die "results/${f}.json missing: step 3 must have run"; done
say "NOTE: if step 8 (R6) runs at all, it must run BEFORE this step: compare.py reads step 3's results/05-load.json"

# Keep step 3's results (restored at the end, also on failure).
if [[ ! -f results/05-load.f3.1.json ]]; then
  run cp results/04-workload.json results/04-workload.f3.1.json
  run cp results/05-load.json results/05-load.f3.1.json
  run cp results/summary.json results/summary.f3.1.json
fi
restore() {
  [[ -f results/05-load.f3.1.json ]] || return 0
  mv results/04-workload.f3.1.json results/04-workload.json
  mv results/05-load.f3.1.json results/05-load.json
  mv results/summary.f3.1.json results/summary.json
  echo "step-3 results restored (04-workload, 05-load, summary)"
}
FAIL_HINT="step-3 files restored by the exit handler; deploy/vllm may serve ${M}: kubectl apply -k workloads/inference/overlays/qwen2.5-1.5b"
on_fail() { # keep whatever this run wrote as *.f6.1.partial.json, then restore step 3's files
  [[ -f results/05-load.f3.1.json ]] || return 0
  cp results/04-workload.json results/04-workload.f6.1.partial.json 2>/dev/null || true
  cp results/05-load.json results/05-load.f6.1.partial.json 2>/dev/null || true
  restore
}
trap 'rc=$?; if (( rc != 0 )); then on_fail; fi; _on_exit $rc' EXIT

say ">>> MODEL=${M} MODEL_REVISION=${REV} workloads/inference/render.sh | kubectl apply -f -"
MODEL="${M}" MODEL_REVISION="${REV}" workloads/inference/render.sh | kubectl apply -f -
if [[ "${VLLM_LOWERED:-0}" == 1 ]]; then
  run kubectl -n inference set resources deploy/vllm -c vllm --requests=cpu=3,memory=16Gi
fi
run kubectl -n inference scale deploy/vllm --replicas=1
run kubectl -n inference rollout status deploy/vllm --timeout=15m
headroom || die "headroom short for the bench Job beside ${M}"
run tests/validate/04-workload.sh
say ">>> BENCH_NUM_PROMPTS=${N} tests/validate/05-load.sh   (Pending watch active)"
BENCH_NUM_PROMPTS="${N}" tests/validate/05-load.sh &
pid=$!
bench_guard inference "${pid}" 'if (( rc != 0 )); then on_fail; fi'   # Ctrl-C: stop the bench, delete its Job
w=0; watch_bench inference "${pid}" || w=$?
lrc=0; wait "${pid}" || lrc=$?
bench_unguard 'if (( rc != 0 )); then on_fail; fi'
(( w != 3 )) || die "bench Pending for capacity beside ${M}: F6.1 not measured (record it)"
run mv results/04-workload.json results/04-workload.f6.1.json
run mv results/05-load.json results/05-load.f6.1.json
restore
run kubectl apply -k workloads/inference/overlays/qwen2.5-1.5b
run kubectl -n inference rollout status deploy/vllm --timeout=15m

result_begin
say "F6.1 model ${M}@${REV}, BENCH_NUM_PROMPTS=${N}, 05-load exit ${lrc}"
bench_summary results/05-load.f6.1.json
say "F6.1 files: results/04-workload.f6.1.json results/05-load.f6.1.json; step-3 files restored; vLLM back on qwen2.5-1.5b"
say "next: bash ${LIVE_DIR}/run2-9-evidence.sh"
