#!/usr/bin/env bash
# Step 1 — GPU: nvidia.com/gpu allocatable on GPU nodes; nvidia-smi works in a pod; DCGM exporter up.
# shellcheck source=tests/validate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; need kubectl jq
alloc="$(kubectl get nodes -l nip.nebius.io/gpu=true -o json | jq '[.items[].status.allocatable["nvidia.com/gpu"]//"0"|tonumber]|add // 0')"
# Driver-image path installs into nvidia-device-plugin (stacks/inference); the GPU Operator path
# into gpu-operator (stacks/training). DaemonSet names differ too, so match by pattern.
GPU_NS="${GPU_PLUGIN_NAMESPACE:-nvidia-device-plugin}"
ds_json="$(kubectl -n "$GPU_NS" get ds -o json 2>/dev/null || echo '{"items":[]}')"
plugin_ready="$(jq '[.items[]|select(.metadata.name|test("device-plugin"))|.status.numberReady]|add // 0' <<<"$ds_json")"
dcgm_ready="$(jq '[.items[]|select(.metadata.name|test("dcgm"))|.status.numberReady]|add // 0' <<<"$ds_json")"
# The probe image's CUDA runtime must not exceed the node driver's: cuda13.0 presets (580.x)
# take the CUDA 13 image, cuda12.8 presets (570.x, opt-in only) the CUDA 12.8 image. CUDA_PROBE_IMAGE
# overrides; otherwise the CUDA 13 image is tried first and the 12.8 one on failure.
probe() { kubectl run nip-nvidia-smi --rm -i --restart=Never --quiet \
  --overrides="{\"spec\":{\"tolerations\":[{\"key\":\"nvidia.com/gpu\",\"operator\":\"Exists\"}],\"nodeSelector\":{\"nip.nebius.io/gpu\":\"true\"},\"containers\":[{\"name\":\"smi\",\"image\":\"$1\",\"command\":[\"nvidia-smi\",\"--query-gpu=name,driver_version,memory.total\",\"--format=csv,noheader\"],\"resources\":{\"limits\":{\"nvidia.com/gpu\":1}}}]}}" \
  --image="$1" 2>/dev/null; }
kubectl delete pod nip-nvidia-smi --ignore-not-found >/dev/null 2>&1 || true # left by an aborted run
smi=""; probe_image=""
for img in ${CUDA_PROBE_IMAGE:-nvidia/cuda:13.0.1-base-ubuntu24.04@sha256:f8ef28f579ea42a44b415d2c5d46f788e6a9b395c6c83f2929416e1fc192c143 nvidia/cuda:12.8.1-base-ubuntu24.04@sha256:133c78a0575303be34164d0b90137a042172bdf60696af01a3c424ab402d86e2}; do
  if smi="$(probe "$img")" && [[ -n "$smi" ]]; then probe_image="$img"; break; fi
  smi=""
done
# Every DaemonSet that matters on a GPU node (CSI node plugin, device plugin, DCGM, agents) must
# tolerate the nvidia.com/gpu taint: a DaemonSet whose desired count is below the node total
# (DaemonSets that pick their nodes with a nodeSelector or a required node affinity are left out:
# they target a subset on purpose, e.g. nebius-node-problem-detector-cpu requires nebius.com/gpu DoesNotExist
# and is rightly scheduled on 0 nodes of a GPU-only cluster, seen live 2026-10-12, while its -gpu twin
# covers the GPU node; NPD runs on every node per docs kubernetes/maintenance/health-checks)
# skipped the tainted nodes. The CSI driver's chart ships no tolerations (R1-8); we add them.
node_total="$(kubectl get nodes -o json | jq '.items|length')"
ds_short="$(kubectl get ds -A -o json | jq --argjson n "$node_total" '[.items[] | select(.spec.template.spec.nodeSelector == null and .spec.template.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution == null) | {ns:.metadata.namespace,name:.metadata.name,desired:.status.desiredNumberScheduled,ready:.status.numberReady} | select(.desired < $n)]')"
ds_cover_ok="$(jq 'length == 0' <<<"$ds_short")"
details="$(jq -n --argjson a "$alloc" --argjson p "$plugin_ready" --argjson d "$dcgm_ready" --arg s "$smi" --arg img "$probe_image" --arg ns "$GPU_NS" --argjson short "$ds_short" --argjson cover "$ds_cover_ok" \
  '{allocatable_gpus:$a,gpu_namespace:$ns,device_plugin_ready:$p,dcgm_exporter_ready:$d,nvidia_smi:$s,probe_image:$img,daemonsets_missing_nodes:$short,all_daemonsets_cover_gpu_nodes:$cover}')"
# Gate on the whole chain: GPUs allocatable, device plugin and DCGM exporter Ready, nvidia-smi works in a pod, DaemonSets reach the GPU nodes.
if [[ "$alloc" -ge 1 && "$plugin_ready" -ge 1 && "$dcgm_ready" -ge 1 && -n "$smi" && "$ds_cover_ok" == true ]]; then record 01-gpu pass "$details"; else record 01-gpu fail "$details"; fi
