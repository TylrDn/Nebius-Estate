#!/usr/bin/env bash
# Bottom-up: stop at the first failing layer (P4). Writes results/summary.json from the
# steps run in THIS invocation only.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
results="$(cd ../.. && pwd)/results"
steps=(00-nodes 01-gpu 02-interconnect 03-storage 04-workload)
[[ "${WITH_LOAD:-0}" == 1 ]] && steps+=(05-load)
for s in "${steps[@]}"; do
  echo "== ${s}"
  if ! "./${s}.sh"; then echo "FAILED at ${s}; fix this layer before moving up." >&2; exit 1; fi
done
files=(); for s in "${steps[@]}"; do files+=("${results}/${s}.json"); done
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
}' "${files[@]}" > "${results}/summary.json"
echo "all steps passed; evidence in results/ (summary.json)"
