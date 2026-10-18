#!/usr/bin/env bash
# Run 2 step 10: teardown in reverse order (R1 -> R12 -> R8), re-sourcing the bootstrap per stack so
# the STATE key (not the R8 key of step 4) is in AWS_*. Block PVCs first, in every namespace but
# kube-system (inference AND o11y: Prometheus's and Alertmanager's volumes outlive a Helm uninstall),
# waiting for their PVs to go; R1 destroy-plan/destroy/leftovers; R12: empty the Container Registry
# (step 5 pushed nip-check; a registry with images cannot be deleted), destroy-plan/destroy, wait for
# the MLflow cluster to be gone, MLflow artifact bucket(s) via scripts/mlflow-artifacts.sh,
# leftovers; R8 destroy-plan/destroy/leftovers; ttl_cancel after each root; then the SecretStash
# secret nip-sandbox-ml-services (delete verb and id flag read from `nebius mysterybox secret --help`:
# `delete --id`; checked with the read-only `list`). A root whose state is verified empty is skipped,
# so the script can be re-run after a partial teardown; a root whose state cannot be read stops the
# script with its TTL job armed. Refuses first while the R6 endpoint of step 8 still exists (by
# results/serverless-endpoint.state or by name). On a failure the RESULT block names the roots destroyed so far, the
# roots left and the TTL jobs still running.
# An R1-only session (run-r1.sh, SESSION_MODE=r1-only) tears down R1 only (its own filestore goes with it)
# and stops there: no R12, R8 or SecretStash step, so nothing else is bootstrapped.
# Executed: bash run2-10-teardown.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-10-teardown
header "Run 2 step 10 - teardown (R1, R12, R8, SecretStash secret)" \
  "PVC delete (all namespaces), make destroy-plan/destroy per root, registry images and MLflow artifact bucket delete, make leftovers per stack, ttl_cancel, secret delete" \
  "\$0; stops the session's spend (about \$1.46/h with all three up)" "about 20-40 min" \
  "the RESULT block (each destroy's Plan line and outcome, PVCs, registry, leftovers per stack, artifact bucket, secret check)"
need make jq terraform nebius kubectl
check_repo
load_env
state_load run2
MODE="$(session_mode)"
SECRET_NAME=nip-sandbox-ml-services
summary=()

labels_for() { # the session's labels; else nip-run from the root's state with a fresh expiry
  if [[ -n "${LABELS:-}" ]]; then printf '%s' "${LABELS}"; return; fi
  local r
  r="$(terraform -chdir="terraform/live/sandbox/$1" show -json 2>/dev/null | jq -r '[.. | objects | .labels? | objects | .["nip-run"] // empty] | first // empty' || true)"
  jq -cn --arg r "${r:-teardown}" --arg e "$(utc_plus_min 60)" '{"nip-owner":"platform","nip-run":$r,"nip-ttl-expires":$e}'
}
destroy_root() { # <stack> [make args...]: destroy-plan, confirm, destroy
  local stack="$1"; shift
  local pf; pf="$(mktemp)"
  run make destroy-plan STACK="${stack}" "$@" 2>&1 | tee "${pf}"
  local line; line="$(grep -E '^Plan:|No changes' "${pf}" | tail -1 || true)"; rm -f "${pf}"
  confirm "Destroy sandbox/${stack} (${line})?"
  run make destroy STACK="${stack}" CONFIRM=yes
  summary+=("${stack}: destroyed (${line})")
}
# hint <phase>: what the RESULT block reports if the script stops in <phase>.
done_roots=""
hint() {
  local s armed="" left=""
  local roots="inference ml-services data"; [[ "${MODE}" == r1-only ]] && roots=inference
  for s in ${roots}; do
    if ttl_running "${s}"; then armed="${armed} ${s}"; fi
    case " ${done_roots} " in *" ${s} "*) ;; *) left="${left} ${s}" ;; esac
  done
  FAIL_HINT="stopped during: $1. Destroyed or verified empty so far:${done_roots:- none}. Not yet:${left:- none}. TTL jobs still running:${armed:- none} (they stay armed). Fix the cause, then rerun bash ${LIVE_DIR}/run2-10-teardown.sh (it skips empty roots), or bash ${LIVE_DIR}/abort.sh"
}

# R6 (run2-8) has no TTL job and make leftovers does not list AI endpoints: refuse while it exists.
erc=0; ep="$(r6_endpoint_left)" || erc=$?
case "${erc}" in
  0) die "the R6 serverless endpoint is still there and bills: ${ep}. Delete it first: recipes/serverless/endpoint.sh delete (or nebius --profile ${NEBIUS_PROFILE} ai endpoint delete --id <id>), or bash ${LIVE_DIR}/abort.sh" ;;
  2) die "${ep} (rerun when the CLI works; R6 must be checked before the teardown)" ;;
esac
say "R6 endpoint: none (no results/serverless-endpoint.state, none named ${ENDPOINT_NAME:-nip-vllm-compare} in ${NEBIUS_PROJECT_ID})"

if [[ "${MODE}" == r1-only ]]; then confirm "Tear down the R1-only session (R1 and its own filestore) now?"
else confirm "Tear down run 2 (R1, then R12, then R8) now?"; fi

# --- R1 -------------------------------------------------------------------------------------
hint "R1 inference (bootstrap, PVCs, destroy)"
boot inference
export TF_VAR_labels; TF_VAR_labels="$(labels_for inference)"
run make init STACK=inference
if root_has_state inference; then
  if [[ "${MODE}" == run2 ]]; then   # R1-only: R1 made its own filestore and has no node SA
    fs="$(terraform -chdir=terraform/live/sandbox/data output -raw filesystem_id 2>/dev/null || true)"
    sa="$(terraform -chdir=terraform/live/sandbox/ml-services output -raw node_service_account_id 2>/dev/null || true)"
    [[ -n "${fs}" ]] && export TF_VAR_existing_filesystem_id="${fs}"
    [[ -n "${sa}" ]] && export TF_VAR_node_service_account_id="${sa}"
  fi
  export TF_VAR_alertmanager_enabled=true TF_VAR_grafana_datasource_token_secret="${R14_TOKEN_SECRET}"
  if [[ -f "${REPO}/${KCFG_REL}" ]]; then
    export KUBECONFIG="${REPO}/${KCFG_REL}"
    if kubectl --request-timeout=30s get nodes >/dev/null 2>&1; then
      # Every namespace but kube-system: inference's model cache, o11y's Prometheus and Alertmanager
      # volumes (unlabelled compute-csi disks that outlive the destroy), team namespaces.
      if release_pvcs; then summary+=("${PVC_NOTE}")
      else
        summary+=("${PVC_NOTE}")
        confirm "PVs are still there after 5 min (listed above; their disks may outlive the cluster and fail step 11). Destroy R1 anyway?"
      fi
    else
      say "WARNING: cluster API not reachable; PVCs not deleted (make leftovers lists pvc-* disks)"
      summary+=("PVCs: NOT deleted (cluster API not reachable); check make leftovers for pvc-* disks")
    fi
  else
    summary+=("PVCs: NOT deleted (no ${KCFG_REL}); check make leftovers for pvc-* disks")
  fi
  destroy_root inference PROFILE=l40s-gpu-only
  state_set run2 DESTROYED_AT_R1 "$(nip_now)"
else
  summary+=("inference: state empty (verified), skipped")
fi
done_roots="${done_roots} inference"; hint "R1 leftovers / ttl_cancel inference"
run make leftovers STACK=inference 2>&1 | tee "${STATE_DIR}/leftovers-inference.txt"
ttl_cancel inference || die "ttl_cancel inference did not return 0"

if [[ "${MODE}" == r1-only ]]; then
  FAIL_HINT=""
  result_begin
  printf '  %s\n' "${summary[@]+"${summary[@]}"}"
  if ttl_running inference; then say "  TTL inference: STILL RUNNING"; else say "  TTL inference: none"; fi
  say "--- make leftovers STACK=inference"; grep -v '^>>>' "${STATE_DIR}/leftovers-inference.txt" | sed 's/^/  /'
  say "R1-only session: no R12, R8 or SecretStash teardown"
  say "next: once run 3 is destroyed too (if it ran): bash ${LIVE_DIR}/run2-11-leftovers.sh"
  exit 0
fi

# --- R12 ------------------------------------------------------------------------------------
hint "R12 ml-services (bootstrap, registry images, destroy)"
boot ml-services
TF_VAR_labels="$(labels_for ml-services)"
run make init STACK=ml-services
ml_destroyed=no
if root_has_state ml-services; then
  # runbooks/ml-services.md "Teardown" step 2: a registry with images cannot be deleted.
  if registry_purge; then summary+=("${REGISTRY_NOTE}")
  else summary+=("${REGISTRY_NOTE}"); die "${REGISTRY_NOTE}: the ml-services destroy would fail on the registry"; fi
  destroy_root ml-services
  state_set run2 DESTROYED_AT_ML "$(nip_now)"
  ml_destroyed=yes
else
  summary+=("ml-services: state empty (verified), skipped")
fi
done_roots="${done_roots} ml-services"; hint "R12 MLflow artifact buckets / leftovers / ttl_cancel ml-services"
# A cluster still being deleted shows its bucket "in use": wait until it is gone (bounded).
if [[ "${ml_destroyed}" == yes ]]; then
  wait_mlflow_released 900 || summary+=("MLflow: a bucket was still 'in use' after 15 min; rerun this step later to delete it")
fi
run scripts/mlflow-artifacts.sh list | tee "${STATE_DIR}/mlflow-artifacts.txt"
orphans=()
while IFS= read -r b; do [[ -n "${b}" ]] && orphans+=("${b}"); done < <(awk '$3 == "orphaned" {print $2}' "${STATE_DIR}/mlflow-artifacts.txt")
for b in "${orphans[@]+"${orphans[@]}"}"; do
  confirm "Delete orphaned MLflow artifact bucket ${b} (objects included)?"
  run env CONFIRM=yes scripts/mlflow-artifacts.sh delete --bucket "${b}"
  summary+=("mlflow artifact bucket ${b}: deleted")
done
run scripts/mlflow-artifacts.sh list | tee "${STATE_DIR}/mlflow-artifacts-after.txt"
run make leftovers STACK=ml-services 2>&1 | tee "${STATE_DIR}/leftovers-ml-services.txt"
ttl_cancel ml-services || die "ttl_cancel ml-services did not return 0"

# --- R8 -------------------------------------------------------------------------------------
hint "R8 data (bootstrap, destroy)"
boot data
TF_VAR_labels="$(labels_for data)"
run make init STACK=data
if root_has_state data; then
  destroy_root data
  state_set run2 DESTROYED_AT_DATA "$(nip_now)"
else
  summary+=("data: state empty (verified), skipped")
fi
done_roots="${done_roots} data"; hint "R8 leftovers / ttl_cancel data"
run make leftovers STACK=data 2>&1 | tee "${STATE_DIR}/leftovers-data.txt"
ttl_cancel data || die "ttl_cancel data did not return 0"

# --- SecretStash secret (R12 is destroyed; no later run reuses it) --------------------------
hint "SecretStash secret delete (every root is destroyed)"
nb() { nebius --profile "${NEBIUS_PROFILE}" "$@"; }
sid="$(nb mysterybox secret get-by-name --name "${SECRET_NAME}" --parent-id "${NEBIUS_PROJECT_ID}" --format json 2>/dev/null | jq -r '.metadata.id // empty' || true)"
if [[ -n "${sid}" ]]; then
  confirm "Delete the SecretStash secret ${SECRET_NAME} (${sid})?"
  run nb mysterybox secret delete --id "${sid}"
fi
still="$(nb mysterybox secret list --parent-id "${NEBIUS_PROJECT_ID}" --format json | jq -r --arg n "${SECRET_NAME}" '[.items[]? | select(.metadata.name == $n)] | length')"
summary+=("secret ${SECRET_NAME}: ${sid:-not found} -> listed after delete: ${still} (0 = gone; soft-deleted secrets are not listed)")
FAIL_HINT=""

result_begin
printf '  %s\n' "${summary[@]+"${summary[@]}"}"
for s in inference ml-services data; do
  if ttl_running "${s}"; then say "  TTL ${s}: STILL RUNNING"; else say "  TTL ${s}: none"; fi
done
for s in inference ml-services data; do say "--- make leftovers STACK=${s}"; grep -v '^>>>' "${STATE_DIR}/leftovers-${s}.txt" | sed 's/^/  /'; done
say "--- scripts/mlflow-artifacts.sh list (after)"; sed 's/^/  /' "${STATE_DIR}/mlflow-artifacts-after.txt"
say "record the secret delete and its check in the R12 acceptance evidence"
say "next: once run 3 is destroyed too: bash ${LIVE_DIR}/run2-11-leftovers.sh"
