#!/usr/bin/env bash
# Run 2 in ONE command: the reviewed step scripts in plan order, hands-off after the first minute.
#   bash scripts/live/run2-all.sh        (in a terminal; tmux is the way to leave it: runbooks/live-session.md)
# Asks once, at the start: "yes" to the whole session (ASSUME_YES=1 answers it, under the usual
# banner), and the R12 passwords only if .env lacks R12_MLFLOW_ADMIN_PASSWORD / R12_POSTGRESQL_PASSWORD
# (with ASSUME_YES=1 they must be in .env). Then, unattended (~4 h): preflight, re-price, R8 data, R12
# ml-services, R1 inference (L40S), TTL re-arm, GPU validation, headroom, storage + workload, load
# sweep, R8 / R12 / R14 / R5 acceptance, evidence bundle, teardown (R1, R12, R8), leftovers gate.
# R6 (optional, about $1.57/h while it exists) and F6.1 are not run.
# Rules:
#   - an apply step failing (0 to 2d) STOPS the applies: whatever was applied keeps its TTL job, and
#     the batch goes straight to teardown;
#   - a check failing (3a to 7) is recorded and the batch carries on, so one failed check never leaves
#     the cluster billing; teardown always runs;
#   - step 3a: 00-nodes or 01-gpu failing means vLLM is NOT deployed. The batch says so and SKIPS, by
#     name, the steps that need vLLM (3b headroom, 3d load); 3c then runs 03-storage only
#     (NO_WORKLOAD=1), because step 4's R8 baseline does not need vLLM. A failed 02-interconnect does
#     not stop vLLM: 3a records it and the batch prints it. Nothing is retried: rerun the step by hand
#     while R1 is up if the cause was fixed (runbooks/live-session.md "Re-running a check").
#   - if teardown fails, the batch stops and says so: run  bash scripts/live/abort.sh
# Each step keeps its own log and RESULT block in .cache/live/logs/; this prints one line per step
# and a verdict at the end. Exit 0: every step passed and the leftovers gate is clean; 3: teardown and
# leftovers clean but a check failed or was skipped; 1: teardown or the leftovers gate failed (things
# may bill: abort.sh). Safe to leave: every applied root has a TTL safety net armed before its apply.
# The passwords reach the steps in R12_BATCH_* (environment of the step processes only); lib.sh stops
# exporting them at once, so no make target or TTL job inherits them.
set -uo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
live_dir_check run2-all
need_tty
D="${LIVE_DIR}"
mkdir -p "${LOG_DIR}"; chmod 700 "${LIVE_HOME}" "${LOG_DIR}"
summary="${LOG_DIR}/run2-all-$(date -u +%Y%m%dT%H%M%SZ).summary"
cd "${REPO}"

cat <<'EOF'
------------------------------------------------------------------------------
Run 2, one command: R8 + R12 + R1 (1 preemptible L40S) with benchmarks and R8/R12/R14/R5 checks,
then teardown and the leftovers gate. About 4 h, unattended after this minute.
Cost: about $2.91 for 2 h of resources, at most about $5.04 if everything ran to its TTL
(plan estimate, prices of 2026-10-11).
R12 passwords: read from .env when set (R12_MLFLOW_ADMIN_PASSWORD, R12_POSTGRESQL_PASSWORD), else asked
here once. They are never printed.
------------------------------------------------------------------------------
EOF
if [[ "${ASSUME_YES}" == 1 ]]; then
  say "!!! ASSUME_YES=1 IS SET: the whole session starts without asking. Ctrl-C now (5 s) to stop."
  sleep 5
else
  read -r -p "Start the whole session now? Type yes to continue: " a
  [[ "${a}" == yes ]] || { say "not confirmed: nothing was started"; exit 1; }
fi
ask_pw() { local a b; read -rs -p "$1 (input hidden): " a; echo; read -rs -p "$1 again: " b; echo
  [[ -n "${a}" && "${a}" == "${b}" ]] || { say "STOP: $1 empty or the two entries differ; nothing was started"; exit 1; }
  printf -v "$2" '%s' "${a}"; }
R12_BATCH_MLFLOW_PW="$(env_get R12_MLFLOW_ADMIN_PASSWORD)"; R12_BATCH_PG_PW="$(env_get R12_POSTGRESQL_PASSWORD)"
if [[ -n "${R12_BATCH_MLFLOW_PW}" && -n "${R12_BATCH_PG_PW}" ]]; then say "R12 passwords: read from .env"
elif [[ "${ASSUME_YES}" == 1 ]]; then say "STOP: ASSUME_YES=1 needs R12_MLFLOW_ADMIN_PASSWORD and R12_POSTGRESQL_PASSWORD in .env; nothing was started"; exit 1
else ask_pw "MLflow admin password" R12_BATCH_MLFLOW_PW; ask_pw "PostgreSQL password" R12_BATCH_PG_PW; fi
if ! why="$(r12_pw_problem "${R12_BATCH_MLFLOW_PW}" "${R12_BATCH_PG_PW}")"; then say "STOP: ${why}; nothing was started"; exit 1; fi
export R12_BATCH_MLFLOW_PW R12_BATCH_PG_PW ASSUME_YES=1
export NIP_RUN="${NIP_RUN:-live-$(date -u +%Y%m%d)-run2}"
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
note() { say "  -> $*" | tee -a "${summary}"; }
check() { step "$@" || { failed=1; note "check failed; carrying on (its log: ${LOG_DIR}/$1-*.log)"; }; }
# state_get <key>: one value of state/run2.env, read in a subshell (this shell's variables stay as they are).
state_get() { ( state_load run2; printf '%s' "${!1:-}" ); }

ok=1
for s in run2-0-preflight run2-1-reprice run2-2a-data run2-2b-ml-services run2-2c-inference run2-2d-rearm; do
  step "$s" || { ok=0; failed=1; note "an apply step failed: no further applies; going to teardown (its log: ${LOG_DIR}/$s-*.log)"; break; }
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
  for s in run2-4-r8-acceptance run2-5-r12-acceptance run2-6-r14-acceptance run2-7-r5; do check "$s"; done
fi
step run2-9-evidence || true
if ! step run2-10-teardown; then
  say "TEARDOWN FAILED: resources may still bill. Run now:  bash ${D}/abort.sh   (logs: ${LOG_DIR}/run2-10-teardown-*.log)" | tee -a "${summary}"
  unset R12_BATCH_MLFLOW_PW R12_BATCH_PG_PW; exit 1
fi
gate=0; step run2-11-leftovers || { gate=1; note "leftovers gate failed: see ${LOG_DIR}/run2-11-leftovers-*.log before anything else"; }
step run2-9-evidence || true
unset R12_BATCH_MLFLOW_PW R12_BATCH_PG_PW
if (( gate )); then verdict="FAIL: the leftovers gate is not clean (something may bill)"; rc=1
elif (( failed )); then verdict="PARTIAL: torn down and clean, but a step failed or was skipped (above)"; rc=3
else verdict="PASS: every step passed; torn down; leftovers gate clean"; rc=0; fi
say "Done $(date '+%H:%M %Z'). VERDICT: ${verdict}. Summary: ${summary}" | tee -a "${summary}"
exit "${rc}"
