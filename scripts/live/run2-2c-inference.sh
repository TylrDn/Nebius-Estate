#!/usr/bin/env bash
# Run 2 step 2c: R1 inference on PROFILE=l40s-gpu-only with R8's filesystem, R12's node service
# account and Alertmanager on. make init, make plan (renders .run-profile.tfvars.json with the 3 h
# expiry), TTL job before the apply (DRY=1, ttl_cancel inference, CONFIRM=yes), make apply.
# Refuses when fewer than 90 min are left before the data/ml-services TTL jobs fire (only 2d moves them).
# R1's control-plane allowlist is .env's TF_VAR_allowed_cidrs: when it is set, it must contain your
# current egress address (checkip; MY_CIDR=x.x.x.x/32 overrides), or kubectl, run2-10's destroy-plan
# refresh and the inference TTL job's destroy-plan cannot reach the cluster.
# A rerun after step 2d moves R1's TTL and sets STEP_2D_DONE=0: every later step (kube_env /
# require_2d) then refuses until run2-2d-rearm.sh is run again.
# R1-only session (run-r1.sh, state SESSION_MODE=r1-only): no R8/R12 prerequisites, no data/ml-services
# TTL window, no filesystem or node SA export: R1 creates its own 64 GiB filestore (existing_filesystem_id
# null) and its nodes run without a service account (node_service_account_id null; every image is public).
# Both modes name the R14 data-source token Secret (TF_VAR_grafana_datasource_token_secret) before the plan.
# Executed: bash run2-2c-inference.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-2c-inference
header "Run 2 step 2c - R1 plan and apply (l40s-gpu-only)" \
  "export filesystem id and node SA id (run 2; an R1-only session creates its own filestore), Alertmanager, data-source token Secret name; make init/plan STACK=inference PROFILE=l40s-gpu-only RUN=<ticket>; TTL job (3 h) before apply; make apply" \
  "about \$0.78/h (preemptible L40S + disk): \$1.56 (2 h) to \$2.34 (3 h TTL)" "about 15-25 min (cluster + GPU node group + add-ons)" \
  "the RESULT block (plan summary, R1 expiry, TTL pid, apply outcome)"
need make jq terraform nebius python3 curl
check_repo
load_env
state_load run2
MODE="$(session_mode)"
[[ -n "${LABELS:-}" && -n "${NIP_RUN_STATE:-}" ]] || die "no run-2 session: run run2-0-preflight.sh first"
if [[ "${MODE}" == run2 ]]; then
  [[ -n "${APPLIED_DATA:-}" && -n "${APPLIED_ML:-}" ]] || die "steps 2a and 2b must run first (deploy order R8 -> R12 -> R1)"
  ttl_window 90 "steps 2c-2d (about 30 min, x3 margin)"
else
  say "R1-only session: no data/ml-services roots; R1 creates its own filestore"
fi
say "TF_VAR_allowed_cidrs (R1 control-plane allowlist, from .env): ${TF_VAR_allowed_cidrs:-unset (module default [])}"
if [[ -n "${TF_VAR_allowed_cidrs:-}" ]]; then
  if [[ -n "${MY_CIDR:-}" ]]; then myip="${MY_CIDR%/*}"
  else myip="$(curl -s -m 10 https://checkip.amazonaws.com | tr -d '[:space:]' || true)"; fi
  [[ "${myip}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "could not detect your public IPv4 to check TF_VAR_allowed_cidrs; pass MY_CIDR=x.x.x.x/32"
  cidr_rc=0
  python3 -I -c 'import ipaddress, json, sys
try:
    nets = [ipaddress.ip_network(c, strict=False) for c in json.loads(sys.argv[2])]
except (ValueError, TypeError) as e:
    print(f"TF_VAR_allowed_cidrs is not a JSON list of CIDRs: {e}"); sys.exit(2)
sys.exit(0 if any(ipaddress.ip_address(sys.argv[1]) in n for n in nets) else 1)' "${myip}" "${TF_VAR_allowed_cidrs}" || cidr_rc=$?
  case "${cidr_rc}" in
    0) say "your egress ${myip} is inside TF_VAR_allowed_cidrs" ;;
    1) die "your egress address ${myip} is in no entry of TF_VAR_allowed_cidrs ${TF_VAR_allowed_cidrs} (.env): kubectl, run2-10's destroy-plan and the inference TTL job could not reach R1's API. Add ${myip}/32 to TF_VAR_allowed_cidrs in .env (or empty it), or pass MY_CIDR=<address you will run from>/32, then rerun" ;;
    *) die "cannot check TF_VAR_allowed_cidrs (message above); fix it in .env" ;;
  esac
fi
ROOT=terraform/live/sandbox/inference

boot inference
export TF_VAR_labels="${LABELS}"   # still exported in the plan's single shell; run-profile.py keeps it
if [[ "${MODE}" == run2 ]]; then
  fs="$(terraform -chdir=terraform/live/sandbox/data output -raw filesystem_id)"
  sa="$(terraform -chdir=terraform/live/sandbox/ml-services output -raw node_service_account_id)"
  [[ -n "${fs}" && -n "${sa}" ]] || die "data filesystem_id or ml-services node_service_account_id output is empty"
  export TF_VAR_existing_filesystem_id="${fs}" TF_VAR_node_service_account_id="${sa}"
  say "TF_VAR_existing_filesystem_id=${fs} TF_VAR_node_service_account_id=${sa}"
else
  unset TF_VAR_existing_filesystem_id TF_VAR_node_service_account_id
fi
# R14: Alertmanager on (sandbox's policy leaves it off) and the data-source token Secret named; the
# Secret need not exist at plan time (step 6 creates it).
if [[ "${R14:-1}" == 0 ]]; then
  # R14=0: no Alertmanager (its StatefulSet PVC takes the default class csi-mounted-fs-path-sc, which did
  # not bind on an R1-only GPU node on 2026-10-13 and held the prometheus release apply 69 min) and no
  # data-source Secret named (Grafana would wait for it). R1 itself is unaffected.
  export TF_VAR_alertmanager_enabled=false; unset TF_VAR_grafana_datasource_token_secret
  say "R14=0: TF_VAR_alertmanager_enabled=false, no data-source token Secret named"
else
export TF_VAR_alertmanager_enabled=true TF_VAR_grafana_datasource_token_secret="${R14_TOKEN_SECRET}"
say "TF_VAR_alertmanager_enabled=true TF_VAR_grafana_datasource_token_secret=${R14_TOKEN_SECRET}"
fi

preflight_go STAGE=sandbox STACK=inference PROFILE=l40s-gpu-only
run make init STACK=inference
run make plan STACK=inference PROFILE=l40s-gpu-only RUN="${NIP_RUN_STATE}"
make -s plan-summary STACK=inference || true
R1_EXP="$(jq -r '.labels["nip-ttl-expires"]' "${ROOT}/.run-profile.tfvars.json")"
[[ "${R1_EXP}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || die "no nip-ttl-expires in ${ROOT}/.run-profile.tfvars.json"
state_set run2 R1_EXP "${R1_EXP}"
if [[ "${STEP_2D_DONE:-0}" == 1 ]]; then
  state_set run2 STEP_2D_DONE 0
  say "NOTE: R1 was re-planned after step 2d: run run2-2d-rearm.sh again so data/ml-services fire after the NEW R1 expiry"
fi
lab="$(jq -r '.["nip-ttl-expires"]' <<<"${LABELS}")"
late_epoch=$(( $(nip_epoch "${R1_EXP}") + 1800 ))
[[ "${MODE}" == r1-only ]] || (( $(nip_epoch "${lab}") >= late_epoch )) || say "WARNING: the data/ml-services label ${lab} is earlier than R1's expiry + 30 min ($(nip_utc ${late_epoch})); step 2d still re-arms their jobs at R1 + 30 min"

# F2.3: the TTL job armed against a real root, before the apply.
ttl_arm inference PROFILE=l40s-gpu-only
FAIL_HINT="inference TTL job armed for ${R1_EXP} (pid $(cat ${ROOT}/.terraform/ttl-teardown.pid)); it stays armed. Re-run this step, or bash ${LIVE_DIR}/abort.sh"
confirm "Apply sandbox/inference (preemptible L40S node, about \$0.78/h, TTL ${R1_EXP})?"
state_set run2 APPLIED_R1 1
[[ -n "${APPLY_AT_R1:-}" ]] || state_set run2 APPLY_AT_R1 "$(nip_now)"
run make apply STACK=inference CONFIRM=yes

result_begin
say "apply sandbox/inference: done; R1 nip-ttl-expires ${R1_EXP}; TTL job: $(ttl_status inference)"
terraform -chdir="${ROOT}" output -json | jq -r '{cluster_id: .cluster_id.value, cluster_name: .cluster_name.value, node_groups: .node_groups.value, o11y_namespace: .o11y_namespace.value}'
if [[ "${MODE}" == r1-only ]]; then say "next: bash ${LIVE_DIR}/run2-3a-validate-gpu.sh (R1-only: no step 2d)"
else say "next (now, not later): bash ${LIVE_DIR}/run2-2d-rearm.sh"; fi
