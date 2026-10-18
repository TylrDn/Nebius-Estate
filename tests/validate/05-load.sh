#!/usr/bin/env bash
# Step 5 — Load: run the tests/load/sweep.sh concurrency sweep as a Job (tests/load/bench-job.yaml)
# against the vLLM Service, sample GPU utilisation from DCGM WHILE it runs, and judge the result
# against the pass bars (tests/load/bench.py). The Job runs off the GPU node when the cluster has
# a CPU node; with none (a GPU-only sandbox) it shares the node and the result says so.
# Inputs and defaults (sweep shape BENCH_*, bars BAR_*, cost BENCH_USD_PER_HOUR): tests/load/README.md.
# shellcheck source=tests/validate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; need kubectl jq python3
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/load/lib-bench.sh
source "${here}/../load/lib-bench.sh"
# A sweep shape that is not positive integers is refused with exit 2 before kubectl is touched and
# without recording, so the evidence of an earlier run is kept.
bench_check || exit 2
cm="$(kubectl -n inference get deploy vllm -o jsonpath='{.spec.template.spec.containers[0].envFrom[0].configMapRef.name}')"
model="$(kubectl -n inference get cm "$cm" -o jsonpath='{.data.MODEL}')"
image="$(kubectl -n inference get deploy vllm -o jsonpath='{.spec.template.spec.containers[0].image}')"
# DCGM exporter: nvidia-device-plugin on the driver-image path, gpu-operator on the operator path.
GPU_NS="${GPU_PLUGIN_NAMESPACE:-nvidia-device-plugin}"
dcgm_pod="$(kubectl -n "$GPU_NS" get pod -l app.kubernetes.io/name=dcgm-exporter -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"

cpu_nodes="$(bench_cpu_nodes)"
off_gpu=false; (( cpu_nodes > 0 )) && off_gpu=true
bench_start inference http://vllm:8000 "$model" "$off_gpu"

# Sample GPU utilisation on every poll so the figure covers the run.
samples=()
sample_gpu() {
  [[ -n "$dcgm_pod" ]] || return 0
  local u
  u="$(kubectl -n "$GPU_NS" exec "$dcgm_pod" -- sh -c 'wget -qO- localhost:9400/metrics' 2>/dev/null | grep -E '^DCGM_FI_DEV_GPU_UTIL' | head -1 | grep -oE '[0-9]+(\.[0-9]+)?$' || true)"
  [[ -n "$u" ]] && samples+=("$u")
  return 0
}
bench_wait inference sample_gpu   # not in $(...): sample_gpu must fill samples in this shell
st="$BENCH_STATE"
bnode="$(bench_node inference)"
snode="$(kubectl -n inference get pod -l app.kubernetes.io/name=vllm -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null || true)"
log="$(mktemp)"; trap 'rm -f "$log"' EXIT
kubectl -n inference logs job/vllm-bench > "$log" 2>/dev/null || true

gpu_json="$(printf '%s\n' "${samples[@]:-}" | jq -R 'select(length>0)|tonumber' | jq -s 'if length==0 then {samples:0} else {samples:length,mean:(add/length),max:max} end')"
on_gpu="$(kubectl get nodes -o json | jq --arg n "$bnode" '[.items[] | select(.metadata.name==$n and .metadata.labels["nip.nebius.io/gpu"]=="true")] | length > 0')"
placement="$(jq -n --argjson cpu "$off_gpu" --arg b "$bnode" --arg s "$snode" --argjson g "$on_gpu" \
  '{cpu_node_available:$cpu,bench_node:$b,serving_node:$s,bench_on_gpu_node:$g,
    note:(if $cpu then "bench required off the GPU node (nodeAffinity nip.nebius.io/gpu DoesNotExist)"
          else "no CPU node in the cluster: the bench shared the GPU node, so its CPU use is inside the measurement" end)}')"
# Cold start, from 04-workload when that step passed in this results dir: pod start to Ready, and its
# chat completion, the first one the server answered (the sweep's own first request comes later).
startup=()
s="$(jq -r 'select(.status=="pass") | .details.startup_seconds // empty' "${RESULTS_DIR}/04-workload.json" 2>/dev/null || true)"
[[ -n "$s" ]] && startup=(--server-startup-s "$s")
f="$(jq -r 'select(.status=="pass") | .details.first_request_ms // empty' "${RESULTS_DIR}/04-workload.json" 2>/dev/null || true)"
[[ -n "$f" ]] && startup+=(--first-request-ms "$f" --first-request-source "04-workload chat completion")
region="$(bench_region)"
result="$(python3 "${here}/../load/bench.py" parse "$log" --target r1 --vantage in-cluster --image "$image" \
  --placement "$placement" ${startup[@]+"${startup[@]}"})"
details="$(jq --arg st "$st" --argjson gpu "$gpu_json" --arg rg "$region" \
  '. + {job_status:$st,gpu_util_pct_during_run:$gpu,region:(if $rg=="" then null else $rg end)}' <<<"$result")"
if [[ "$st" == Complete && "$(jq -r .status <<<"$result")" == pass ]]; then record 05-load pass "$details"; else record 05-load fail "$details"; fi
