#!/usr/bin/env bash
# Run 2 step 2a: R8 data root. bootstrap, TF_VAR_labels, make init plan, provisional TTL job at the
# label's expiry BEFORE the apply (DRY=1, ttl_cancel data, CONFIRM=yes), then make apply.
# With REUSE_Z5=1 (set by run2-0, Z5 applied data with -f ttl=4): no apply; bootstrap, make init,
# TF_VAR_labels, and Z5's TTL job is armed only if it is not running yet (it stays until step 2d).
# Refuses when fewer than 150 min are left before the provisional TTL time (2a-2d take about 75 min).
# Executed: bash run2-2a-data.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-2a-data
header "Run 2 step 2a - R8 data apply (or Z5 reuse)" \
  "make init plan STACK=data; TTL job armed before the apply; make apply STACK=data CONFIRM=yes (two buckets + 256 GiB filesystem)" \
  "filesystem \$0.0281/h: about \$0.06 (2 h) to \$0.11 (4 h)" "about 6-10 min (6 min on 2026-10-11)" \
  "the RESULT block (plan summary, TTL time + pid, apply outcome)"
need make jq terraform nebius python3
check_repo
load_env
state_load run2
[[ -n "${LABELS:-}" && -n "${NIP_RUN_STATE:-}" ]] || die "no run-2 session: run run2-0-preflight.sh first"
[[ "${STEP_2D_DONE:-0}" != 1 ]] || die "step 2d already re-armed the final TTL jobs; re-running 2a would replace data's final job"
EXP="$(jq -r '.["nip-ttl-expires"]' <<<"${LABELS}")"

boot data
export TF_VAR_labels="${LABELS}"

if [[ "${REUSE_Z5:-0}" == 1 ]]; then
  run make init STACK=data
  root_has_state data || die "REUSE_Z5=1 but the data root's state is empty: Z5 did not apply it (rerun run2-0 with REUSE_Z5_DATA=0)"
  # Z5's own expiry, read back from the applied labels (Z5 step 3's L()).
  L() { terraform -chdir=terraform/live/sandbox/data show -json | jq -r --arg k "$1" '[.. | objects | .labels? | objects | .[$k] // empty] | first // empty'; }
  z5exp="$(L nip-ttl-expires)"
  [[ "${z5exp}" =~ ^[0-9]{4}- ]] || die "no nip-ttl-expires in the data state (Z5's job time)"
  DATA_TTL_AT="${z5exp}"; ttl_window 150 "steps 2a-2d (about 75 min, x2 margin)"
  state_set run2 DATA_TTL_AT "${z5exp}"
  if ttl_running data; then
    say "Z5's TTL job for data is running (pid $(cat terraform/live/sandbox/data/.terraform/ttl-teardown.pid)); left armed until step 2d"
  else
    [[ "${z5exp}" =~ ^[0-9]{4}- ]] || die "no nip-ttl-expires in the data state to arm Z5's job with"
    ttl_arm data TTL="${z5exp}"
  fi
  state_set run2 APPLIED_DATA reused
  result_begin
  say "data root reused from Z5 (labels nip-run=$(L nip-run) nip-ttl-expires=${z5exp}); no apply"
  say "TTL job for data: $(ttl_status data) (log terraform/live/sandbox/data/.terraform/ttl-teardown.log)"
  say "  (a job left running from Z5 carries Z5's token, of unknown expiry; step 2d replaces it with one checked against the token)"
  say "next: bash ${LIVE_DIR}/run2-2b-ml-services.sh"
  exit 0
fi

DATA_TTL_AT=""; ttl_window 150 "steps 2a-2d (about 75 min, x2 margin)"
state_set run2 DATA_TTL_AT "${EXP}"
preflight_go STAGE=sandbox STACK=data
run make init plan STACK=data
make -s plan-summary STACK=data || true
# Provisional TTL job before the apply (replaced in step 2d).
ttl_arm data TTL="${EXP}"
FAIL_HINT="data TTL job armed for ${EXP} (pid $(cat terraform/live/sandbox/data/.terraform/ttl-teardown.pid)); it stays armed. Re-run this step, or bash ${LIVE_DIR}/abort.sh"
confirm "Apply sandbox/data (R8: two buckets and a 256 GiB filesystem, \$0.0281/h)?"
state_set run2 APPLIED_DATA 1
[[ -n "${APPLY_AT_DATA:-}" ]] || state_set run2 APPLY_AT_DATA "$(nip_now)"
run make apply STACK=data CONFIRM=yes

result_begin
say "apply sandbox/data: done; TTL job (provisional, step 2d replaces it): $(ttl_status data)"
terraform -chdir=terraform/live/sandbox/data output -json | jq -r 'to_entries[] | select(.value.sensitive | not) | "  \(.key) = \(.value.value)"'
say "next: bash ${LIVE_DIR}/run2-2b-ml-services.sh"
