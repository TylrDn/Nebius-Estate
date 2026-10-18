#!/usr/bin/env bash
# Run 2 step 3 (part c): tests/validate/03-storage.sh (if it fails ONLY on the rate bar
# DATA_MIN_MIBPS, rerun with DATA_MIN_MIBPS=0, which records the rate without a bar; any other
# failure stops), then tests/validate/04-workload.sh.
# Executed: bash run2-3c-storage-workload.sh   ONLY_WORKLOAD=1 reruns 04 alone (after vLLM changed);
# NO_WORKLOAD=1 runs 03 alone (run2-all.sh, when step 3a did not deploy vLLM: R8's fio baseline,
# which step 4 needs, does not depend on vLLM).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-3c-storage-workload
header "Run 2 step 3c - 03-storage and 04-workload" \
  "fio on the shared filesystem's virtiofs mount (R8's in run 2, R1's own 64 GiB filestore in an R1-only session; write then read, 4 jobs), PVC Bound; then the vLLM workload check (cold start, first request)" \
  "\$0 extra" "about 5-10 min" "the RESULT block (03 status + MiB/s + bar, 04 status)"
need kubectl jq
check_repo
load_env
state_load run2
kube_env

[[ "${ONLY_WORKLOAD:-0}" != 1 || "${NO_WORKLOAD:-0}" != 1 ]] || die "ONLY_WORKLOAD=1 and NO_WORKLOAD=1 exclude each other"
if [[ "${ONLY_WORKLOAD:-0}" != 1 ]]; then
  rc=0; run tests/validate/03-storage.sh || rc=$?
  if (( rc != 0 )); then
    # Rate-only: every check passed except write/read >= min_MiBps.
    if jq -e '.details | .all_nodes_virtiofs == true and (.storage_class // "") != "" and (.pvc_phase == "Bound")
              and .fio_errors == 0 and .write_MiBps > 0 and .read_MiBps > 0
              and (.write_MiBps < .min_MiBps or .read_MiBps < .min_MiBps)' results/03-storage.json >/dev/null 2>&1; then
      say "03-storage failed only on the rate bar ($(jq -r '.details | "write \(.write_MiBps) read \(.read_MiBps) < \(.min_MiBps) MiB/s"' results/03-storage.json)); recording the rate without a bar"
      state_set run2 STORAGE_RATE_ONLY_FAIL 1
      DATA_MIN_MIBPS=0 run tests/validate/03-storage.sh
    else
      die "03-storage failed on something other than the rate (see results/03-storage.json): fix that layer first"
    fi
  fi
fi
if [[ "${NO_WORKLOAD:-0}" != 1 ]]; then run tests/validate/04-workload.sh; fi

result_begin
jq -r '"  03-storage: \(.status) write=\(.details.write_MiBps) read=\(.details.read_MiBps) MiB/s bar=\(.details.min_MiBps) pvc=\(.details.pvc_phase) virtiofs=\(.details.all_nodes_virtiofs)"' results/03-storage.json
if [[ "${NO_WORKLOAD:-0}" == 1 ]]; then say "  04-workload: NOT RUN (NO_WORKLOAD=1: vLLM is not deployed)"
else jq -r '"  04-workload: \(.status) model=\(.details.model // "?") image=\(.details.image // "?")"' results/04-workload.json; fi
say "  baseline for step 4: results/03-storage-fio.json"
state_load run2
if [[ "${F31_BLOCKED:-0}" == 1 ]]; then say "next: F3.1 blocked; bash ${LIVE_DIR}/run2-4-r8-acceptance.sh"; else say "next: bash ${LIVE_DIR}/run2-3d-load.sh"; fi
