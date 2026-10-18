#!/usr/bin/env bash
# tests/validate/03-nccl.sh with NCCL_PLATFORM against a stub kubectl: the result records the
# platform's row of tests/validate/nccl-bars.tsv (docs bar and docs example, unknown where the
# docs show none); NCCL_MIN_BUSBW still wins; without NCCL_PLATFORM nothing changes (bar 300). A
# client bar in NCCL_MIN_BUSBW is applied and recorded; one that is not a positive number is refused.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step="${repo_root}/tests/validate/03-nccl.sh"
export RESULTS_DIR="${work}/results" FIXTURE="${repo_root}/tests/validate/fixtures/nccl-ib-2x8.log"
unset NCCL_MIN_BUSBW NCCL_PLATFORM
stub sleep 'exit 0'
stub kubectl '
case "$*" in
  *"get mpijob nccl-test -o json"*)
    echo "{\"spec\":{\"slotsPerWorker\":8,\"mpiReplicaSpecs\":{\"Worker\":{\"replicas\":2,\"template\":{\"spec\":{\"containers\":[{\"image\":\"img\"}]}}},\"Launcher\":{\"template\":{\"spec\":{\"containers\":[{\"args\":[\"mpirun\"]}]}}}}},\"status\":{\"conditions\":[{\"type\":\"Succeeded\",\"status\":\"True\"}]}}" ;;
  *"replica-type=worker"*) printf "node-a\nnode-b\n" ;;
  *"replica-type=launcher"*) echo launcher-0 ;;
  *"logs launcher-0"*) cat "$FIXTURE" ;;
  *"get node -o jsonpath"*) echo gpucluster-e00mock ;;
  *) exit 0 ;;
esac'
r="${RESULTS_DIR}/03-nccl-multi-node-2x8.json"

test_name=nccl-platform-bar-recorded
NCCL_PLATFORM=gpu-b300-sxm "${step}" multi-node-2x8 >/dev/null 2>"${work}/err" || fail "03-nccl failed: $(cat "${work}/err") $(cat "${r}" 2>/dev/null)"
jq -e '.status=="pass" and .details.min_bus_bandwidth_GBps==300 and .details.platform_bar.platform=="gpu-b300-sxm"
  and .details.platform_bar.docs_example_avg_busbw_GBps==null and (.details.platform_bar.example_source|test("unknown"))
  and (.details.bar_source|test("nccl-bars.tsv"))' "${r}" >/dev/null \
  || fail "result: $(jq -c .details "${r}")"
ok "platform row recorded; bar 300 from the table"

test_name=nccl-explicit-bar-wins
set +e; NCCL_PLATFORM=gpu-h100-sxm NCCL_MIN_BUSBW=900 "${step}" multi-node-2x8 >/dev/null 2>&1; rc=$?; set -e
[[ "${rc}" -ne 0 ]] || fail "NCCL_MIN_BUSBW=900 must fail the fixture's busbw"
jq -e '.details.min_bus_bandwidth_GBps==900 and .details.platform_bar.min_busbw_GBps==300 and (.details.bar_source|test("NCCL_MIN_BUSBW"))' "${r}" >/dev/null || fail "result: $(jq -c .details "${r}")"
ok "NCCL_MIN_BUSBW overrides the table"

test_name=nccl-no-platform-unchanged
"${step}" multi-node-2x8 >/dev/null 2>&1 || fail "03-nccl without NCCL_PLATFORM failed: $(jq -c .details "${r}")"
jq -e '.details.min_bus_bandwidth_GBps==300 and .details.platform_bar==null and (.details.bar_source|test("general"))' "${r}" >/dev/null || fail "result: $(jq -c .details "${r}")"
ok "no NCCL_PLATFORM: default bar, no platform row"

test_name=nccl-unlisted-platform-says-general-bar
NCCL_PLATFORM=gpu-l40s-a "${step}" multi-node-2x8 >/dev/null 2>&1 || fail "03-nccl failed: $(jq -c .details "${r}")"
jq -e '.details.min_bus_bandwidth_GBps==300 and .details.platform_bar.min_busbw_GBps==null
  and (.details.bar_source|test("general")) and (.details.bar_source|test("gpu-l40s-a"))' "${r}" >/dev/null \
  || fail "an unlisted platform must say the general bar was applied: $(jq -c .details "${r}")"
ok "unlisted platform: the result says the general 300 GB/s bar was applied"

# NCCL_MIN_BUSBW is the input for a client's own bar (F6.1): applied and recorded, and refused
# before the MPIJob is applied when it is not a positive number.
test_name=nccl-bar-client
set +e; NCCL_MIN_BUSBW=350 "${step}" multi-node-2x8 >/dev/null 2>&1; rc=$?; set -e
[[ "${rc}" -ne 0 ]] || fail "309.29 GB/s must fail a 350 GB/s bar"
jq -e '.status=="fail" and .details.min_bus_bandwidth_GBps==350' "${r}" >/dev/null \
  || fail "the client bar and the failure must be recorded: $(jq -c .details "${r}")"
NCCL_MIN_BUSBW=250.5 "${step}" multi-node-2x8 >/dev/null 2>&1 || fail "a decimal bar below the measured value passes: $(jq -c .details "${r}")"
jq -e '.details.min_bus_bandwidth_GBps==250.5' "${r}" >/dev/null || fail "the decimal bar must be recorded: $(jq -c .details "${r}")"
ok "a client bar is applied and recorded"

test_name=nccl-bar-refused
for bad in abc 300GB -1 0; do
  : > "${LOG}"
  set +e; NCCL_MIN_BUSBW="${bad}" "${step}" multi-node-2x8 >/dev/null 2>"${work}/err"; rc=$?; set -e
  [[ "${rc}" -eq 2 ]] || fail "NCCL_MIN_BUSBW=${bad} must exit 2 (got ${rc})"
  grep -q NCCL_MIN_BUSBW "${work}/err" || fail "the refusal names NCCL_MIN_BUSBW"
  grep -q 'apply' "${LOG}" && fail "NCCL_MIN_BUSBW=${bad}: refused only after the MPIJob was applied"
done
ok "a bar that is not a positive number is refused before anything is applied"
