#!/usr/bin/env bash
# recipes/serverless/endpoint.sh: create spends only with CONFIRM=yes, records the endpoint id
# before polling, survives transient polling errors, prints the delete command on failure, and
# never puts the endpoint token in curl's or docker's argv. `measure` uses the R1 load method
# (tests/load): from the operator host by default, or as a Job inside the R1 cluster
# (MEASURE_FROM=cluster) so the comparison with R1 is in-region; the vantage is recorded.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ep="${repo_root}/recipes/serverless/endpoint.sh"
export RESULTS_DIR="${work}/results" ENDPOINT_POLL_INTERVAL=0 ENDPOINT_POLL_TRIES=5 BENCH_POLL_INTERVAL=0
export FIXTURE="${repo_root}/tests/load/fixtures/sweep-pass.log"
unset BAR_MAX_TTFT_P99_MS BAR_MAX_TPOT_P99_MS BAR_MAX_E2E_P99_MS BAR_MIN_OUTPUT_TPS BAR_MIN_SUCCESS_RATIO \
  BENCH_USD_PER_HOUR BENCH_UTILISATION BENCH_USD_PER_1M_OUTPUT BENCH_API_KEY MEASURE_FROM
state="${RESULTS_DIR}/serverless-endpoint.state"
stub openssl 'echo ep-token-sentinel'
stub curl 'case "$*" in *chat/completions*) printf "{\"choices\":[{\"message\":{\"content\":\"OK\"}}]}\n0.1" ;; esac'
stub docker 'echo "OPENAI_API_KEY=${OPENAI_API_KEY:-unset}" >> "$LOG"; cat "$FIXTURE"'
stub nebius '
case "$*" in
  "vpc subnet list"*) echo vpcsubnet-e00mock ;;
  "ai endpoint create"*) exit 0 ;;
  "ai endpoint get-by-name"*) [[ -n "${GBN_FAIL:-}" ]] && exit 1; echo aiendpoint-e00mock ;;
  "ai endpoint get "*)
    grep -q "^ENDPOINT_ID=aiendpoint-e00mock$" "${RESULTS_DIR}/serverless-endpoint.state" 2>/dev/null && echo STATE_PRESENT >> "$LOG"
    n=$(( $(cat "$LOG.polls" 2>/dev/null || echo 0) + 1 )); echo "${n}" > "$LOG.polls"
    (( n < 3 )) && exit 1
    echo "{\"status\":{\"public_endpoints\":[\"https://ep.invalid\"]}}" ;;
  *) exit 1 ;;
esac'

test_name=endpoint-create-needs-confirm
set +e; env -u CONFIRM "${ep}" create >/dev/null 2>"${work}/err"; rc=$?; set -e
[[ "${rc}" -eq 2 ]] || fail "create without CONFIRM=yes must exit 2 (got ${rc})"
grep -q 'ai endpoint create' "${LOG}" && fail "create without CONFIRM=yes reached the API"
grep -q 'CONFIRM=yes' "${work}/err" || fail "the refusal must say CONFIRM=yes"
ok "no spend without CONFIRM=yes"

test_name=endpoint-create-records-id-and-tolerates-polling-errors
: > "${LOG}"
NEBIUS_REGION=eu-north1 CONFIRM=yes "${ep}" create >/dev/null 2>"${work}/err" || fail "create failed: $(cat "${work}/err")"
grep -q STATE_PRESENT "${LOG}" || fail "the endpoint id must be in the state file before polling starts"
grep -q '^ENDPOINT_URL=https://ep.invalid$' "${state}" || fail "state file lacks the URL"
grep -q '^ENDPOINT_REGION=eu-north1$' "${state}" || fail "state file lacks the region the endpoint was created in"
jq -e '.details.region=="eu-north1"' "${RESULTS_DIR}/serverless-endpoint-create.json" >/dev/null || fail "create result lacks the region"
grep '^curl ' "${LOG}" | grep -q ep-token-sentinel && fail "the endpoint token appeared in curl's argv"
ok "id recorded first, two failed polls tolerated, token kept out of argv"

test_name=endpoint-measure-keeps-token-out-of-argv
: > "${LOG}"
"${ep}" measure >/dev/null 2>&1 || fail "measure failed"
grep -E '^(curl|docker) ' "${LOG}" | grep -q ep-token-sentinel && fail "the token appeared in curl or docker argv"
grep '^docker ' "${LOG}" | grep -q -- '-e OPENAI_API_KEY ' || fail "docker must take OPENAI_API_KEY by name (-e OPENAI_API_KEY)"
grep -q 'OPENAI_API_KEY=ep-token-sentinel' "${LOG}" || fail "docker must still receive the token through its environment"
ok "token passed by environment and header file"
test_name=endpoint-measure-r1-shape
jq -e '.status=="pass" and .details.schema=="nip-bench/1" and .details.target=="r6" and .details.vantage=="operator-host"
  and .details.first_request_ms==100 and .details.response=="OK" and ([.details.points[].concurrency]==[1,8,32])
  and .details.cold_start.first_request_ms==100 and (.details.cold_start.first_request_source|test("probe"))
  and .details.endpoint_region=="eu-north1" and .details.generator_region==null' \
  "${RESULTS_DIR}/serverless-endpoint-measure.json" >/dev/null || fail "measure result: $(cat "${RESULTS_DIR}/serverless-endpoint-measure.json")"
ok "operator-host measure has the R1 shape and says where it ran"

test_name=endpoint-measure-in-region-job
: > "${LOG}"
# kubectl reaches the R1 cluster: the token goes into a Secret from a file descriptor, never argv.
stub kubectl '
case "$*" in
  "get nodes -o json") echo "{\"items\":[{\"metadata\":{\"name\":\"cpu-0\",\"labels\":{\"topology.kubernetes.io/region\":\"eu-north1\"}}}]}" ;;
  *"create secret generic vllm-bench-key"*)
    a="$*"; f="${a##*--from-env-file=}"; f="${f%% *}"; cat "$f" >> "$LOG.secret"; echo "kind: Secret" ;;
  *"apply -f -"*) in="$(cat)"; printf "%s\n" "$in" >> "$LOG.applied"
    [[ -n "${JOB_APPLY_FAIL:-}" && "$in" == *"kind: Job"* ]] && exit 1; exit 0 ;;
  *"get job vllm-bench -o json"*) echo "{\"status\":{\"conditions\":[{\"type\":\"Complete\",\"status\":\"True\"}]}}" ;;
  *"logs job/vllm-bench"*) cat "$FIXTURE" ;;
  *) exit 0 ;;
esac'
MEASURE_FROM=cluster "${ep}" measure >/dev/null 2>"${work}/err" || fail "in-region measure failed: $(cat "${work}/err")"
grep '^kubectl ' "${LOG}" | grep -q ep-token-sentinel && fail "the token appeared in kubectl's argv"
grep -q '^OPENAI_API_KEY=ep-token-sentinel$' "${LOG}.secret" || fail "the token must reach the Secret through a file"
grep -q 'namespace: nip-bench' "${LOG}.applied" || fail "the Job must run in its own namespace (nip-bench)"
grep -A1 'name: BASE_URL' "${LOG}.applied" | grep -q 'https://ep.invalid' || fail "the Job must target the endpoint URL"
grep '^docker ' "${LOG}" && fail "the in-region path must not run the generator on the operator host"
grep -q 'delete secret vllm-bench-key' "${LOG}" || fail "the token Secret must be deleted after the run"
jq -e '.status=="pass" and .details.vantage=="in-region-cluster-job" and .details.target=="r6"
  and .details.generator_region=="eu-north1" and .details.endpoint_region=="eu-north1"' \
  "${RESULTS_DIR}/serverless-endpoint-measure.json" >/dev/null || fail "in-region result: $(cat "${RESULTS_DIR}/serverless-endpoint-measure.json")"
ok "in-region Job in the R1 cluster; token by file; vantage recorded"

test_name=endpoint-measure-job-failure-still-deletes-secret
: > "${LOG}"
set +e; JOB_APPLY_FAIL=1 MEASURE_FROM=cluster "${ep}" measure >/dev/null 2>"${work}/err"; rc=$?; set -e
[[ "${rc}" -ne 0 ]] || fail "a failed Job apply must fail measure"
grep -q 'delete secret vllm-bench-key' "${LOG}" || fail "the token Secret must be deleted even when the run fails"
ok "token Secret deleted on the failure path"

test_name=endpoint-measure-host-bench-no-output
: > "${LOG}"; rm -f "${RESULTS_DIR}/serverless-endpoint-measure.json"
cp "${state}" "${work}/state.bak"
sed -i.tmp 's/^ENDPOINT_TOKEN=.*/ENDPOINT_TOKEN=/' "${state}"
set +e; "${ep}" measure >/dev/null 2>"${work}/err"; rc=$?; set -e
cp "${work}/state.bak" "${state}"
jq -e '.status=="fail" and .details.status=="fail" and (.details.error|test("bench.sh"))' "${RESULTS_DIR}/serverless-endpoint-measure.json" >/dev/null \
  || fail "a bench.sh that printed nothing must still leave a fail record: $(cat "${RESULTS_DIR}/serverless-endpoint-measure.json" 2>/dev/null) $(cat "${work}/err")"
ok "bench.sh with no output: a fail record, not a crash"

test_name=endpoint-measure-bad-shape-refused-first
# A sweep shape that cannot run is refused before the probe, kubectl or Docker, on both vantages,
# so the earlier measure evidence is not overwritten by a fail record.
for from in host cluster; do
  : > "${LOG}"; cp "${RESULTS_DIR}/serverless-endpoint-measure.json" "${work}/measure.before"
  set +e; BENCH_NUM_PROMPTS=0 MEASURE_FROM="${from}" "${ep}" measure >/dev/null 2>"${work}/err"; rc=$?; set -e
  [[ "${rc}" -eq 2 ]] || fail "${from}: a bad BENCH_* shape must exit 2 (got ${rc})"
  grep -q BENCH_NUM_PROMPTS "${work}/err" || fail "${from}: the refusal must name the input: $(cat "${work}/err")"
  grep -qE '^(curl|kubectl|docker) ' "${LOG}" && fail "${from}: a bad shape reached curl, kubectl or docker: $(cat "${LOG}")"
  cmp -s "${work}/measure.before" "${RESULTS_DIR}/serverless-endpoint-measure.json" || fail "${from}: a bad shape overwrote the measure evidence"
done
ok "a bad sweep shape is refused before any request; evidence kept"

test_name=endpoint-create-failure-prints-delete
rm -f "${state}" "${LOG}.polls"; : > "${LOG}"
set +e; GBN_FAIL=1 CONFIRM=yes "${ep}" create >/dev/null 2>"${work}/err"; rc=$?; set -e
[[ "${rc}" -ne 0 ]] || fail "a failed get-by-name must fail the create"
grep -q 'nebius ai endpoint delete' "${work}/err" || fail "a failed create must print how to delete the endpoint: $(cat "${work}/err")"
ok "a failed create prints the delete command"
