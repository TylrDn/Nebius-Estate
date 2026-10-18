#!/usr/bin/env bash
# Run 2 step 3 (part b): bench headroom. With no CPU node, 05-load's Job (requests cpu 2, memory
# 4Gi) must fit on the one 1gpu-8vcpu-32gb node beside vLLM (cpu 4, memory 24Gi), the system pods,
# Alertmanager and Grafana. If short: lower vLLM's requests for this run only (cpu=3, memory=16Gi;
# Recreate, so the new pod gets the GPU), wait for the rollout, check again. Still short: F3.1 is
# recorded as blocked by node capacity (steps 4-7 continue).
# Executed: bash run2-3b-headroom.sh   (run it again after a 05-load Pending stop)
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-3b-headroom
header "Run 2 step 3b - bench headroom on the GPU node" \
  "kubectl describe node (Allocatable minus requests >= cpu 2, memory 4Gi); if short: kubectl set resources deploy/vllm cpu=3 memory=16Gi + rollout, check again" \
  "\$0 extra" "1 min, or about 10 min when vLLM is re-rolled" "the RESULT block (HEADROOM lines, whether vLLM was lowered)"
need kubectl jq python3
check_repo
load_env
state_load run2
kube_env

rc=0; headroom || rc=$?
lowered=0
if (( rc != 0 )); then
  cur="$(kubectl -n inference get deploy vllm -o jsonpath='{.spec.template.spec.containers[?(@.name=="vllm")].resources.requests}')"
  say "vLLM requests now: ${cur}"
  if [[ "$(jq -r '.cpu // empty' <<<"${cur}")" == 3 && "$(jq -r '.memory // empty' <<<"${cur}")" == 16Gi ]]; then
    state_set run2 F31_BLOCKED 1
  else
    run kubectl -n inference set resources deploy/vllm -c vllm --requests=cpu=3,memory=16Gi
    run kubectl -n inference rollout status deploy/vllm --timeout=15m
    state_set run2 VLLM_LOWERED 1; state_set run2 VLLM_LOWERED_AT "$(nip_now)"; lowered=1
    rc=0; headroom || rc=$?
    (( rc == 0 )) || state_set run2 F31_BLOCKED 1
  fi
fi

result_begin
state_load run2
say "vLLM requests: $(kubectl -n inference get deploy vllm -o jsonpath='{.spec.template.spec.containers[?(@.name=="vllm")].resources.requests}')"
say "lowered in this run: ${lowered} (ever: ${VLLM_LOWERED:-0}; record it in the R1 evidence, done before 04-workload)"
if [[ "${F31_BLOCKED:-0}" == 1 ]]; then
  say "HEADROOM SHORT even at cpu=3/memory=16Gi: F3.1 BLOCKED by node capacity (record in the R1 evidence)."
  say "next: skip 05-load; bash ${LIVE_DIR}/run2-3c-storage-workload.sh (03 + 04), then run2-4-r8-acceptance.sh"
elif (( lowered == 1 )); then
  say "next: bash ${LIVE_DIR}/run2-3c-storage-workload.sh  (if 03 already passed: ONLY_WORKLOAD=1 ...; the new pod needs a fresh 04-workload, model cache warm)"
else
  say "next: bash ${LIVE_DIR}/run2-3c-storage-workload.sh  (or run2-3d-load.sh if 03 and 04 already passed for this pod)"
fi
