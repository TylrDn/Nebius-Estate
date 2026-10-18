#!/usr/bin/env bash
# R1-ONLY session in ONE command: R1 on PROFILE=l40s-gpu-only with its OWN 64 GiB filestore (no R8
# filesystem, no R12 node service account: terraform/stacks/inference creates the filestore when
# existing_filesystem_id is null, and runs nodes without a service account when node_service_account_id
# is null), Alertmanager on and the Grafana data-source token Secret named. Hands-off after the first minute.
#   bash scripts/live/run-r1.sh                (in a terminal; tmux: runbooks/live-session.md)
#   R10_TOO=1 bash scripts/live/run-r1.sh      (then run 3, the R10 GPU VM bench, after R1 is torn down)
#   R5=0 bash scripts/live/run-r1.sh           (leave R5, SkyPilot on the R1 node, out)
# Asks once, at the start ("yes"; ASSUME_YES=1 answers it, under the usual banner). Then, unattended:
# preflight (inference only), re-price (R1 alone: GPU node, boot disk, its own filestore), R1 plan +
# TTL job armed BEFORE the apply + apply, GPU layers 00-02 and the vLLM overlay, headroom, 03-storage
# (on R1's own filestore) + 04-workload, 05-load (the 1/8/32 sweep with its pass bars, priced with the
# re-price's gpu-node line), R14 acceptance (Grafana data sources with the token Secret when .env has
# PROMETHEUS_TOKEN, else run anyway and report the cause class; rules; test alert), R5 (default on),
# evidence, teardown of R1, [R10_TOO=1: run3-2 plan, run3-3 TTL + apply, run3-4 bench, run3-5 teardown],
# the stage leftovers gate, evidence again.
# Rules (as run2-all.sh): an apply failing goes straight to teardown (its TTL job stays armed); a check
# failing is recorded and the batch carries on; 00/01 failing skips the vLLM steps BY NAME; a failed
# teardown stops the batch and says to run abort.sh (R10 never starts after a failed R1 teardown).
# Exit 0: every step passed and the leftovers gate is clean; 3: torn down and clean, but a check
# failed or was skipped; 1: a teardown or the leftovers gate failed (things may bill: abort.sh).
# The session mode (state/run2.env SESSION_MODE=r1-only) is set by step 0 and read by every later
# step, so a step re-run by hand behaves the same; RESET_SESSION=1 bash run2-0-preflight.sh clears it.
set -uo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
live_dir_check run-r1
need_tty
D="${LIVE_DIR}"
R10_TOO="${R10_TOO:-0}" R5="${R5:-1}"
[[ "${R10_TOO}" == 0 || "${R10_TOO}" == 1 ]] || { say "STOP: R10_TOO must be 0 or 1 (got '${R10_TOO}'); nothing was started"; exit 1; }
[[ "${R5}" == 0 || "${R5}" == 1 ]] || { say "STOP: R5 must be 0 or 1 (got '${R5}'); nothing was started"; exit 1; }
mkdir -p "${LOG_DIR}"; chmod 700 "${LIVE_HOME}" "${LOG_DIR}"
summary="${LOG_DIR}/run-r1-$(date -u +%Y%m%dT%H%M%SZ).summary"
cd "${REPO}"

cat <<EOF
------------------------------------------------------------------------------
R1-only session, one command: R1 (1 preemptible L40S, its own 64 GiB filestore, Alertmanager) with
GPU layers, vLLM, storage, workload and the 05-load sweep; R14$( (( R5 )) && echo ", R5")$( (( R10_TOO )) && echo "; then R10 (run 3)").
Teardown and the leftovers gate always run. About 2 h$( (( R10_TOO )) && echo " + about 40 min for R10"), unattended after this minute.
Cost (estimates, prices of 2026-10-12: preemptible L40S \$0.7492/h + 512 GiB disk \$0.0498/h + 64 GiB
filestore ~\$0.007/h): about \$1.61 for 2 h, at most about \$2.42 at R1's 3 h TTL$( (( R10_TOO )) && echo "; R10 \$0.22 to \$1.54 more").
R14 data sources: PROMETHEUS_TOKEN from .env (an OBSERVABILITY static key) when set; never printed.
------------------------------------------------------------------------------
EOF
if [[ "${ASSUME_YES}" == 1 ]]; then
  say "!!! ASSUME_YES=1 IS SET: the whole session starts without asking. Ctrl-C now (5 s) to stop."
  sleep 5
else
  read -r -p "Start the R1-only session now? Type yes to continue: " a
  [[ "${a}" == yes ]] || { say "not confirmed: nothing was started"; exit 1; }
fi
export ASSUME_YES=1 R1_ONLY=1
export NIP_RUN="${NIP_RUN:-live-$(date -u +%Y%m%d)-r1}"
R10_RUN="${NIP_RUN_R10:-live-$(date -u +%Y%m%d)-run3}"
say "Started $(date '+%H:%M %Z'). You can detach now (tmux: Ctrl-b then d); progress: tail -f ${summary}"

failed=0
# step <script> [VAR=value ...]: run one step script (its own log in logs/), one line in the summary.
step() {
  local s="$1" t0 rc=0; shift
  t0=$(date +%s); printf '%s  %-30s ' "$(date '+%H:%M')" "$s" | tee -a "${summary}"
  env "$@" bash "${D}/$s.sh" >/dev/null 2>&1 || rc=$?
  printf '%s (%d min)\n' "$([[ ${rc} == 0 ]] && echo PASS || echo "FAIL rc=${rc}")" $(( ($(date +%s) - t0) / 60 )) | tee -a "${summary}"
  return "${rc}"
}
skip() { printf '%s  %-30s SKIPPED: %s\n' "$(date '+%H:%M')" "$1" "$2" | tee -a "${summary}"; failed=1; }
left_out() { printf '%s  %-30s NOT RUN: %s\n' "$(date '+%H:%M')" "$1" "$2" | tee -a "${summary}"; }
note() { say "  -> $*" | tee -a "${summary}"; }
check() { step "$@" || { failed=1; note "check failed; carrying on (its log: ${LOG_DIR}/$1-*.log)"; }; }
state_get() { ( state_load run2; printf '%s' "${!1:-}" ); }
teardown_failed() {
  say "TEARDOWN FAILED: resources may still bill. Run now:  bash ${D}/abort.sh   (logs: ${LOG_DIR}/$1-*.log)" | tee -a "${summary}"
  exit 1
}

ok=1
for s in run2-0-preflight run2-1-reprice run2-2c-inference; do
  step "$s" || { ok=0; failed=1; note "an apply step failed: no further steps on R1; going to teardown (its log: ${LOG_DIR}/$s-*.log)"; break; }
done
if (( ok )); then
  check run2-3a-validate-gpu
  note "GPU layers: 00-nodes $(state_get GPU_L00) / 01-gpu $(state_get GPU_L01) / 02-interconnect $(state_get GPU_L02); vLLM deployed: $([[ "$(state_get VLLM_DEPLOYED)" == 1 ]] && echo yes || echo NO)"
  if [[ "$(state_get VLLM_DEPLOYED)" == 1 ]]; then
    [[ "$(state_get GPU_L02)" == pass ]] || { failed=1; note "02-interconnect did not pass (recorded); vLLM was deployed anyway"; }
    check run2-3b-headroom
    check run2-3c-storage-workload
    check run2-3d-load
  else
    why="step 3a did not deploy vLLM (00-nodes $(state_get GPU_L00), 01-gpu $(state_get GPU_L01); see its log)"
    skip run2-3b-headroom "${why}"
    check run2-3c-storage-workload NO_WORKLOAD=1
    skip run2-3d-load "${why}"
  fi
  check run2-6-r14-acceptance
  note "R14: token Secret $(state_get R14_TOKEN); cause classes: $(c="$(state_get R14_CAUSES)"; printf '%s' "${c:-none}")"
  if (( R5 )); then check run2-7-r5; else left_out run2-7-r5 "R5=0 (left out on purpose)"; fi
fi
step run2-9-evidence || true
step run2-10-teardown || teardown_failed run2-10-teardown

if (( R10_TOO )); then
  r10=1
  for s in run3-2-plan run3-3-apply; do
    step "$s" NIP_RUN="${R10_RUN}" || { r10=0; failed=1; note "R10 ${s} failed: no bench; going to the R10 teardown"; break; }
  done
  if (( r10 )); then check run3-4-bench; fi
  step run3-5-teardown || teardown_failed run3-5-teardown
fi

gate=0; step run2-11-leftovers || { gate=1; note "leftovers gate failed: see ${LOG_DIR}/run2-11-leftovers-*.log before anything else"; }
step run2-9-evidence || true
if (( gate )); then verdict="FAIL: the leftovers gate is not clean (something may bill)"; rc=1
elif (( failed )); then verdict="PARTIAL: torn down and clean, but a step failed or was skipped (above)"; rc=3
else verdict="PASS: every step passed; torn down; leftovers gate clean"; rc=0; fi
say "Done $(date '+%H:%M %Z'). VERDICT: ${verdict}. Summary: ${summary}" | tee -a "${summary}"
exit "${rc}"
