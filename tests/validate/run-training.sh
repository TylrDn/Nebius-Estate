#!/usr/bin/env bash
# Bottom-up validation for stacks/training: nodes -> GPU -> single-node NCCL -> multi-node NCCL -> storage.
# Stops at the first failing layer (P4) and writes results/summary-training.json. The DDP
# job (workloads/training/ddp) is launched by hand afterwards; it is a workload, not a layer.
#   GPU_PLUGIN_NAMESPACE  gpu-operator when enable_gpu_operator = true, else nvidia-device-plugin (default)
#   NCCL_OVERLAY          multi-node overlay to run (default multi-node-2x8; multi-node-2x8-b200 on B200)
#   NCCL_MIN_BUSBW        multi-node pass bar, average bus bandwidth in GB/s (default 300, the docs' bar)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
results="$(cd ../.. && pwd)/results"
export PVC_NAME="" # the training env has no inference PVC; 03-storage checks the mount and StorageClass only
overlay="${NCCL_OVERLAY:-multi-node-2x8}"
steps=(00-nodes 01-gpu 03-nccl-single-node-8gpu "03-nccl-${overlay}" 03-storage)
# The summary is written on every exit, so a run stopped at a failed layer still leaves the
# aggregate (steps run so far, with the failing one marked fail by its own record()).
summary() {
  local files=(); for s in "${steps[@]}"; do [[ -f "${results}/${s}.json" ]] && files+=("${results}/${s}.json"); done
  [[ ${#files[@]} -gt 0 ]] || return 0
  jq -s '{generated:(now|todate),steps:(map({(.step):.status})|add)}' "${files[@]}" > "${results}/summary-training.json"
}
trap summary EXIT
for s in "${steps[@]}"; do rm -f "${results}/${s}.json"; done
run() { echo "== $*"; "$@" || { echo "FAILED at $1; fix this layer before moving up (results/summary-training.json has the steps so far)." >&2; exit 1; }; }
run ./00-nodes.sh
run ./01-gpu.sh
run ./03-nccl.sh single-node-8gpu
run ./03-nccl.sh "$overlay"
run ./03-storage.sh
echo "platform validated; evidence in results/ (summary-training.json). Launch workloads/training/ddp next."
