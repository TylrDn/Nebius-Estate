#!/usr/bin/env bash
# Run 2 step 8 (optional, last): R6 serverless endpoint. deploy/vllm stays at 0 (frees the node for
# the measure Job). endpoint.sh create (known exception R6-2: token on the CLI's argv), measure from
# the R1 cluster (in-region, with the Pending rule), delete, residue check, compare.py.
# endpoint.sh passes no --parent-id: the endpoint lands in the CLI profile's parent project, which
# need not be the sandbox project (on 2026-10-12 it was not). This step never changes ~/.nebius/config.yaml:
# it copies it into a 0700 temp dir, sets the COPY's profile parent-id to the sandbox project and
# exports NIP_NEBIUS_CONFIG=<copy> (scripts/lib-nebius.sh) for endpoint.sh; the copy is removed on
# exit. (R6_SET_PARENT is no longer needed and is ignored.)
# Once create has started, EVERY exit (failure, Ctrl-C) deletes the endpoint: R6 has no TTL job and
# make leftovers does not list AI endpoints. run2-10 and run2-11 refuse while it still exists.
# Executed: bash run2-8-r6.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-8-r6
header "Run 2 step 8 - R6 serverless endpoint (optional)" \
  "endpoint.sh create (L40S 1gpu-8vcpu-32gb), MEASURE_FROM=cluster measure, delete, get-by-name residue check, compare.py" \
  "UNKNOWN: no serverless price is recorded in the repo; bills from create until delete" \
  "about 20-60 min (provisioning may wait up to 30 min for capacity)" "the RESULT block (create/measure/delete JSON, residue check, compare.py output)"
need kubectl jq curl nebius python3 openssl
check_repo
load_env
kube_env
NAME="${ENDPOINT_NAME:-nip-vllm-compare}"
[[ -f "${HOME}/.nebius/config.yaml" ]] || die "no ${HOME}/.nebius/config.yaml to copy"

# Throwaway CLI config: the global profile is never touched (a crash cannot leave it switched).
CFGD="$(mktemp -d)"; chmod 700 "${CFGD}"
( umask 077; cp "${HOME}/.nebius/config.yaml" "${CFGD}/config.yaml" )
CREATE_STARTED=0
nb() { nebius --config "${CFGD}/config.yaml" --profile "${NEBIUS_PROFILE}" "$@"; }
r6_cleanup() { # EXIT work: delete the endpoint if this run created it and it may still exist; drop the copy
  local id="" prc=0 pmsg
  if [[ "${CREATE_STARTED}" == 1 ]]; then
    # The state file can be stale (endpoint.sh delete removes the endpoint, then the file): checked
    # with `ai endpoint get --id` first; a NotFound file is archived and the by-name check runs.
    pmsg="$(r6_state_probe)" || prc=$?
    [[ -z "${pmsg}" ]] || echo "${pmsg}"
    if (( prc == 0 )); then
      echo "exit with the R6 endpoint still recorded: recipes/serverless/endpoint.sh delete"
      if recipes/serverless/endpoint.sh delete >/dev/null 2>&1; then echo "R6 endpoint deleted on exit"
      else
        prc=0; pmsg="$(r6_state_probe)" || prc=$?
        if (( prc == 3 )); then echo "R6 endpoint gone after all (${pmsg})"
        else echo "R6 ENDPOINT DELETE FAILED on exit: it bills. Run: recipes/serverless/endpoint.sh delete, or bash ${LIVE_DIR}/abort.sh" >&2; fi
      fi
    else
      id="$(nb ai endpoint get-by-name --name "${NAME}" --parent-id "${NEBIUS_PROJECT_ID}" --format json 2>/dev/null | jq -r '.metadata.id // empty' 2>/dev/null || true)"
      if [[ -n "${id}" ]]; then
        echo "exit with endpoint ${NAME} (${id}) present and no state file: deleting it"
        nb ai endpoint delete --id "${id}" >/dev/null 2>&1 && echo "R6 endpoint ${id} deleted on exit" \
          || echo "R6 ENDPOINT DELETE FAILED on exit: nebius --profile ${NEBIUS_PROFILE} ai endpoint delete --id ${id}" >&2
      fi
    fi
  fi
  rm -rf "${CFGD}"
}
trap 'rc=$?; r6_cleanup; _on_exit $rc' EXIT
export NIP_NEBIUS_CONFIG="${CFGD}/config.yaml"
ORIG_PARENT="$(nb config get parent-id 2>/dev/null || true)"
if [[ "${ORIG_PARENT}" != "${NEBIUS_PROJECT_ID}" ]]; then
  run nb config set parent-id "${NEBIUS_PROJECT_ID}"
  say "throwaway CLI config ${NIP_NEBIUS_CONFIG}: profile ${NEBIUS_PROFILE} parent-id ${ORIG_PARENT:-unset} -> ${NEBIUS_PROJECT_ID} (~/.nebius/config.yaml unchanged)"
fi
[[ "$(nb config get parent-id)" == "${NEBIUS_PROJECT_ID}" ]] || die "the throwaway config's parent-id is not the sandbox project"
nb iam whoami --format json >/dev/null || die "the CLI cannot authenticate with the throwaway config copy (a federation login may be needed: run it again in a terminal)"
erc=0; already="$(r6_endpoint_left)" || erc=$?
case "${erc}" in
  0) die "an R6 endpoint is already there (${already}): delete it first (recipes/serverless/endpoint.sh delete, or bash ${LIVE_DIR}/abort.sh)" ;;
  2) die "${already}" ;;
esac

replicas="$(kubectl -n inference get deploy vllm -o jsonpath='{.spec.replicas}')"
[[ "${replicas}" == 0 ]] || die "deploy/vllm has ${replicas} replicas; step 7 leaves it at 0 (kubectl -n inference scale deploy/vllm --replicas=0)"
headroom || die "headroom short for the measure Job (cpu 2, memory 4Gi): something else is scheduled on the node"
[[ -f results/05-load.json ]] || say "WARNING: no results/05-load.json from step 3: compare.py has nothing to compare against"

confirm "Create the R6 serverless L40S endpoint ${NAME} (about \$1.57/h on-demand, derived; bills until delete)?"
FAIL_HINT="the exit trap deletes the endpoint (its result is printed just above this block). If it says DELETE FAILED, the endpoint bills: recipes/serverless/endpoint.sh delete (id in results/serverless-endpoint.state), or nebius --profile ${NEBIUS_PROFILE} ai endpoint get-by-name --name ${NAME} --parent-id ${NEBIUS_PROJECT_ID}, then nebius --profile ${NEBIUS_PROFILE} ai endpoint delete --id <id>; or bash ${LIVE_DIR}/abort.sh"
CREATE_STARTED=1
run env NEBIUS_REGION="${NEBIUS_REGION}" CONFIRM=yes recipes/serverless/endpoint.sh create
[[ "$(jq -r .status results/serverless-endpoint-create.json)" == pass ]] || die "create did not reach /health (the exit trap deletes the endpoint)"

say ">>> MEASURE_FROM=cluster recipes/serverless/endpoint.sh measure   (Pending watch on nip-bench)"
MEASURE_FROM=cluster recipes/serverless/endpoint.sh measure &
pid=$!
bench_guard nip-bench "${pid}" r6_cleanup   # Ctrl-C: stop the measure, delete its Job, then delete the endpoint
w=0; watch_bench nip-bench "${pid}" || w=$?
mrc=0; wait "${pid}" || mrc=$?
bench_unguard r6_cleanup
if (( w == 3 )); then say "measure STOPPED: bench pod Pending for capacity (record it); deleting the endpoint anyway"; else say "measure exit ${mrc}"; fi

run recipes/serverless/endpoint.sh delete
CREATE_STARTED=0; FAIL_HINT=""
residue="$(nb ai endpoint get-by-name --name "${NAME}" --parent-id "${NEBIUS_PROJECT_ID}" --format json 2>&1 || true)"
state_gone=yes; [[ -f results/serverless-endpoint.state ]] && state_gone=no
cmp="$(python3 recipes/serverless/compare.py 2>&1 || true)"

result_begin
jq -c . results/serverless-endpoint-create.json 2>/dev/null || true
jq -c '{status, details: (.details | {first_request_ms, endpoint_region, generator_region, vantage, points: [.points[]? | {concurrency, output_tokens_per_s, ttft_ms, e2e_ms, pass}]})}' results/serverless-endpoint-measure.json 2>/dev/null || true
jq -c . results/serverless-endpoint-delete.json 2>/dev/null || true
say "residue: results/serverless-endpoint.state gone=${state_gone}; nebius ai endpoint get-by-name --name ${NAME} (expect not found):"
printf '%s\n' "${residue}" | head -n 5
say "compare.py:"; printf '%s\n' "${cmp}" | tail -n 30
say "evidence: docs/evidence/<date>-serverless-comparison.md"
say "next (optional F6.1): bash ${LIVE_DIR}/run2-8b-f61.sh, else bash ${LIVE_DIR}/run2-9-evidence.sh"
