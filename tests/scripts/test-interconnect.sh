#!/usr/bin/env bash
# tests/validate/02-interconnect.sh (one-GPU NCCL plumbing). 2026-10-12 on a single gpu-l40s-a
# (1gpu-8vcpu-32gb, no InfiniBand, GPU-only cluster) the step died with kubectl's "error: timed out
# waiting for the condition": `kubectl run --rm -i` attaches only after the pod runs and waits
# --pod-running-timeout (default 1m0s) for that, so a pod still pulling the nccl-tests image (or
# Pending) killed the step with no reason recorded. The step now starts the pod, waits up to
# NCCL_POD_TIMEOUT_S for it to finish, and records why it did not. A node without a fabric passes on
# NCCL alone (one rank never uses the network) and says the fabric was not tested; an NCCL failure
# fails on every shape. kubectl is a stub: no cluster.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
export FIXTURES="${repo_root}/tests/validate/fixtures"
stub kubectl '
case "$*" in
  "delete pod nip-nccl-1gpu"*) ;;
  "run nip-nccl-1gpu "*)
    # the old attach path: what the 2026-10-12 run printed
    if [[ " $* " == *" -i "* || "$*" == *"--rm"* ]]; then echo "error: timed out waiting for the condition" >&2; exit 1; fi ;;
  "get pod nip-nccl-1gpu -o json")
    case "${POD:-succeeded}" in
      succeeded) echo "{\"spec\":{\"nodeName\":\"node-a\"},\"status\":{\"phase\":\"Succeeded\",\"containerStatuses\":[{\"state\":{\"terminated\":{\"exitCode\":0,\"reason\":\"Completed\"}}}]}}" ;;
      failed)    echo "{\"spec\":{\"nodeName\":\"node-a\"},\"status\":{\"phase\":\"Failed\",\"containerStatuses\":[{\"state\":{\"terminated\":{\"exitCode\":1,\"reason\":\"Error\"}}}]}}" ;;
      pulling)   echo "{\"spec\":{\"nodeName\":\"node-a\"},\"status\":{\"phase\":\"Pending\",\"containerStatuses\":[{\"state\":{\"waiting\":{\"reason\":\"ContainerCreating\"}}}]}}" ;;
      backoff)   echo "{\"spec\":{\"nodeName\":\"node-a\"},\"status\":{\"phase\":\"Pending\",\"containerStatuses\":[{\"state\":{\"waiting\":{\"reason\":\"ImagePullBackOff\",\"message\":\"Back-off pulling image\"}}}]}}" ;;
      unschedulable) echo "{\"spec\":{},\"status\":{\"phase\":\"Pending\",\"conditions\":[{\"type\":\"PodScheduled\",\"status\":\"False\",\"reason\":\"Unschedulable\",\"message\":\"0/1 nodes are available: 1 Insufficient nvidia.com/gpu.\"}]}}" ;;
    esac ;;
  "logs nip-nccl-1gpu"*) cat "${FIXTURES}/${NCCL_LOG:-nccl-socket-1gpu.log}" ;;
  "get node node-a -o json")
    if [[ "${SHAPE:-l40s}" == ib8 ]]; then
      echo "{\"metadata\":{\"name\":\"node-a\",\"labels\":{\"nip.nebius.io/infiniband\":\"true\",\"topology.nebius.com/gpu-cluster-id\":\"computegpucluster-mock\"}},\"status\":{\"allocatable\":{\"nvidia.com/gpu\":\"8\"}}}"
    else
      echo "{\"metadata\":{\"name\":\"node-a\",\"labels\":{\"nip.nebius.io/gpu\":\"true\"}},\"status\":{\"allocatable\":{\"nvidia.com/gpu\":\"1\"}}}"
    fi ;;
  "config current-context") echo mock ;;
  *) exit 1 ;;
esac'
export RESULTS_DIR="${work}/results" POD_POLL_S=1
step() { set +e; env "$@" bash "${repo_root}/tests/validate/02-interconnect.sh" >"${work}/out" 2>&1; echo $?; set -e; }
result() { jq -r "$1" "${RESULTS_DIR}/02-interconnect.json"; }

test_name=interconnect-no-attach-timeout
rc="$(step GPU_PLATFORM=gpu-l40s-a)"
[[ "${rc}" == 0 && "$(result .status)" == pass ]] || { cat "${work}/out" >&2; fail "a one-GPU L40S node whose NCCL run succeeds must pass (rc ${rc})"; }
grep '^kubectl run nip-nccl-1gpu ' "${LOG}" | grep -qE -- ' -i |--rm' && fail "the pod must not be started with --rm -i (1 min attach timeout)"
grep -q '"nvidia.com/gpu":1' <(grep '^kubectl run nip-nccl-1gpu ' "${LOG}") || fail "the pod requests one GPU"
grep -q '^kubectl delete pod nip-nccl-1gpu --ignore-not-found --wait=false' "${LOG}" || fail "the finished pod is deleted"
ok "the pod is started and waited for, not attached with a 1 min timeout"

test_name=interconnect-l40s-fabric-not-applicable
[[ "$(result .details.nccl_version)" == "NCCL version 2.23.4+cuda12.4" && "$(result .details.out_of_bounds_ok)" == true \
   && "$(result .details.transport)" == socket && "$(result .details.node.gpus)" == 1 ]] || fail "NCCL result and node shape recorded: $(result .details)"
[[ "$(result .details.fabric.status)" == not-applicable && "$(result .details.fabric.infiniband)" == false ]] || fail "no fabric on this shape: $(result .details.fabric)"
result .details.fabric.reason | grep -q 'gpu-l40s-a has no InfiniBand fabric in platform/regions.yaml' || fail "the reason cites regions.yaml: $(result .details.fabric)"
[[ "$(result '.details.multi_gpu')" == "not-applicable: 1 GPU on the node" ]] || fail "multi-GPU coverage stated: $(result .details.multi_gpu)"
grep -q 'computegpucluster' "${RESULTS_DIR}/02-interconnect.json" && fail "the GPU cluster id must not be recorded"
ok "gpu-l40s-a: NCCL passes on one rank, the fabric is not-applicable with a reason from platform/regions.yaml"

test_name=interconnect-ib8-not-claimed
rc="$(step SHAPE=ib8 NCCL_LOG=nccl-roce-1gpu.log)"
[[ "${rc}" == 0 && "$(result .details.fabric.status)" == not-tested && "$(result .details.fabric.infiniband)" == true ]] \
  || fail "an InfiniBand node passes NCCL plumbing but the fabric is not claimed (rc ${rc}): $(result .details.fabric)"
result .details.multi_gpu | grep -q '03-nccl.sh' || fail "8 GPUs: multi-GPU coverage points at 03-nccl.sh: $(result .details.multi_gpu)"
ok "an 8-GPU InfiniBand node: plumbing passes, fabric and multi-GPU are left to 03-nccl.sh, never claimed"

test_name=interconnect-nccl-failure-fails
rc="$(step SHAPE=ib8 POD=failed NCCL_LOG=nccl-ib-2x8.log)"
[[ "${rc}" != 0 && "$(result .status)" == fail && "$(result .details.pod.exit_code)" == 1 ]] || fail "a failed NCCL pod fails on any shape (rc ${rc})"
rc="$(step POD=failed GPU_PLATFORM=gpu-l40s-a)"
[[ "${rc}" != 0 && "$(result .status)" == fail ]] || fail "a failed NCCL pod fails on a no-fabric shape too (rc ${rc})"
ok "an NCCL failure fails the step whatever the shape"

test_name=interconnect-timeout-reason
rc="$(step POD=pulling NCCL_POD_TIMEOUT_S=2)"
[[ "${rc}" != 0 && "$(result .details.pod.outcome)" == timeout && "$(result .details.pod.waiting_reason)" == ContainerCreating ]] \
  || fail "a pod still starting at the deadline fails with its state (rc ${rc}): $(result .details.pod)"
rc="$(step POD=unschedulable NCCL_POD_TIMEOUT_S=2)"
if [[ "${rc}" == 0 ]] || ! result .details.pod.message | grep -q 'Insufficient nvidia.com/gpu'; then
  fail "an unschedulable pod records the scheduler's reason (rc ${rc}): $(result .details.pod)"
fi
rc="$(step POD=backoff NCCL_POD_TIMEOUT_S=600)"
[[ "${rc}" != 0 && "$(result .details.pod.outcome)" == start_failed && "$(result .details.pod.waiting_reason)" == ImagePullBackOff ]] \
  || fail "an image that cannot be pulled fails at once with the reason (rc ${rc}): $(result .details.pod)"
rc="$(step NCCL_POD_TIMEOUT_S=abc)"
[[ "${rc}" == 2 ]] || fail "a non-numeric NCCL_POD_TIMEOUT_S is refused (rc ${rc})"
ok "timeout, unschedulable and image-pull failures are recorded with their reason"
