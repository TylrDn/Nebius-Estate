#!/usr/bin/env bash
# EMERGENCY STOP for runs 2 and 3: tears down every sandbox live root that has state, then runs
# make leftovers-stage STAGE=sandbox. Order: R6 endpoint (when inference is in the list: by
# results/serverless-endpoint.state, else found by name) -> inference (block PVCs of every namespace
# first) -> gpu-vm -> ml-services (registry images first; then orphaned MLflow artifact buckets and
# the SecretStash secret) -> data -> any other sandbox root with state (network, training,
# governance). Per root: bootstrap, inputs as planned (labels, run profile, filesystem/SA ids, SSH
# key), make init, destroy-plan, destroy CONFIRM=yes, leftovers, ttl_cancel.
# A root that fails at any point (bootstrap, init, state read, destroy) is reported and the script
# goes on with the next root. A TTL job is cancelled ONLY for a root this run destroyed or whose
# state was read and is empty; every other root (not checked, unreadable, destroy failed) keeps its
# TTL job armed and is reported as such. A root that another process may be writing right now (a
# terraform process on it, a live 2a/2b/2c/2d/3.3 step script, or its S3 .tflock object present) is
# BUSY: not checked, not destroyed, TTL left armed, secret kept (its state can read empty in the first
# moments of an apply). While R1 (inference) is not verified gone (destroy failed, busy, not checked),
# ml-services (node SA) and data (filesystem) are KEPT with their TTL jobs armed, so nothing is
# deleted under a live cluster; ABORT_UNDER_R1=1 overrides that. This holds when inference is left
# out of ABORT_ROOTS too: its local root is then checked read-only (busy, bootstrap, lock, state
# read; never destroyed, TTL never touched), and data/ml-services go only if it reads empty.
# The R6 state file is checked with `ai endpoint get --id` first: a stale one (NotFound) is moved to
# state/archive/ and the by-name check runs instead. soperator is not handled (its state lives in the fetched
# upstream recipe; runbooks/teardown.md "Soperator").
# Executed: bash abort.sh   (one confirmation, typing ABORT, for the whole list; ABORT_ROOTS="a b"
# limits the roots, and the endpoint/secret deletes run only when inference/ml-services are in it;
# ASSUME_YES=1 skips the prompt; ABORT_UNDER_R1=1 destroys data/ml-services even while R1 is up)
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init abort
header "ABORT - tear down every sandbox root with state" \
  "endpoint delete, PVCs, registry images, make destroy-plan/destroy per root with state, artifact buckets, secret, ttl_cancel, make leftovers-stage" \
  "\$0; stops all spend of runs 2-3" "about 20-45 min" "the whole RESULT block"
need make jq terraform nebius
check_repo
load_env
state_load run2
state_load run3
nb() { nebius --profile "${NEBIUS_PROFILE}" "$@"; }
summary=()
ENDPOINT_NAME="${ENDPOINT_NAME:-nip-vllm-compare}"

ROOTS=(inference gpu-vm ml-services data network training governance)
if [[ "${ABORT_ROOTS:-}" =~ [a-z] ]]; then read -ra ROOTS <<<"${ABORT_ROOTS}"; fi
for s in "${ROOTS[@]}"; do [[ -d "terraform/live/sandbox/${s}" && "${s}" != soperator ]] || die "unknown root ${s}"; done
in_roots() { local r; for r in "${ROOTS[@]}"; do [[ "${r}" == "$1" ]] && return 0; done; return 1; }

# Per-root status (bash 3.2: no associative arrays): notlocal | busy | bootfail | initfail |
# unreadable | empty | has | destroyed | destroyfail | keptr1.
st_key() { printf 'ST_%s' "${1//-/_}"; }
st_set() { printf -v "$(st_key "$1")" '%s' "$2"; }
st_get() { local k; k="$(st_key "$1")"; printf '%s' "${!k:-}"; }

# Find which roots have state (one bootstrap each; each mints the usual 1-day state key).
with_state=()
for s in "${ROOTS[@]}"; do
  if [[ ! -d "terraform/live/sandbox/${s}/.terraform" && ! -f "terraform/live/sandbox/${s}/backend.hcl" ]]; then
    st_set "${s}" notlocal; continue   # never initialised here: no state key, no TTL pid file
  fi
  if why="$(root_busy "${s}")"; then st_set "${s}" busy; summary+=("${s}: NOT CHECKED (busy: ${why}), TTL left armed"); continue; fi
  if ! boot_try "${s}" >/dev/null; then st_set "${s}" bootfail; summary+=("${s}: NOT CHECKED (bootstrap failed), TTL left armed"); continue; fi
  lk="$(state_lock "${s}")"
  if [[ "${lk}" == held ]]; then st_set "${s}" busy; summary+=("${s}: NOT CHECKED (busy: its state lock object .tflock exists), TTL left armed"); continue; fi
  [[ "${lk}" == free ]] || say "${s}: state lock check inconclusive (${lk}); relying on the process check"
  if ! make init STACK="${s}" >/dev/null 2>&1; then st_set "${s}" initfail; summary+=("${s}: NOT CHECKED (make init failed), TTL left armed"); continue; fi
  if st="$(root_state "${s}")"; then
    st_set "${s}" "${st}"
    if [[ "${st}" == has ]]; then with_state+=("${s}"); fi
  else
    st_set "${s}" unreadable; summary+=("${s}: NOT CHECKED (state could not be read), TTL left armed")
  fi
done

# R1 outside ABORT_ROOTS: check its local root read-only, so r1_up knows whether a cluster may
# still run on data's filesystem and ml-services' node SA. Never destroyed or TTL-cancelled here
# (the loops below only walk ROOTS).
R1_PROBED=0
if ! in_roots inference; then
  if [[ -d terraform/live/sandbox/inference/.terraform || -f terraform/live/sandbox/inference/backend.hcl ]]; then
    R1_PROBED=1
    if why="$(root_busy inference)"; then st_set inference busy
    elif ! boot_try inference >/dev/null; then st_set inference bootfail
    elif [[ "$(state_lock inference)" == held ]]; then st_set inference busy
    elif ! make init STACK=inference >/dev/null 2>&1; then st_set inference initfail
    elif st="$(root_state inference)"; then st_set inference "${st}"
    else st_set inference unreadable; fi
    summary+=("inference (outside ABORT_ROOTS): checked read-only: $(st_get inference); not destroyed, TTL untouched")
  else
    st_set inference notlocal
  fi
fi

# R6 endpoint: only with inference in the list. By the state file (checked live: a stale file is
# archived), else by name in the sandbox.
ep=no ep_id=""
if in_roots inference; then
  prc=0; pmsg="$(r6_state_probe)" || prc=$?
  [[ -z "${pmsg}" ]] || say "R6: ${pmsg}"
  if (( prc == 3 )); then summary+=("R6: ${pmsg}"); fi
  if (( prc == 0 )); then ep=state-file
  else
    ep_id="$(nb ai endpoint get-by-name --name "${ENDPOINT_NAME}" --parent-id "${NEBIUS_PROJECT_ID}" --format json 2>/dev/null | jq -r '.metadata.id // empty' || true)"
    [[ -n "${ep_id}" ]] && ep="by-name ${ep_id}"
  fi
fi
# inference first, whatever ABORT_ROOTS' order: data and ml-services are only destroyed once R1 is gone.
ordered=()
for s in inference "${with_state[@]+"${with_state[@]}"}"; do
  case " ${ordered[*]+"${ordered[*]}"} " in *" ${s} "*) continue ;; esac
  for r in "${with_state[@]+"${with_state[@]}"}"; do if [[ "${r}" == "${s}" ]]; then ordered+=("${s}"); fi; done
done
with_state=("${ordered[@]+"${ordered[@]}"}")
busy=""
for s in "${ROOTS[@]}"; do [[ "$(st_get "${s}")" == busy ]] && busy="${busy} ${s}"; done
[[ -z "${busy}" ]] || say "BUSY (left alone, TTL armed):${busy}"
say "roots with state: ${with_state[*]:-none}; R6 endpoint: ${ep}"
if [[ "${ASSUME_YES}" != 1 ]]; then
  need_tty
  read -r -p "Type ABORT to destroy: ${with_state[*]:-nothing} (endpoint: ${ep}): " a
  [[ "${a}" == ABORT ]] || die "not confirmed; nothing destroyed"
fi

labels_for() { # session labels for data/ml-services; else nip-run from state with a fresh expiry
  local st="$1" run=""
  if [[ ("${st}" == data || "${st}" == ml-services) && -n "${LABELS:-}" ]]; then printf '%s' "${LABELS}"; return; fi
  run="$(terraform -chdir="terraform/live/sandbox/${st}" show -json 2>/dev/null | jq -r '[.. | objects | .labels? | objects | .["nip-run"] // empty] | first // empty' || true)"
  jq -cn --arg r "${run:-abort}" --arg e "$(utc_plus_min 60)" '{"nip-owner":"platform","nip-run":$r,"nip-ttl-expires":$e}'
}

# R6 endpoint first (it bills until deleted).
case "${ep}" in
  state-file)
    if recipes/serverless/endpoint.sh delete; then summary+=("R6 endpoint: deleted")
    else
      prc=0; pmsg="$(r6_state_probe)" || prc=$?
      if (( prc == 3 )); then summary+=("R6 endpoint: gone (${pmsg})")
      else summary+=("R6 endpoint: DELETE FAILED (id in results/serverless-endpoint.state): ${pmsg}"); fi
    fi ;;
  by-name*)
    if nb ai endpoint delete --id "${ep_id}" >/dev/null; then summary+=("R6 endpoint ${ep_id} (found by name ${ENDPOINT_NAME}): deleted")
    else summary+=("R6 endpoint ${ep_id}: DELETE FAILED (nebius ai endpoint delete --id ${ep_id})"); fi ;;
esac

teardown_root() { # <stack>; returns non-zero on failure
  local s="$1" prof=()
  boot_try "${s}" || return 1
  export TF_VAR_labels; TF_VAR_labels="$(labels_for "${s}")"
  case "${s}" in
    inference)
      local fs sa
      fs="$(terraform -chdir=terraform/live/sandbox/data output -raw filesystem_id 2>/dev/null || true)"
      sa="$(terraform -chdir=terraform/live/sandbox/ml-services output -raw node_service_account_id 2>/dev/null || true)"
      [[ -n "${fs}" ]] && export TF_VAR_existing_filesystem_id="${fs}"
      [[ -n "${sa}" ]] && export TF_VAR_node_service_account_id="${sa}"
      export TF_VAR_alertmanager_enabled=true
      [[ -f terraform/live/sandbox/inference/.run-profile.tfvars.json ]] && prof=(PROFILE=l40s-gpu-only)
      if [[ -f "${REPO}/${KCFG_REL}" ]] && KUBECONFIG="${REPO}/${KCFG_REL}" kubectl --request-timeout=20s get nodes >/dev/null 2>&1; then
        # Every namespace but kube-system, o11y included (Prometheus/Alertmanager volumes).
        export KUBECONFIG="${REPO}/${KCFG_REL}"
        release_pvcs || true
        summary+=("${PVC_NOTE}")
      else
        summary+=("PVCs: NOT deleted (cluster API not reachable); leftovers lists pvc-* disks")
      fi ;;
    gpu-vm)
      local key="${R3_PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
      [[ -f "${key}" ]] || { say "gpu-vm: SSH public key ${key} missing (required input)"; return 1; }
      TF_VAR_ssh_public_key="$(cat "${key}")"; export TF_VAR_ssh_public_key
      if [[ -n "${R3_CIDR:-}" ]]; then TF_VAR_allowed_cidrs="$(jq -cn --arg c "${R3_CIDR}" '[$c]')"; export TF_VAR_allowed_cidrs; fi
      [[ -f terraform/live/sandbox/gpu-vm/.run-profile.tfvars.json ]] && prof=(PROFILE=l40s-preemptible) ;;
  esac
  run make init STACK="${s}" || return 1
  if [[ "${s}" == ml-services ]]; then
    # A registry with images cannot be deleted (runbooks/ml-services.md "Teardown" step 2).
    if registry_purge; then summary+=("${REGISTRY_NOTE}"); else summary+=("${REGISTRY_NOTE}"); return 1; fi
  fi
  run make destroy-plan STACK="${s}" "${prof[@]+"${prof[@]}"}" || return 1
  run make destroy STACK="${s}" CONFIRM=yes || return 1
}

# R1 may still be up unless inference was destroyed here, read empty, or is not a local root. With
# inference outside ABORT_ROOTS, its read-only check above decides the same way.
r1_up() {
  case "$(st_get inference)" in notlocal|empty|destroyed) return 1 ;; *) return 0 ;; esac
}
for s in "${with_state[@]+"${with_state[@]}"}"; do
  hr; say "=== ${s}"
  if [[ ("${s}" == data || "${s}" == ml-services) && "${ABORT_UNDER_R1:-0}" != 1 ]] && r1_up; then
    st_set "${s}" keptr1
    summary+=("${s}: KEPT: R1 may still be up (inference $(st_get inference)$( (( R1_PROBED == 1 )) && echo ', outside ABORT_ROOTS')), TTL armed; rerun abort.sh with inference in the list (or once it is gone), or ABORT_UNDER_R1=1 to destroy it anyway")
    continue
  fi
  if why="$(root_busy "${s}")"; then
    st_set "${s}" busy; summary+=("${s}: NOT DESTROYED (busy: ${why}), TTL left armed"); continue
  fi
  if teardown_root "${s}"; then
    st_set "${s}" destroyed
    summary+=("${s}: destroyed")
    ttl_cancel "${s}" || summary+=("${s}: ttl_cancel did not return 0")
    if [[ "${s}" == gpu-vm ]]; then rm -f terraform/live/sandbox/gpu-vm/.run-profile.tfvars.json; fi
  else
    st_set "${s}" destroyfail
    summary+=("${s}: DESTROY FAILED (TTL job left armed if any; see log)")
  fi
  run make leftovers STACK="${s}" 2>&1 | tee "${STATE_DIR}/abort-leftovers-${s}.txt" || true
  if [[ "${s}" == ml-services ]]; then
    [[ "$(st_get ml-services)" == destroyed ]] && { wait_mlflow_released 900 || summary+=("MLflow: a bucket still 'in use' after 15 min; rerun abort.sh later"); }
    scripts/mlflow-artifacts.sh list | tee "${STATE_DIR}/abort-mlflow.txt" || true
    orphans=()
    while IFS= read -r b; do [[ -n "${b}" ]] && orphans+=("${b}"); done < <(awk '$3 == "orphaned" {print $2}' "${STATE_DIR}/abort-mlflow.txt")
    for b in "${orphans[@]+"${orphans[@]}"}"; do
      if CONFIRM=yes scripts/mlflow-artifacts.sh delete --bucket "${b}"; then summary+=("artifact bucket ${b}: deleted"); else summary+=("artifact bucket ${b}: DELETE FAILED"); fi
    done
  fi
done

# The R12 SecretStash secret: only with ml-services in the list, and only once its state is
# known to be empty (destroyed now, or read empty above). Never during another run's step 2b.
if in_roots ml-services; then
  case "$(st_get ml-services)" in
    destroyed|empty)
      sid="$(nb mysterybox secret get-by-name --name nip-sandbox-ml-services --parent-id "${NEBIUS_PROJECT_ID}" --format json 2>/dev/null | jq -r '.metadata.id // empty' || true)"
      if [[ -n "${sid}" ]]; then
        if nb mysterybox secret delete --id "${sid}" >/dev/null; then summary+=("secret nip-sandbox-ml-services: deleted"); else summary+=("secret: DELETE FAILED (${sid})"); fi
      fi ;;
    *) summary+=("secret nip-sandbox-ml-services: kept (ml-services not verified empty)") ;;
  esac
fi

# TTL jobs: cancelled only for roots destroyed above or read empty. Every other root keeps its job.
for s in "${ROOTS[@]}"; do
  case "$(st_get "${s}")" in
    destroyed|empty) if ttl_running "${s}"; then ttl_cancel "${s}" || summary+=("${s}: ttl_cancel did not return 0"); fi ;;
  esac
done

out="${STATE_DIR}/abort-leftovers-stage.txt"
rc=0; run make leftovers-stage STAGE=sandbox 2>&1 | tee "${out}" || rc=$?

result_begin
printf '  %s\n' "${summary[@]+"${summary[@]}"}"
for s in "${ROOTS[@]}"; do
  st="$(st_get "${s}")"
  case "${st}" in
    busy|bootfail|initfail|unreadable) say "  ${s}: NOT CHECKED (${st}), TTL left armed: $(ttl_running "${s}" && echo running || echo 'no job running')" ;;
    *) if ttl_running "${s}"; then say "  TTL ${s}: STILL RUNNING (${st})"; fi ;;
  esac
done
say "make leftovers-stage STAGE=sandbox: exit ${rc}"
grep -v '^>>>' "${out}" | sed 's/^/  /'
fail=0
for s in "${ROOTS[@]}"; do case "$(st_get "${s}")" in busy|bootfail|initfail|unreadable|destroyfail|keptr1) fail=1 ;; esac; done
(( rc == 0 && fail == 0 )) || { say "something is still left or unchecked in the sandbox project (above)"; exit 1; }
