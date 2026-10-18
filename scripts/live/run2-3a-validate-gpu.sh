#!/usr/bin/env bash
# Run 2 step 3 (part a): NOT make validate-cluster (one GPU: the probes would stay Pending behind
# vLLM). make kubeconfig; while the GPU is free: 00-nodes and 01-gpu (both must pass: without a
# node and a working GPU there is nothing to serve on; a failure stops the step and is recorded, so
# run2-all.sh reports it and skips the steps that need vLLM), then 02-interconnect, whose result is
# RECORDED and does not stop the step (a single-rank NCCL probe says nothing about whether vLLM can
# serve). Then the qwen2.5-1.5b overlay and its rollout (creates the model-cache PVC).
# Why: on 2026-10-12 a false 01-gpu failure (since fixed in tests/validate/01-gpu.sh) stopped this
# step, vLLM was never deployed, and the batch carried on without saying why; a hand-written
# recovery in run2-9 re-ran 3a-3d before teardown.
# State for later steps and run2-all.sh (state/run2.env): GPU_L00 GPU_L01 GPU_L02 = pass|fail|missing,
# VLLM_DEPLOYED = 1 once the rollout completed (0 before). Exit 0 when vLLM is up, whatever 02 says;
# the RESULT block's VERDICT names a failed 02.
# Executed: bash run2-3a-validate-gpu.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-3a-validate-gpu
header "Run 2 step 3a - kubeconfig, layers 00-02, vLLM overlay" \
  "make kubeconfig; tests/validate/00-nodes.sh && 01-gpu.sh (must pass), 02-interconnect.sh (recorded); kubectl apply -k workloads/inference/overlays/qwen2.5-1.5b; rollout status (15 min)" \
  "\$0 extra (runs on the R1 node already billing)" "about 10-20 min (model download dominates the rollout)" \
  "the RESULT block (three layer statuses, rollout outcome, VERDICT)"
need make jq terraform nebius kubectl
check_repo
load_env
state_load run2
[[ -n "${APPLIED_R1:-}" ]] || die "R1 is not applied (run2-2c-inference.sh)"
[[ "${STEP_2D_DONE:-0}" == 1 || "$(session_mode)" == r1-only ]] || die "run run2-2d-rearm.sh first (data/ml-services must not fire before R1's expiry + 30 min)"

boot inference
run make kubeconfig
kube_env
say "KUBECONFIG=${KUBECONFIG}  context=$(kubectl config current-context)"

st() { jq -r '.status' "results/$1.json" 2>/dev/null || echo missing; }
record_layers() { state_set run2 GPU_L00 "$(st 00-nodes)"; state_set run2 GPU_L01 "$(st 01-gpu)"; state_set run2 GPU_L02 "$(st 02-interconnect)"; }
replicas="$(kubectl -n inference get deploy vllm -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)"
if (( ${replicas:-0} > 0 )); then
  if [[ "$(st 00-nodes)$(st 01-gpu)" == passpass ]]; then
    say "vLLM already holds the GPU and 00-01 already passed: skipping the probes (02-interconnect: $(st 02-interconnect))"
  else
    die "deploy/vllm already holds the GPU, so 01-gpu would stay Pending: kubectl -n inference scale deploy/vllm --replicas=0, then rerun"
  fi
else
  state_set run2 VLLM_DEPLOYED 0
  for layer in 00-nodes 01-gpu; do
    rc=0; run "tests/validate/${layer}.sh" || rc=$?
    if (( rc != 0 )); then
      record_layers
      die "${layer} failed (results/${layer}.json): vLLM NOT deployed, so 3b-3d cannot run. Fix the layer (or the check), then rerun this step"
    fi
  done
  rc=0; run tests/validate/02-interconnect.sh || rc=$?
  (( rc == 0 )) || say "02-interconnect failed (results/02-interconnect.json): recorded; deploying vLLM anyway"
fi
record_layers
run kubectl apply -k workloads/inference/overlays/qwen2.5-1.5b
run kubectl -n inference rollout status deploy/vllm --timeout=15m
state_set run2 VLLM_DEPLOYED 1

result_begin
for s in 00-nodes 01-gpu 02-interconnect; do say "  ${s}: $(st "${s}")"; done
say "  vllm rollout: complete; pvc model-cache: $(kubectl -n inference get pvc model-cache -o jsonpath='{.status.phase}' 2>/dev/null || echo none)"
if [[ "$(st 02-interconnect)" == pass ]]; then say "VERDICT: PASS"
else say "VERDICT: PASS WITH A FAILED LAYER: 02-interconnect $(st 02-interconnect) (recorded; vLLM deployed)"; fi
say "next: bash ${LIVE_DIR}/run2-3b-headroom.sh"
