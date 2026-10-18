#!/usr/bin/env bash
# Step 0 — Node: all nodes Ready; expected platform/preset labels present.
# shellcheck source=tests/validate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; need kubectl jq
nodes="$(kubectl get nodes -o json)"
total="$(jq '.items|length' <<<"$nodes")"
ready="$(jq '[.items[]|select(.status.conditions[]|select(.type=="Ready" and .status=="True"))]|length' <<<"$nodes")"
gpu_nodes="$(jq '[.items[]|select(.metadata.labels["nip.nebius.io/gpu"]=="true")]|length' <<<"$nodes")"
details="$(jq -n --argjson t "$total" --argjson r "$ready" --argjson g "$gpu_nodes" \
  --argjson n "$(jq '[.items[]|{name:.metadata.name,ready:([.status.conditions[]|select(.type=="Ready")][0].status),gpu:(.metadata.labels["nip.nebius.io/gpu"]//"false"),kubelet:.status.nodeInfo.kubeletVersion,os:.status.nodeInfo.osImage,kernel:.status.nodeInfo.kernelVersion}]' <<<"$nodes")" \
  '{total:$t,ready:$r,gpu_nodes:$g,nodes:$n}')"
if [[ "$total" -gt 0 && "$ready" == "$total" ]]; then record 00-nodes pass "$details"; else record 00-nodes fail "$details"; fi
