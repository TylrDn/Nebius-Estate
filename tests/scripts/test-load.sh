#!/usr/bin/env bash
# tests/validate/05-load.sh (R1 load step) against a stub kubectl: the bench Job runs the
# tests/load/sweep.sh concurrency sweep from a ConfigMap, is pinned off the GPU node when the
# cluster has a CPU node (and says so when it has none), takes its sweep shape from BENCH_*, and
# the step records the bench.py result (points, bars, cold start from 04-workload) as 05-load.json.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step="${repo_root}/tests/validate/05-load.sh"
export RESULTS_DIR="${work}/results" BENCH_POLL_INTERVAL=0 FIXTURE="${repo_root}/tests/load/fixtures/sweep-pass.log"
mkdir -p "${RESULTS_DIR}"
unset BAR_MAX_TTFT_P99_MS BAR_MAX_TPOT_P99_MS BAR_MAX_E2E_P99_MS BAR_MIN_OUTPUT_TPS BAR_MIN_SUCCESS_RATIO \
  BENCH_USD_PER_HOUR BENCH_UTILISATION BENCH_USD_PER_1M_OUTPUT BENCH_CONCURRENCY BENCH_NUM_PROMPTS
# Applied manifests are saved under $work/applied-<n>.yaml; NODES picks the node list.
stub kubectl '
case "$*" in
  *"get deploy vllm -o jsonpath={.spec.template.spec.containers[0].envFrom[0].configMapRef.name}"*) echo vllm-config-abc ;;
  *"get deploy vllm -o jsonpath={.spec.template.spec.containers[0].image}"*) echo "vllm/vllm-openai:v0@sha256:00" ;;
  *"get cm vllm-config-abc -o jsonpath={.data.MODEL}"*) echo "Qwen/Qwen2.5-1.5B-Instruct" ;;
  "get nodes -o json")
    if [[ "${NODES}" == gpu-only ]]; then echo "{\"items\":[{\"metadata\":{\"name\":\"gpu-0\",\"labels\":{\"nip.nebius.io/gpu\":\"true\",\"topology.kubernetes.io/region\":\"eu-north1\"}}}]}"
    else echo "{\"items\":[{\"metadata\":{\"name\":\"gpu-0\",\"labels\":{\"nip.nebius.io/gpu\":\"true\",\"topology.kubernetes.io/region\":\"eu-north1\"}}},{\"metadata\":{\"name\":\"cpu-0\",\"labels\":{\"topology.kubernetes.io/region\":\"eu-north1\"}}}]}"; fi ;;
  *"create configmap vllm-bench-sweep"*) [[ "$*" == *"--from-file=sweep.sh="*"/tests/load/sweep.sh"* ]] && echo SWEEP_CM_FROM_FILE >> "$LOG"; echo "kind: ConfigMap" ;;
  *"apply -f -"*) n=$(ls "$(dirname "$LOG")"/applied-*.yaml 2>/dev/null | wc -l | tr -d " "); cat > "$(dirname "$LOG")/applied-${n}.yaml" ;;
  *"get job vllm-bench -o json"*) echo "{\"status\":{\"conditions\":[{\"type\":\"Complete\",\"status\":\"True\"}]}}" ;;
  *"get pod -l job-name=vllm-bench"*) [[ "${NODES}" == gpu-only ]] && echo gpu-0 || echo cpu-0 ;;
  *"get pod -l app.kubernetes.io/name=vllm"*) echo gpu-0 ;;
  *"logs job/vllm-bench"*) cat "$FIXTURE" ;;
  *"get pod -l app.kubernetes.io/name=dcgm-exporter"*) [[ -n "${DCGM:-}" ]] && echo dcgm-0 || exit 1 ;;
  *"exec dcgm-0"*) printf "# HELP DCGM_FI_DEV_GPU_UTIL GPU utilization\nDCGM_FI_DEV_GPU_UTIL{gpu=\"0\"} 87\n" ;;
  *) exit 0 ;;
esac'
job() { grep -l 'kind: Job' "${work}"/applied-*.yaml | tail -1; }

test_name=load-off-gpu-node-with-cpu-node
printf '{"step":"04-workload","status":"pass","details":{"startup_seconds":312,"first_request_ms":90}}' > "${RESULTS_DIR}/04-workload.json"
NODES=mixed "${step}" >/dev/null 2>"${work}/err" || fail "05-load failed: $(cat "${work}/err")"
grep -q SWEEP_CM_FROM_FILE "${LOG}" || fail "the sweep script must reach the Job as a ConfigMap built from tests/load/sweep.sh"
j="$(job)"; [[ -n "${j}" ]] || fail "no Job was applied"
{ grep -q 'key: nip.nebius.io/gpu' "${j}" && grep -q 'operator: DoesNotExist' "${j}"; } || fail "with a CPU node the Job must require a node without nip.nebius.io/gpu: $(cat "${j}")"
grep -q '__' "${j}" && fail "unrendered placeholder in the Job: $(grep '__' "${j}")"
r="${RESULTS_DIR}/05-load.json"
jq -e '.step=="05-load" and .status=="pass" and .details.schema=="nip-bench/1" and .details.target=="r1"
  and .details.vantage=="in-cluster" and ([.details.points[].concurrency]==[1,8,32])
  and .details.placement.cpu_node_available==true and .details.placement.bench_on_gpu_node==false
  and .details.placement.bench_node=="cpu-0" and .details.placement.serving_node=="gpu-0"
  and .details.cold_start.server_startup_s==312 and .details.cold_start.first_request_ms==90
  and (.details.cold_start.first_request_source|test("04-workload")) and .details.first_sweep_request_ms==2380
  and .details.region=="eu-north1" and .details.image=="vllm/vllm-openai:v0@sha256:00"
  and (.details.gpu_util_pct_during_run|type=="object")' "${r}" >/dev/null || fail "05-load.json: $(cat "${r}")"
ok "Job pinned off the GPU node; result has the sweep, placement and cold start"

test_name=load-shared-node-when-gpu-only
rm -f "${work}"/applied-*.yaml; : > "${LOG}"
NODES=gpu-only "${step}" >/dev/null 2>"${work}/err" || fail "05-load failed: $(cat "${work}/err")"
j="$(job)"
grep -q 'DoesNotExist' "${j}" && fail "with no CPU node the Job must not require one (it would never schedule)"
jq -e '.details.placement.cpu_node_available==false and .details.placement.bench_on_gpu_node==true
  and (.details.placement.note|test("no CPU node"))' "${r}" >/dev/null || fail "placement not recorded: $(jq .details.placement "${r}")"
ok "GPU-only cluster: Job shares the node and the result says so"

test_name=load-sweep-shape-from-env
rm -f "${work}"/applied-*.yaml
NODES=mixed BENCH_CONCURRENCY="1 4" BENCH_NUM_PROMPTS=50 "${step}" >/dev/null 2>&1 || true
j="$(job)"
grep -A1 'name: CONCURRENCY' "${j}" | grep -q '"1 4"' || fail "BENCH_CONCURRENCY must reach the Job: $(grep -A1 CONCURRENCY "${j}")"
grep -A1 'name: NUM_PROMPTS' "${j}" | grep -q '"50"' || fail "BENCH_NUM_PROMPTS must reach the Job"
grep -A1 'name: MODEL' "${j}" | grep -q 'Qwen/Qwen2.5-1.5B-Instruct' || fail "the served model must reach the Job"
ok "BENCH_* inputs reach the Job"

test_name=load-bar-failure-fails-step
FIXTURE="${repo_root}/tests/load/fixtures/sweep-slow.log"
set +e; NODES=mixed "${step}" >/dev/null 2>&1; rc=$?; set -e
[[ "${rc}" -ne 0 ]] || fail "a point over the E2E bar must fail the step"
jq -e '.status=="fail" and .details.max_passing_concurrency==8' "${r}" >/dev/null || fail "05-load.json: $(cat "${r}")"
ok "a broken bar fails the step"

test_name=load-rejects-unsafe-input
set +e; NODES=mixed BENCH_CONCURRENCY='1|8' "${step}" >/dev/null 2>"${work}/err"; rc=$?; set -e
{ [[ "${rc}" -ne 0 ]] && grep -q 'BENCH_CONCURRENCY' "${work}/err"; } || fail "an input that cannot be rendered safely must be refused (rc=${rc}): $(cat "${work}/err")"
ok "unsafe input refused"

test_name=load-gpu-util-sampled-during-run
FIXTURE="${repo_root}/tests/load/fixtures/sweep-pass.log"
DCGM=1 NODES=mixed "${step}" >/dev/null 2>"${work}/err" || fail "05-load failed: $(cat "${work}/err")"
grep -q 'exec dcgm-0' "${LOG}" || fail "DCGM was never sampled"
jq -e '.details.gpu_util_pct_during_run.samples > 0 and .details.gpu_util_pct_during_run.mean == 87' "${r}" >/dev/null \
  || fail "the DCGM samples must reach the result: $(jq -c .details.gpu_util_pct_during_run "${r}")"
ok "GPU utilisation samples taken while the Job ran reach the result"
