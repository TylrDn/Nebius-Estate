#!/usr/bin/env bash
# A4 (plan task Z5 steps 2-5): the APPLY half of R13, the federated CI apply, then the retirement of
# the sandbox CI service-account keys. docs/plans/2026-10-12-live-runs.md "Z5";
# runbooks/identity.md "First federated run" step 4 and "Retire the authorized keys".
#   bash scripts/live/A4-r13-federated-apply.sh                        dispatch, watch, report, local teardown, then offer the retirement
#   bash scripts/live/A4-r13-federated-apply.sh --teardown-only        only the local teardown of the CI-applied data root
#   bash scripts/live/A4-r13-federated-apply.sh --retire-only --run-id <id>   only the retirement, after that green apply run
# Phases:
#   1 precondition (read-only): GitHub environments sandbox and sandbox-plan hold no NIP_SA_PRIVATE_KEY
#     (both on the federated path); sandbox/data has no resources and no TTL job (the CI apply must
#     create a fresh root, never change one this machine is using).
#   2 dispatch (asks "yes"): gh workflow run terraform.yml -f stage=sandbox -f stack=data -f action=apply
#     -f run=<ticket> -f ttl=1 (two buckets and a 256 GiB filesystem, ~$0.03 at most within the 1 h TTL);
#     find the run, gh run watch it, keep its log in state/ and report the token exchange line
#     ("Exported TF_VAR_iam_token ... (federated; expires_in N s)") and the apply outcome.
#   3 local teardown (Z5 step 3), ALWAYS after a dispatch, green or not: bootstrap sandbox/data,
#     make init STACK=data, the workflow's labels read back from state (nip-run, nip-ttl-expires), the
#     TTL job armed at that expiry FIRST (DRY=1, ttl_cancel data, CONFIRM=yes), make destroy-plan,
#     destroy (asks "yes"), make leftovers STACK=data, ttl_cancel data.
#   4 retirement (only when the apply run is green and the teardown left nothing): per account
#     (foundation ci_identities.sandbox = apply, ci_plan_identities.sandbox = plan) list the authorized
#     keys (nebius iam auth-public-key list-by-account), print ids and names, and ask you to TYPE RETIRE
#     (ASSUME_YES does not answer it); then delete each, re-list (must be 0) and remove
#     secrets/ci-sandbox*.pem. A key that Terraform registered (public_key_id output set) is refused:
#     remove it from the foundation instead, or Terraform recreates it.
# Evidence (git-ignored, for docs/evidence/<date>-sandbox-ci-federated-apply.md):
#   .cache/live/logs/A4-r13-federated-apply-<UTC>.log    this script's log
#   .cache/live/state/r13-run-<run id>.json              gh run view: url, conclusion, jobs, timings
#   .cache/live/state/r13-run-<run id>.log               the job log (secrets are masked by GitHub)
#   .cache/live/state/r13-leftovers-data.txt             make leftovers STACK=data after the destroy
#   .cache/live/state/r13-keys-<plan|apply>-before.json / -after.json   authorized keys (ids, no key material)
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
mode=all run_id=""
while (( $# )); do
  case "$1" in
    --teardown-only) mode=teardown; shift ;;
    --retire-only) mode=retire; shift ;;
    --run-id) run_id="${2:-}"; shift 2 ;;
    *) die "usage: $0 [--teardown-only | --retire-only --run-id <id>]" ;;
  esac
done
[[ "${mode}" != retire || "${run_id}" =~ ^[0-9]+$ ]] || die "--retire-only needs --run-id <the green apply run's id>"
step_init A4-r13-federated-apply
header "Z5 - R13 federated CI apply (sandbox/data), local teardown, CI key retirement" \
  "gh workflow run terraform.yml stage=sandbox stack=data action=apply ttl=1; watch; teardown here; then list and delete the CI authorized keys of both sandbox accounts (typed RETIRE)" \
  "about \$0.03 (256 GiB filesystem for under 1 h; IAM and GitHub \$0)" "about 15-25 min" \
  "the RESULT block (run URL and conclusion, token exchange line, teardown, keys before/after)"
need gh jq nebius terraform make
check_repo
load_env
GH_R="${GH_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
[[ "${GH_R}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "cannot tell the GitHub repository (got '${GH_R}'); set GH_REPO=<owner>/<repo>"
DATA=terraform/live/sandbox/data
report=()

# key_path_left: environments that still hold NIP_SA_PRIVATE_KEY (the key path). Read-only.
key_path_left() {
  local e left=""
  for e in sandbox sandbox-plan; do
    if gh api "repos/${GH_R}/environments/${e}/secrets" --jq '.secrets[].name' 2>/dev/null | grep -qx NIP_SA_PRIVATE_KEY; then left="${left} ${e}"; fi
  done
  printf '%s' "${left# }"
}

# --- 3: local teardown of the CI-applied root ----------------------------------------------------
teardown() {
  boot data
  run make init STACK=data
  if ! root_has_state data; then
    report+=("teardown: sandbox/data state empty (verified): nothing to destroy")
  else
    L() { terraform -chdir="${DATA}" show -json | jq -r --arg k "$1" '[.. | objects | .labels? | objects | .[$k] // empty] | first // empty'; }
    TF_VAR_labels="$(jq -cn --arg r "$(L nip-run)" --arg e "$(L nip-ttl-expires)" '{"nip-env":"data","nip-owner":"platform","nip-run":$r,"nip-ttl-expires":$e}')"
    export TF_VAR_labels
    jq -e '.["nip-run"] != "" and .["nip-run"] != "null" and (.["nip-ttl-expires"] | test("^[0-9]{4}-"))' <<<"${TF_VAR_labels}" >/dev/null \
      || die "the applied labels could not be read back from state (${TF_VAR_labels}): not destroying blind. Its CI TTL is ~1 h; rerun --teardown-only, or abort.sh"
    say "labels read back from state: ${TF_VAR_labels}"
    local exp; exp="$(jq -r '.["nip-ttl-expires"]' <<<"${TF_VAR_labels}")"
    if (( $(nip_epoch "${exp}") > $(nip_now) + 120 )); then
      ttl_arm data TTL="${exp}"
      FAIL_HINT="data TTL job armed for ${exp}; it stays armed. Rerun bash ${LIVE_DIR}/A4-r13-federated-apply.sh --teardown-only, or abort.sh"
    else
      say "nip-ttl-expires ${exp} is (almost) past: no TTL job armed; destroying now"
    fi
    local pf line; pf="$(mktemp)"
    run make destroy-plan STACK=data 2>&1 | tee "${pf}"
    line="$(grep -E '^Plan:|No changes' "${pf}" | tail -1 || true)"; rm -f "${pf}"
    confirm "Destroy the CI-applied sandbox/data (${line})?"
    run make destroy STACK=data CONFIRM=yes
    report+=("teardown: sandbox/data destroyed (${line})")
  fi
  run make leftovers STACK=data 2>&1 | tee "${STATE_DIR}/r13-leftovers-data.txt"
  ttl_cancel data || die "ttl_cancel data did not return 0"
  FAIL_HINT=""
  root_has_state data && die "sandbox/data still lists resources after the destroy"
  report+=("make leftovers STACK=data: $(grep -v '^>>>' "${STATE_DIR}/r13-leftovers-data.txt" | tail -1)")
}

# --- 4: retire the CI authorized keys of both sandbox accounts -------------------------------------
retire() {
  local left; left="$(key_path_left)"
  [[ -z "${left}" ]] || die "GitHub environment(s) ${left} still hold NIP_SA_PRIVATE_KEY (the key path): deleting the keys would break them. Remove those secrets first (runbooks/identity.md, First federated run step 1)"
  say ">>> source scripts/bootstrap-backend.sh foundation foundation"
  set +e +u +o pipefail
  # shellcheck source=/dev/null
  source scripts/bootstrap-backend.sh foundation foundation >/dev/null; local brc=$?
  set -euo pipefail
  (( brc == 0 )) || die "bootstrap of the foundation root failed (message above)"
  local kind out sa pk ids n
  # (bash 3.2 on macOS: no associative arrays; SA_<kind> / IDS_<kind> instead)
  # shellcheck disable=SC2034  # read through ${!sv} / ${!iv}
  local SA_apply="" SA_plan="" IDS_apply="" IDS_plan=""
  for kind in apply plan; do
    out="ci_identities"; [[ "${kind}" == plan ]] && out="ci_plan_identities"
    sa="$(terraform -chdir=terraform/live/foundation output -json "${out}" | jq -r '.sandbox.service_account_id // empty')"
    pk="$(terraform -chdir=terraform/live/foundation output -json "${out}" | jq -r '.sandbox.public_key_id // empty')"
    [[ "${sa}" =~ ^serviceaccount- ]] || die "no ${out}.sandbox.service_account_id in the foundation outputs (got '${sa}')"
    [[ -z "${pk}" ]] || die "${out}.sandbox.public_key_id is set (${pk}): Terraform registered that key; remove it from terraform/live/foundation, not with the CLI"
    nebius --profile "${NEBIUS_PROFILE}" iam auth-public-key list-by-account --account-service-account-id "${sa}" --format json \
      | jq '{items: [(.items // [])[] | {id: .metadata.id, name: .metadata.name, created_at: .metadata.created_at, expires_at: .spec.expires_at, state: .status.state}]}' \
      > "${STATE_DIR}/r13-keys-${kind}-before.json"
    ids="$(jq -r '.items[].id // empty' "${STATE_DIR}/r13-keys-${kind}-before.json")"
    n="$(jq '.items | length' "${STATE_DIR}/r13-keys-${kind}-before.json")"
    say "${kind} account ${sa}: ${n} authorized key(s)"
    jq -r '.items[] | "  \(.id)  \(.name // "-")  created \(.created_at // "?")  expires \(.expires_at // "?")  \(.state // "")"' "${STATE_DIR}/r13-keys-${kind}-before.json"
    printf -v "SA_${kind}" '%s' "${sa}"; printf -v "IDS_${kind}" '%s' "${ids}"
  done
  if [[ -z "${IDS_apply}${IDS_plan}" ]]; then report+=("retirement: no authorized key left on either sandbox CI account (nothing deleted)"); return 0; fi
  need_tty
  local a; read -r -p "Delete EVERY key listed above (both sandbox CI accounts) and remove secrets/ci-sandbox*.pem? This is not answered by ASSUME_YES. Type RETIRE: " a
  [[ "${a}" == RETIRE ]] || { report+=("retirement: NOT confirmed (typed '${a}'); no key deleted"); return 0; }
  local id sv iv
  for kind in apply plan; do
    sv="SA_${kind}" iv="IDS_${kind}"
    for id in ${!iv}; do
      run nebius --profile "${NEBIUS_PROFILE}" iam auth-public-key delete --id "${id}"
    done
    nebius --profile "${NEBIUS_PROFILE}" iam auth-public-key list-by-account --account-service-account-id "${!sv}" --format json \
      | jq '{items: [(.items // [])[] | {id: .metadata.id, name: .metadata.name}]}' > "${STATE_DIR}/r13-keys-${kind}-after.json"
    n="$(jq '.items | length' "${STATE_DIR}/r13-keys-${kind}-after.json")"
    [[ "${n}" == 0 ]] || die "the ${kind} account still lists ${n} key(s) after the deletes (see ${STATE_DIR}/r13-keys-${kind}-after.json)"
    report+=("retirement: ${kind} account ${!sv}: $(wc -w <<<"${!iv}" | tr -d ' ') key(s) deleted, 0 listed after")
  done
  local f
  for f in "${REPO}"/secrets/ci-sandbox*.pem; do
    [[ -f "${f}" ]] || continue
    if command -v shred >/dev/null 2>&1; then shred -u "${f}"; else rm -P "${f}" 2>/dev/null || rm -f "${f}"; fi
    report+=("removed ${f#"${REPO}"/}")
  done
  report+=("next: runbooks/credential-rotation.md says sandbox has no CI service-account key; the state keys remain")
}

# --- 2: dispatch and watch -----------------------------------------------------------------------
gate_ok=1 conclusion=""
if [[ "${mode}" == all ]]; then
  left="$(key_path_left)"
  [[ -z "${left}" ]] || die "GitHub environment(s) ${left} hold NIP_SA_PRIVATE_KEY: the jobs would take the key path, not federation. Remove it first (runbooks/identity.md)"
  [[ "$(gh variable get NIP_TERRAFORM_ENABLED -R "${GH_R}" 2>/dev/null || true)" == true ]] || die "repository variable NIP_TERRAFORM_ENABLED is not 'true': terraform.yml stops at its gate"
  ! ttl_running data || die "a TTL job for sandbox/data is running: another session uses that root"
  boot data
  run make init STACK=data
  if root_has_state data; then die "sandbox/data already has resources: the CI apply must create a fresh root. Tear it down first (run2-10-teardown.sh, or this script with --teardown-only)"; fi
  T="${NIP_RUN:-live-$(date -u +%Y%m%d)-r13}"
  run_ticket_ok "${T}" || die "nip-run '${T}' must be lowercase letters, digits, - or _"
  REF="${R13_REF:-main}"
  confirm "Dispatch terraform.yml on ${GH_R}@${REF}: stage=sandbox stack=data action=apply run=${T} ttl=1 (creates two buckets and a 256 GiB filesystem; this script tears them down)?"
  since="$(nip_utc $(( $(nip_now) - 120 )))"   # 2 min early: this clock and GitHub's may differ
  run gh workflow run terraform.yml -R "${GH_R}" --ref "${REF}" -f stage=sandbox -f stack=data -f action=apply -f run="${T}" -f ttl=1
  FAIL_HINT="a CI apply of sandbox/data was dispatched (its labels carry a 1 h TTL, but no local TTL job guards it yet): bash ${LIVE_DIR}/A4-r13-federated-apply.sh --teardown-only"
  for _ in $(seq 1 24); do
    run_id="$(gh run list -R "${GH_R}" --workflow terraform.yml --event workflow_dispatch --limit 10 --json databaseId,createdAt \
      --jq "[.[] | select(.createdAt >= \"${since}\")] | sort_by(.createdAt) | first | .databaseId // empty" || true)"
    [[ -n "${run_id}" ]] && break
    sleep 5
  done
  [[ -n "${run_id}" ]] || die "the dispatched run did not appear within 2 min: gh run list -R ${GH_R} --workflow terraform.yml"
  say "run ${run_id}: watching (gh run watch)"
  gh run watch "${run_id}" -R "${GH_R}" --interval 15 >/dev/null 2>&1 || true
  # Never tear down under a running CI apply: wait until GitHub reports the run completed (60 min).
  st=""
  for _ in $(seq 1 120); do
    st="$(gh run view "${run_id}" -R "${GH_R}" --json status --jq .status 2>/dev/null || true)"
    [[ "${st}" == completed ]] && break
    sleep 30
  done
  [[ "${st}" == completed ]] || die "run ${run_id} is still '${st:-unknown}' after 60 min: not tearing down under a running apply. Watch it (gh run watch ${run_id} -R ${GH_R}), then rerun with --teardown-only"
fi
if [[ "${mode}" == all || "${mode}" == retire ]]; then
  gh run view "${run_id}" -R "${GH_R}" --json url,conclusion,status,event,headBranch,displayTitle,createdAt,updatedAt,jobs > "${STATE_DIR}/r13-run-${run_id}.json"
  gh run view "${run_id}" -R "${GH_R}" --log > "${STATE_DIR}/r13-run-${run_id}.log" 2>/dev/null || true
  conclusion="$(jq -r '.conclusion // "unknown"' "${STATE_DIR}/r13-run-${run_id}.json")"
  report+=("run ${run_id}: $(jq -r '.url' "${STATE_DIR}/r13-run-${run_id}.json") conclusion=${conclusion}")
  while IFS= read -r j; do report+=("  job ${j}"); done < <(jq -r '.jobs[]? | "\(.name): \(.conclusion // .status)"' "${STATE_DIR}/r13-run-${run_id}.json")
  xline="$(grep -hoE 'Exported TF_VAR_iam_token for service account .*\(federated; expires_in [0-9?]+ s\)' "${STATE_DIR}/r13-run-${run_id}.log" | sed 's/for service account [^ ]* /for service account <masked> /' | sort -u | tr '\n' ';' || true)"
  report+=("token exchange: ${xline:-NOT FOUND in the job log (see ${STATE_DIR}/r13-run-${run_id}.log)}")
  aline="$(grep -hoE 'Apply complete! Resources: [0-9]+ added, [0-9]+ changed, [0-9]+ destroyed' "${STATE_DIR}/r13-run-${run_id}.log" | tail -1 || true)"
  report+=("apply: ${aline:-no 'Apply complete!' line in the job log}")
  # Retirement needs THIS run to be a green federated apply of sandbox/data: its apply job passed, the
  # log shows the federated exchange and a completed apply.
  japply="$(jq -r '[.jobs[]? | select(.name | startswith("apply sandbox/data")) | .conclusion] | first // "missing"' "${STATE_DIR}/r13-run-${run_id}.json")"
  report+=("apply job (sandbox/data): ${japply}")
  if [[ "${conclusion}" != success || "${japply}" != success ]]; then gate_ok=0; report+=("retirement not offered: the apply run is not green (run ${conclusion}, apply job ${japply})")
  elif [[ -z "${xline}" || -z "${aline}" ]]; then gate_ok=0; report+=("retirement not offered: the job log does not show both the federated exchange and 'Apply complete!'")
  fi
fi

if [[ "${mode}" == all || "${mode}" == teardown ]]; then teardown; fi
if [[ "${mode}" == teardown ]]; then gate_ok=0; report+=("--teardown-only: no retirement (rerun with --retire-only --run-id <green run>)"); fi
if (( gate_ok )); then retire; fi

result_begin
printf '  %s\n' "${report[@]}"
say "TTL data: $(ttl_status data)"
say "evidence inputs (git-ignored): ${LOG}; ${STATE_DIR}/r13-run-${run_id:-?}.{json,log}; ${STATE_DIR}/r13-leftovers-data.txt; ${STATE_DIR}/r13-keys-*-{before,after}.json"
say "write: docs/evidence/$(date -u +%F)-sandbox-ci-federated-apply.md (exchange shape, expires_in, job links, teardown, keys retired)"
if [[ "${mode}" == all && "${conclusion}" != success ]]; then say "VERDICT: FAIL (the federated apply run is ${conclusion}; torn down here)"; exit 1; fi
say "VERDICT: $([[ "${conclusion:-}" == success || "${mode}" == teardown ]] && echo PASS || echo CHECK)"
