#!/usr/bin/env bash
# Step 2 — NCCL plumbing on ONE GPU: the nccl-tests image runs, NCCL initialises on the
# driver preset, and all_reduce completes with "Out of bounds values : 0 OK". Bus
# bandwidth on a single rank is 0 by definition (busbw = algbw * 2(n-1)/n), so it is
# deliberately NOT recorded; multi-node bandwidth is stacks/training's 03-nccl.sh.
# The verdict is NCCL's alone, on every node shape: one rank never uses the network, so a node with
# no InfiniBand (gpu-l40s-a, gpu-rtx6000*, any node outside a GPU cluster) passes on the same terms,
# and the record says what was NOT tested: `fabric` (InfiniBand: not-applicable where the platform has
# no fabric in platform/regions.yaml, else not-tested here) and `multi_gpu` (03-nccl.sh).
# Inputs: NCCL_TEST_IMAGE; NCCL_POD_TIMEOUT_S (default 900: the pod must start, which includes pulling
#   the nccl-tests image, and finish; the image size is not documented, so the default is generous);
#   GPU_PLATFORM (optional, e.g. gpu-l40s-a: looked up in platform/regions.yaml for `fabric`).
# shellcheck source=tests/validate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; need kubectl jq
# shellcheck source=tests/validate/lib-pod.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib-pod.sh"
# shellcheck source=tests/validate/lib-nccl.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib-nccl.sh"
IMAGE="${NCCL_TEST_IMAGE:-cr.eu-north1.nebius.cloud/nebius-benchmarks/nccl-tests:2.23.4-ubu22.04-cu12.4@sha256:ac690d7e792f9baed20c079e664fee097ec0f9b872a1ac6e4f6ecb4c9c667381}"
TIMEOUT_S="${NCCL_POD_TIMEOUT_S:-900}"; PLATFORM="${GPU_PLATFORM:-}"
[[ "$TIMEOUT_S" =~ ^[1-9][0-9]*$ ]] || { echo "NCCL_POD_TIMEOUT_S must be a positive number of seconds" >&2; exit 2; }
FLAGS="-b 8 -e 256M -f 2 -g 1"
overrides="$(jq -nc --arg img "$IMAGE" '{spec:{
  tolerations:[{key:"nvidia.com/gpu",operator:"Exists"}], nodeSelector:{"nip.nebius.io/gpu":"true"},
  containers:[{name:"nccl", image:$img, env:[{name:"NCCL_DEBUG",value:"INFO"}],
    command:["/opt/nccl_tests/build/all_reduce_perf","-b","8","-e","256M","-f","2","-g","1"],
    resources:{limits:{"nvidia.com/gpu":1}}}]}}')"
log="$(mktemp)"; trap 'rm -f "$log"' EXIT
pod="$(pod_run nip-nccl-1gpu "$IMAGE" "$overrides" "$TIMEOUT_S" "$log")"
nccl="$(nccl_parse "$log")"

# The node's shape: GPUs, and whether it sits in a GPU cluster (labels only; the cluster id is a
# resource id and is never recorded). docs kubernetes/gpu/topology-aware-scheduling: nodes in a GPU
# cluster carry topology.nebius.com/gpu-cluster-id; no label "usually means" no GPU cluster or no TAS.
node_name="$(jq -r '.node // empty' <<<"$pod")"
node='{}'; [[ -n "$node_name" ]] && node="$(kubectl get node "$node_name" -o json 2>/dev/null || echo '{}')"
shape="$(jq -c '{name:(.metadata.name // null), gpus:((.status.allocatable["nvidia.com/gpu"] // "0") | tonumber),
  gpu_cluster_label:((.metadata.labels // {}) | has("topology.nebius.com/gpu-cluster-id")),
  infiniband_label:((.metadata.labels // {})["nip.nebius.io/infiniband"] == "true")}' <<<"$node")"
# platform/regions.yaml: a platform with a `fabric` in any region can form a GPU cluster; one with
# none cannot (L40S has no GPU-cluster preset: docs compute/virtual-machines/types).
regions="$(dirname "${BASH_SOURCE[0]}")/../../platform/regions.yaml"
plat_rows=""; [[ -n "$PLATFORM" ]] && plat_rows="$(grep -E "^[[:space:]]+${PLATFORM}:[[:space:]]*\{" "$regions" || true)"
fabric="$(jq -c --arg p "$PLATFORM" --arg rows "$plat_rows" '
  (.gpu_cluster_label or .infiniband_label) as $ib
  | if $ib then {status:"not-tested",infiniband:true,reason:"the node is in a GPU cluster (InfiniBand labels); one rank never uses the fabric: tests/validate/03-nccl.sh measures it (stacks/training)"}
    elif $p == "" then {status:"not-tested",infiniband:false,reason:"the node carries no GPU-cluster label (topology.nebius.com/gpu-cluster-id, nip.nebius.io/infiniband): no InfiniBand fabric seen; set GPU_PLATFORM to check platform/regions.yaml"}
    elif $rows == "" then {status:"not-tested",infiniband:false,reason:"unknown: \($p) is not in platform/regions.yaml"}
    elif ($rows | test("fabric:")) then {status:"not-tested",infiniband:false,reason:"\($p) can join a GPU cluster (fabric in platform/regions.yaml) but this node carries no GPU-cluster label: the fabric is not tested here"}
    else {status:"not-applicable",infiniband:false,reason:"\($p) has no InfiniBand fabric in platform/regions.yaml (no GPU-cluster preset: docs compute/virtual-machines/types) and the node carries no GPU-cluster label"} end' <<<"$shape")"
multi="$(jq -r 'if .gpus <= 1 then "not-applicable: \(.gpus) GPU on the node"
  else "not tested here: one rank on 1 of \(.gpus) GPUs; intra-node and multi-node all_reduce are tests/validate/03-nccl.sh (stacks/training)" end' <<<"$shape")"

details="$(jq -n --arg img "$IMAGE" --arg flags "$FLAGS" --argjson pod "$pod" --argjson nccl "$nccl" --argjson shape "$shape" \
  --argjson fabric "$fabric" --arg multi "$multi" --arg p "$PLATFORM" --arg raw "$(tail -n 25 "$log")" \
  '{image:$img,flags:$flags,exit_code:$pod.exit_code,pod:$pod,nccl_version:$nccl.nccl_version,out_of_bounds_ok:$nccl.out_of_bounds_ok,
    transport:$nccl.transport,platform:(if $p == "" then null else $p end),node:{gpus:$shape.gpus},fabric:$fabric,multi_gpu:$multi,
    note:"single rank: bus bandwidth is 0 by definition and not a fabric number",tail:$raw}')"
if jq -e '.pod.outcome == "succeeded" and .exit_code == 0 and .out_of_bounds_ok and .nccl_version != ""' <<<"$details" >/dev/null; then
  record 02-interconnect pass "$details"
else
  record 02-interconnect fail "$details"
fi
