#!/usr/bin/env bash
# tests/validate/03-storage.sh (R8 filesystem throughput): fio measures sequential write AND read
# with parallel jobs on the mount, and the step passes only when both clear DATA_MIN_MIBPS
# (default 450). The fio JSON fixtures are the format of a fio 3.13 run on a laptop, not a Nebius
# measurement. kubectl is a stub: no cluster.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fixtures="${repo_root}/tests/validate/fixtures"
stub kubectl '
case "$*" in
  "get nodes -o jsonpath="*) echo "node-a node-b" ;;
  "debug node/"*) echo "fs-data /mnt/data virtiofs rw,relatime 0 0" ;;
  "get pods -o name") ;;
  "get sc csi-mounted-fs-path-sc -o json") echo "{\"metadata\":{\"name\":\"csi-mounted-fs-path-sc\"},\"volumeBindingMode\":\"${SC_BINDING:-WaitForFirstConsumer}\"}" ;;
  "-n inference get pvc model-cache --ignore-not-found -o jsonpath="*)
    case "${PVC_STATE:-Bound}" in missing) ;; error) echo "forbidden" >&2; exit 1 ;; *) echo "model-cache ${PVC_STATE:-Bound}" ;; esac ;;
  "delete pod nip-fio"*) ;;
  "run nip-fio "*) cat "${FIO_FIXTURE}" ;;
  "config current-context") echo mock ;;
  *) exit 1 ;;
esac'
export RESULTS_DIR="${work}/results"
step() { # <fixture> [env...]: run 03-storage.sh, print its exit code
  local fx="$1"; shift
  set +e; env FIO_FIXTURE="${fixtures}/${fx}" "$@" bash "${repo_root}/tests/validate/03-storage.sh" >"${work}/out" 2>&1; echo $?; set -e
}
result() { jq -r "$1" "${RESULTS_DIR}/03-storage.json"; }

test_name=storage-fio-read-write-parallel
rc="$(step fio-rw-4jobs.json)"
[[ "${rc}" == 0 ]] || { cat "${work}/out" >&2; fail "a fast filesystem must pass at the default bar (rc ${rc})"; }
run_line="$(grep '^kubectl run nip-fio ' "${LOG}")" || fail "fio was not run"
for a in '--rw=write' '--rw=read' '--numjobs=4' '--direct=1' '--group_reporting' '--stonewall'; do
  grep -qF -- "\"${a}\"" <<<"${run_line}" || fail "fio arguments lack ${a}"
done
[[ "$(result '.details.write_MiBps')" == 618 && "$(result '.details.read_MiBps')" == 1219 ]] \
  || fail "write/read MiB/s parsed wrongly: $(result '.details')"
[[ "$(result '.details.min_MiBps')" == 450 && "$(result '.details.numjobs')" == 4 ]] || fail "bar or jobs not recorded: $(result '.details')"
ok "fio writes then reads with 4 parallel jobs; both rates recorded against the 450 MiB/s default"

test_name=storage-fio-jobs-input
rc="$(step fio-rw-4jobs.json DATA_FIO_JOBS=8 DATA_FIO_SIZE=4G)"
[[ "${rc}" == 0 ]] || fail "rc ${rc}"
grep '^kubectl run nip-fio ' "${LOG}" | tail -1 | grep -qF '"--numjobs=8"' || fail "DATA_FIO_JOBS not passed to fio"
grep '^kubectl run nip-fio ' "${LOG}" | tail -1 | grep -qF '"--size=4G"' || fail "DATA_FIO_SIZE not passed to fio"
ok "DATA_FIO_JOBS and DATA_FIO_SIZE reach fio"

test_name=storage-fio-bar
rc="$(step fio-rw-4jobs.json DATA_MIN_MIBPS=1000)"
[[ "${rc}" != 0 && "$(result .status)" == fail ]] || fail "write 618 MiB/s must fail a 1000 MiB/s bar (rc ${rc})"
rc="$(step fio-rw-slow.json)"
[[ "${rc}" != 0 && "$(result .status)" == fail ]] || fail "a slow filesystem must fail the default bar (rc ${rc})"
# A failed step keeps its measurements: the ERR trap must not replace them with "command failed".
[[ "$(result .details.write_MiBps)" == 30 && "$(result .details.read_MiBps)" == 60 && "$(result .details.error)" == null ]] \
  || fail "the fail record lost its numbers: $(result .details)"
rc="$(step fio-rw-slow.json DATA_MIN_MIBPS=0)"
[[ "${rc}" == 0 ]] || fail "DATA_MIN_MIBPS=0 records without a bar (rc ${rc})"
ok "the bar fails a slow read or write; 0 records only"

test_name=storage-fio-error
rc="$(step fio-rw-read-error.json DATA_MIN_MIBPS=0)"
[[ "${rc}" != 0 && "$(result .details.fio_errors)" == 5 ]] || fail "a fio job error must fail the step (rc ${rc})"
ok "a fio job error fails the step"

# 2026-10-12 (R1 on gpu-l40s-a): fio passed (write 2066, read 1757 MiB/s against 450) but the step
# failed only because the vLLM overlay had not created PVC model-cache yet (pvc_phase none). The PVC
# belongs to the workload: missing is not applicable to the storage verdict, and says so.
test_name=storage-pvc-missing-not-applicable
rc="$(step fio-rw-4jobs.json PVC_STATE=missing)"
[[ "${rc}" == 0 && "$(result .status)" == pass ]] || { cat "${work}/out" >&2; fail "a missing workload PVC must not fail a storage pass (rc ${rc})"; }
[[ "$(result .details.storage_verdict)" == pass && "$(result .details.pvc_check.status)" == not-applicable \
   && "$(result .details.pvc_phase)" == missing ]] || fail "the PVC is reported missing and not applicable: $(result .details)"
result .details.pvc_check.reason | grep -q 'workloads/inference' || fail "the reason names what creates the PVC: $(result .details.pvc_check)"
ok "a missing model-cache PVC is not-applicable with a reason; the storage pass stands"

test_name=storage-pvc-pending-fails
# The chart's csi-mounted-fs-path-sc binds on first consumer by default (docs
# kubernetes/storage/filesystem-over-csi): Pending with no pod is expected there, a failure only on Immediate.
rc="$(step fio-rw-4jobs.json PVC_STATE=Pending)"
[[ "${rc}" == 0 && "$(result .details.pvc_check.status)" == not-applicable ]] \
  || fail "a Pending PVC on a WaitForFirstConsumer class waits for its pod, not a failure (rc ${rc}): $(result .details)"
rc="$(step fio-rw-4jobs.json PVC_STATE=Pending SC_BINDING=Immediate)"
[[ "${rc}" != 0 && "$(result .status)" == fail && "$(result .details.storage_verdict)" == pass && "$(result .details.pvc_check.status)" == fail ]] \
  || fail "a Pending PVC on an Immediate class is a provisioning failure (rc ${rc}): $(result .details)"
rc="$(step fio-rw-4jobs.json PVC_STATE=Lost)"
[[ "${rc}" != 0 && "$(result .details.pvc_check.status)" == fail ]] || fail "a Lost PVC fails (rc ${rc})"
rc="$(step fio-rw-4jobs.json PVC_STATE=error)"
[[ "${rc}" != 0 && "$(result .details.pvc_check.status)" == fail && "$(result .details.pvc_phase)" == unknown ]] \
  || fail "a PVC that cannot be read is not reported missing (rc ${rc}): $(result .details)"
ok "Pending waits for its pod on WaitForFirstConsumer and fails on Immediate; Lost or unreadable fails; the storage verdict is reported apart"

test_name=storage-verdict-separate
rc="$(step fio-rw-slow.json PVC_STATE=missing)"
[[ "${rc}" != 0 && "$(result .details.storage_verdict)" == fail && "$(result .details.pvc_check.status)" == not-applicable ]] \
  || fail "a slow filesystem still fails when the PVC is not applicable (rc ${rc}): $(result .details)"
rc="$(step fio-rw-4jobs.json PVC_NAME=)"
[[ "${rc}" == 0 && "$(result .details.pvc_check.status)" == skipped && "$(result .details.pvc_phase)" == skipped ]] || fail "PVC_NAME= skips the PVC (rc ${rc})"
ok "the storage verdict fails on its own measurements; PVC_NAME= skips the PVC"
