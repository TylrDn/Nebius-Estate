#!/usr/bin/env bash
# Run 2 step 0: preflight of data, ml-services and inference (PROFILE=l40s-gpu-only), each after its
# bootstrap and, for data/ml-services, the TF_VAR_labels export. Also starts the run-2 session
# (state/run2.env): the run ticket and TF_VAR_labels with nip-ttl-expires = now + 4 h 30 min.
# Executed: bash run2-0-preflight.sh   Optional env: NIP_RUN=<ticket>, REUSE_Z5_DATA=1 (Z5 applied
# data with -f ttl=4; step 2a is then skipped), RESET_LABELS=1 (recompute the expiry),
# RESET_SESSION=1 (start a fresh session after a teardown or abort: only when data, ml-services,
# inference and gpu-vm all have verified-empty state, no TTL job runs and run 3 is not planned;
# state/run2.env and state/run3.env are then moved to state/archive/<UTC>/), R1_ONLY=1 (an R1-only
# session, run-r1.sh: SESSION_MODE=r1-only in state/run2.env, only inference is preflighted; the mode
# can change only while no root of the session is applied).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-0-preflight
header "Run 2 step 0 - preflight (data, ml-services, inference; inference only with R1_ONLY=1)" \
  "3 bootstraps (each mints the usual 1-day state key) and 3 read-only make preflight calls (1 of each in an R1-only session); every one must print GO" \
  "\$0" "about 3-5 min" "the RESULT block (three Preflight lines, run ticket, label expiry)"
need make jq terraform nebius python3
check_repo
load_env

# A finished session's run2.env/run3.env (APPLIED_*, STEP_2D_DONE, old LABELS, R3_APPLY_AT) would
# make 2a/2b refuse or plan with expired labels: archive them, but only when nothing is left.
if [[ "${RESET_SESSION:-0}" == 1 ]]; then
  [[ ! -f terraform/live/sandbox/gpu-vm/.run-profile.tfvars.json ]] || die "RESET_SESSION: run 3 is planned or applied (gpu-vm/.run-profile.tfvars.json exists)"
  for s in data ml-services inference gpu-vm; do
    ! ttl_running "${s}" || die "RESET_SESSION: a TTL job for ${s} is still running"
    [[ -d "terraform/live/sandbox/${s}/.terraform" ]] || continue
    boot "${s}" >/dev/null
    make init STACK="${s}" >/dev/null || die "RESET_SESSION: make init STACK=${s} failed; state not verified"
    if root_has_state "${s}"; then die "RESET_SESSION: sandbox/${s} still has resources: tear it down first"; fi
  done
  arch="${STATE_DIR}/archive/$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "${arch}"; chmod 700 "${STATE_DIR}/archive" "${arch}"
  for f in run2.env run3.env; do if [[ -f "${STATE_DIR}/${f}" ]]; then mv "${STATE_DIR}/${f}" "${arch}/"; fi; done
  say "RESET_SESSION: every root verified empty; previous session state moved to ${arch}"
fi
state_load run2

# Session mode: run 2 (R8 + R12 + R1) or R1 alone (run-r1.sh). Changed only while nothing is applied.
want=run2; [[ "${R1_ONLY:-0}" == 1 ]] && want=r1-only
if [[ "${SESSION_MODE:-run2}" != "${want}" ]]; then
  [[ -z "${APPLIED_DATA:-}${APPLIED_ML:-}${APPLIED_R1:-}" ]] \
    || die "this session is ${SESSION_MODE:-run2} and a root is applied: finish it (teardown) and start a fresh one with RESET_SESSION=1 before switching to ${want}"
  state_set run2 SESSION_MODE "${want}"; SESSION_MODE="${want}"
fi
say "session mode: ${SESSION_MODE:-run2}"

# Session: ticket and labels. The labels are recomputed only while no root of this run is applied.
if [[ -z "${NIP_RUN_STATE:-}" ]]; then
  t="${NIP_RUN:-}"
  if [[ -z "${t}" ]]; then
    d="live-$(date -u +%Y%m%d)-run2"
    if [[ -t 0 ]]; then read -r -p "Run ticket for nip-run [${d}]: " t; fi
    t="${t:-${d}}"
  fi
  run_ticket_ok "${t}" || die "nip-run '${t}' must be lowercase letters, digits, - or _ (max 63)"
  state_set run2 NIP_RUN_STATE "${t}"; NIP_RUN_STATE="${t}"
fi
if [[ -z "${LABELS:-}" || "${RESET_LABELS:-0}" == 1 ]]; then
  [[ -z "${APPLIED_DATA:-}${APPLIED_ML:-}${APPLIED_R1:-}" ]] || die "a root of this run is already applied: the labels stay as they are (TTL jobs use them)"
  LABELS="$(jq -cn --arg r "${NIP_RUN_STATE}" --arg e "$(utc_plus_min 270)" '{"nip-owner":"platform","nip-run":$r,"nip-ttl-expires":$e}')"
  state_set run2 LABELS "${LABELS}"
elif [[ -z "${APPLIED_DATA:-}${APPLIED_ML:-}${APPLIED_R1:-}" ]]; then
  left=$(( $(nip_epoch "$(jq -r '.["nip-ttl-expires"]' <<<"${LABELS}")") - $(nip_now) ))
  (( left >= 4 * 3600 )) || die "the session's nip-ttl-expires is only $(( left / 60 )) min away and nothing is applied yet: rerun with RESET_LABELS=1"
fi
REUSE_Z5="${REUSE_Z5_DATA:-${REUSE_Z5:-0}}"
[[ "${REUSE_Z5}" == 0 || "${REUSE_Z5}" == 1 ]] || die "REUSE_Z5_DATA must be 0 or 1"
state_set run2 REUSE_Z5 "${REUSE_Z5}"
say "run ticket: ${NIP_RUN_STATE}"
say "TF_VAR_labels: ${LABELS}"

lines=()
if [[ "${SESSION_MODE:-run2}" == run2 ]]; then
  boot data
  export TF_VAR_labels="${LABELS}"
  preflight_go STAGE=sandbox STACK=data; lines+=("${PREFLIGHT_LINE}")
  boot ml-services
  export TF_VAR_labels="${LABELS}"
  preflight_go STAGE=sandbox STACK=ml-services; lines+=("${PREFLIGHT_LINE}")
fi
boot inference
export TF_VAR_labels="${LABELS}"
preflight_go STAGE=sandbox STACK=inference PROFILE=l40s-gpu-only; lines+=("${PREFLIGHT_LINE}")

result_begin
printf '%s\n' "${lines[@]}"
say "session mode ${SESSION_MODE:-run2}$([[ "${SESSION_MODE:-run2}" == r1-only ]] && echo ' (R1 alone, its own filestore; data and ml-services not preflighted)')"
say "run ticket ${NIP_RUN_STATE}; nip-ttl-expires $(jq -r '.["nip-ttl-expires"]' <<<"${LABELS}"); reuse Z5 data root: ${REUSE_Z5}"
say "warnings above (e.g. capacity without a tenant-level read role) are allowed; NO-GO stops"
say "next: bash ${LIVE_DIR}/run2-1-reprice.sh"
