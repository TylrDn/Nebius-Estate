#!/usr/bin/env bash
# tests/validate/ddp.sh against a stub kubectl: it runs workloads/training/ddp, waits for the
# PyTorchJob, and records the rank-0 samples/s as results/ddp.json; a job that never printed its
# summary, failed, or fell under DDP_MIN_SAMPLES_PER_S is a failed step with its details kept.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step="${repo_root}/tests/validate/ddp.sh"
export RESULTS_DIR="${work}/results" DDP_POLL_INTERVAL=0 FIXTURE="${repo_root}/tests/validate/fixtures/ddp-2x8.log" PHASE=Succeeded
unset DDP_MIN_SAMPLES_PER_S
stub kubectl '
case "$*" in
  *"get pytorchjob ddp-sanity -o json"*) echo "{\"status\":{\"conditions\":[{\"type\":\"Created\",\"status\":\"True\"},{\"type\":\"${PHASE}\",\"status\":\"True\"}]}}" ;;
  *"logs"*"replica-type=master"*) cat "$FIXTURE" ;;
  *) exit 0 ;;
esac'
r="${RESULTS_DIR}/ddp.json"

test_name=ddp-records-samples-per-s
"${step}" >/dev/null 2>"${work}/err" || fail "ddp.sh failed: $(cat "${work}/err")"
grep -q 'apply -k .*workloads/training/ddp' "${LOG}" || fail "ddp.sh must apply workloads/training/ddp"
jq -e '.step=="ddp" and .status=="pass" and .details.samples_per_s==81920 and .details.world_size==16
  and .details.phase=="Succeeded" and .details.min_samples_per_s==null and .details.transport=="ib"' "${r}" >/dev/null || fail "ddp.json: $(cat "${r}")"
ok "samples/s recorded"

test_name=ddp-bar-fails
set +e; DDP_MIN_SAMPLES_PER_S=100000 "${step}" >/dev/null 2>&1; rc=$?; set -e
[[ "${rc}" -ne 0 ]] || fail "below DDP_MIN_SAMPLES_PER_S must fail"
jq -e '.status=="fail" and .details.min_samples_per_s==100000 and .details.samples_per_s==81920' "${r}" >/dev/null || fail "ddp.json: $(cat "${r}")"
ok "bar applied, details kept"

test_name=ddp-no-summary-fails
set +e; FIXTURE="${repo_root}/tests/validate/fixtures/ddp-no-summary.log" PHASE=Failed "${step}" >/dev/null 2>&1; rc=$?; set -e
[[ "${rc}" -ne 0 ]] || fail "a failed job without a summary must fail"
jq -e '.status=="fail" and .details.found==false and .details.phase=="Failed"' "${r}" >/dev/null || fail "ddp.json: $(cat "${r}")"
ok "failed job recorded as fail"
