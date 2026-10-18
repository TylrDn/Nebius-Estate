#!/usr/bin/env bash
# Run 2 step 2d: replace the provisional data and ml-services TTL jobs (or Z5's data job) with the
# final one at R1's nip-ttl-expires + 30 min, so a TTL teardown never removes the filesystem or the
# node service account under a running cluster. Per stack: bootstrap, DRY=1 (never touches the pid
# file, so a refusal leaves the old job armed), ttl_cancel (must return 0), CONFIRM=yes. Between the
# cancel and the re-arm, FAIL_HINT says which stack has no TTL job. The jobs inherit this script's
# token, state key and labels. That token is the CLI's cached one: before each cancel the step
# refuses unless it lives until LATE + 60 min (token_guard; fix: bash refresh-login.sh, then rerun).
# Executed: bash run2-2d-rearm.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-2d-rearm
header "Run 2 step 2d - final TTL jobs for data and ml-services" \
  "R1_EXP from .run-profile.tfvars.json, LATE = R1_EXP + 30 min (checked), cancel + re-arm data and ml-services at LATE" \
  "\$0 (schedules only)" "about 2 min (two bootstraps)" "the RESULT block (R1_EXP, LATE, both pids)"
need make jq terraform nebius python3
check_repo
load_env
state_load run2
if [[ "$(session_mode)" == r1-only ]]; then
  result_begin
  say "R1-only session (run-r1.sh): no data or ml-services root, so nothing to re-arm; R1's own TTL job: $(ttl_status inference)"
  say "next: bash ${LIVE_DIR}/run2-3a-validate-gpu.sh"
  exit 0
fi
[[ -n "${LABELS:-}" && -n "${APPLIED_R1:-}" ]] || die "step 2c has not applied R1 yet"
R1_EXP="$(jq -r '.labels["nip-ttl-expires"]' terraform/live/sandbox/inference/.run-profile.tfvars.json)"
LATE="$(add_30min "${R1_EXP}")"
(( $(nip_epoch "${LATE}") - $(nip_epoch "${R1_EXP}") == 1800 )) || die "LATE ${LATE} is not 30 min after R1_EXP ${R1_EXP}"
(( $(nip_epoch "${LATE}") > $(nip_now) )) || die "LATE ${LATE} has already passed: tear down now (run2-10-teardown.sh)"
say "R1_EXP=${R1_EXP}  LATE=${LATE}"
[[ -f terraform/live/sandbox/ml-services/zz-run.auto.tfvars.json ]] || die "ml-services zz-run.auto.tfvars.json missing: its destroy plan needs the run inputs"

pids=()
for stack in data ml-services; do
  boot "${stack}"
  export TF_VAR_labels="${LABELS}"
  run make ttl-teardown STAGE=sandbox STACK="${stack}" TTL="${LATE}" DRY=1
  token_guard "$(nip_epoch "${LATE}")" "the ${stack} TTL job"
  FAIL_HINT="${stack} TTL job CANCELLED, not re-armed: rerun bash ${LIVE_DIR}/run2-2d-rearm.sh now.${pids[*]+ Re-armed already: ${pids[*]}.}"
  ttl_cancel "${stack}" || die "ttl_cancel ${stack} did not return 0 (its old job may still be running)"
  run make ttl-teardown STAGE=sandbox STACK="${stack}" TTL="${LATE}" CONFIRM=yes
  ttl_running "${stack}" || die "TTL job for ${stack} is not running after re-arming"
  ttl_record "${stack}" "${LATE}"
  pids+=("${stack} pid $(cat "terraform/live/sandbox/${stack}/.terraform/ttl-teardown.pid")")
  FAIL_HINT="re-armed at ${LATE}: ${pids[*]}; any stack not listed keeps its provisional job. Rerun bash ${LIVE_DIR}/run2-2d-rearm.sh"
done
FAIL_HINT=""
state_set run2 LATE "${LATE}"; state_set run2 STEP_2D_DONE 1

result_begin
say "R1_EXP ${R1_EXP}; data and ml-services teardown at ${LATE} (UTC)"
for stack in data ml-services inference; do say "  ${stack}: $(ttl_status "${stack}")"; done
ttl_running inference || say "  WARNING: no inference TTL job running"
say "next: bash ${LIVE_DIR}/run2-3a-validate-gpu.sh"
