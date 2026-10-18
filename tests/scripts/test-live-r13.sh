#!/usr/bin/env bash
# scripts/live/A4-r13-federated-apply.sh: the R13 federated CI apply (Z5), its local teardown and the
# CI key retirement, against stub gh / nebius / terraform / make (no GitHub, no cloud).
# Guards: both environments must be on the federated path; the data root must be empty before the
# dispatch; the teardown always runs after a dispatch, with the TTL job armed from the labels read
# back from state before the destroy; keys are retired only after a green apply job whose log shows
# the federated exchange, only on a typed RETIRE (ASSUME_YES does not answer it), never for a key
# Terraform registered, and the re-list must be empty.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
unset ASSUME_YES NIP_RUN SSH_CONNECTION NEBIUS_PROJECT_ID NEBIUS_REGION NEBIUS_PROFILE GH_REPO R13_REF

R="${work}/repo"; L="${R}/scripts/live"
mkdir -p "${L}" "${R}/.nip-targets" "${R}/secrets" "${R}/terraform/live/sandbox/data" "${R}/terraform/live/foundation"
cp "${repo_root}/scripts/live/lib.sh" "${repo_root}/scripts/live/A4-r13-federated-apply.sh" "${L}/"
cp "${repo_root}/scripts/lib-time.sh" "${R}/scripts/"
for t in preflight init plan plan-summary apply destroy-plan destroy ttl-teardown kubeconfig leftovers leftovers-stage; do echo "${t}:"; done > "${R}/Makefile"
printf '#!/usr/bin/env bash\n' > "${R}/scripts/ttl-teardown.sh"; chmod +x "${R}/scripts/ttl-teardown.sh"
# The bootstrap, as far as these scripts check it: the target's ids, a state key and a token.
printf 'export TF_VAR_parent_id="${NEBIUS_PROJECT_ID}" TF_VAR_region="${NEBIUS_REGION}" AWS_ACCESS_KEY_ID=k AWS_SECRET_ACCESS_KEY=s TF_VAR_iam_token=t\necho "bootstrap $*" >> "${LOG}"\n' > "${R}/scripts/bootstrap-backend.sh"
printf 'project-e00fake0000000000test eu-north1\n' > "${R}/.nip-targets/sandbox"
printf 'NEBIUS_TENANT_ID=tenant-fake\nNEBIUS_PROFILE=p1\n' > "${R}/.env"; chmod 600 "${R}/.env"
mkdir -p "${HOME}/.nebius"; printf 'x:\n  federation/f/p1:\n    expires_at: 2099-01-01T00:00:00Z\n' > "${HOME}/.nebius/credentials.yaml"
S="${work}/sim"; mkdir -p "${S}"   # the simulated world: state, labels, keys, run outcome
export S

# The toolbox image has no ps: the stand-in of test-live-lib.sh, answering `ps -p <pid> [-o command=]`
# from /proc (a zombie counts as gone), so ttl_running/ttl_cancel run unchanged. On a Mac the real ps.
if ! command -v ps >/dev/null 2>&1; then
  stub ps 'p=""; o=""; while (( $# )); do case "$1" in -p) p="$2"; shift 2 ;; -o) o="$2"; shift 2 ;; *) shift ;; esac; done
[[ -r "/proc/${p}/cmdline" ]] || exit 1
[[ "$(cut -d" " -f3 "/proc/${p}/stat" 2>/dev/null)" != Z ]] || exit 1
if [[ "${o}" == command= ]]; then tr "\0" " " < "/proc/${p}/cmdline"; echo; else echo "${p}"; fi'
fi
stub gh 'case "$*" in
  "repo view"*) echo owner/repo ;;
  "api repos/owner/repo/environments/"*"/secrets"*) e="${2#repos/owner/repo/environments/}"; e="${e%/secrets}"; cat "$S/gh-secrets-$e" 2>/dev/null || true ;;
  "variable get NIP_TERRAFORM_ENABLED"*) echo true ;;
  "workflow run"*) printf "nebius_storage_v1_bucket.checkpoints\nnebius_compute_v1_filesystem.this\n" > "$S/state" ;;
  "run list"*) echo 777 ;;
  "run watch"*) : ;;
  "run view 777 -R owner/repo --json status"*) cat "$S/status" 2>/dev/null || echo completed ;;
  "run view 777 -R owner/repo --json"*) c="$(cat "$S/conclusion")"; printf "{\"url\":\"https://github.com/owner/repo/actions/runs/777\",\"conclusion\":\"%s\",\"event\":\"workflow_dispatch\",\"jobs\":[{\"name\":\"plan sandbox/data\",\"conclusion\":\"success\"},{\"name\":\"apply sandbox/data (reviewed plan)\",\"conclusion\":\"%s\"}]}\n" "$c" "$c" ;;
  "run view 777 -R owner/repo --log"*) echo "apply	Exported TF_VAR_iam_token for service account *** (federated; expires_in 43200 s)"; [[ "$(cat "$S/conclusion")" == success ]] && echo "apply	Apply complete! Resources: 4 added, 0 changed, 0 destroyed." ;;
esac'
stub terraform 'case "$*" in
  *"terraform/live/sandbox/data state list"*) cat "$S/state" 2>/dev/null || true ;;
  *"terraform/live/sandbox/data show -json"*) printf "{\"values\":{\"root_module\":{\"resources\":[{\"values\":{\"labels\":{\"nip-run\":\"live-r13\",\"nip-ttl-expires\":\"%s\"}}}]}}}\n" "$(cat "$S/exp")" ;;
  *"output -json ci_identities"*) echo "{\"sandbox\":{\"service_account_id\":\"serviceaccount-e00apply\",\"public_key_id\":$(cat "$S/pk" 2>/dev/null || echo null)}}" ;;
  *"output -json ci_plan_identities"*) echo "{\"sandbox\":{\"service_account_id\":\"serviceaccount-e00plan\",\"public_key_id\":null}}" ;;
esac'
stub make 'case "$*" in
  *"ttl-teardown"*"CONFIRM=yes"*) d=terraform/live/sandbox/data/.terraform; mkdir -p "$d"; ( bash -c "sleep 120; :" ttl-teardown >/dev/null 2>&1 & echo $! > "$d/ttl-teardown.pid" ) ;;
  "destroy-plan"*) echo "Plan: 0 to add, 0 to change, 2 to destroy." ;;
  "destroy STACK=data CONFIRM=yes"*) : > "$S/state" ;;
  "leftovers"*) echo "no leftovers for nip-stack=data" ;;
esac'
stub nebius 'a="$*"
case "$a" in
  *"list-by-account --account-service-account-id "*) sa="${a##*--account-service-account-id }"; sa="${sa%% *}"
    jq -Rn "{items: [inputs | select(length > 0) | {metadata: {id: ., name: \"ci-key\"}, spec: {expires_at: \"2026-12-01T00:00:00Z\"}}]}" < "$S/keys-$sa" ;;
  *"auth-public-key delete --id "*) id="${a##*--id }"; for f in "$S"/keys-*; do grep -vx "$id" "$f" > "$f.n" || true; mv "$f.n" "$f"; done ;;
esac'

# a4 <input> [args...]: the script on a pseudo-terminal, <input> typed at its prompts; $out, $rc.
a4() {
  local input="$1"; shift
  set +e
  out="$(cd "${R}" && env ASSUME_YES=1 LIVE_ALLOW_TMP=1 python3 - "${input}" bash "${L}/A4-r13-federated-apply.sh" "$@" <<'PY' 2>&1
import os, pty, subprocess, sys
m, s = pty.openpty()
p = subprocess.Popen(sys.argv[2:], stdin=s, stdout=s, stderr=s, close_fds=True)
os.close(s)
os.write(m, sys.argv[1].encode())
buf = b""
while True:
    try:
        d = os.read(m, 4096)
    except OSError:
        break
    if not d:
        break
    buf += d
sys.stdout.write(buf.decode(errors="replace"))
sys.exit(p.wait())
PY
)"
  rc=$?
  set -e
}
# The step re-points LOG (exported) at its own log, so the stubs' calls land there: read both.
calls_all() { cat "${LOG}" "${R}"/.cache/live/logs/*.log 2>/dev/null | grep -E '^(gh|nebius|terraform|make|bootstrap) ' || true; }
fresh() { # a green world: empty data root, both accounts with one key, environments federated
  : > "${S}/state"; echo success > "${S}/conclusion"; rm -f "${S}/pk" "${S}"/gh-secrets-*
  date -u -v+1H +%Y-%m-%dT%H:%M:%SZ > "${S}/exp" 2>/dev/null || date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ > "${S}/exp"
  echo authkey-e00a1 > "${S}/keys-serviceaccount-e00apply"; echo authkey-e00p1 > "${S}/keys-serviceaccount-e00plan"
  echo key > "${R}/secrets/ci-sandbox.pem"; : > "${LOG}"; rm -rf "${R}/.cache/live/logs"
}

test_name=live-r13-green-and-retire
fresh; a4 $'RETIRE\n'
(( rc == 0 )) || fail "a green apply, teardown and retirement exits 0 (rc ${rc}): ${out}"
grep -q '^gh workflow run terraform.yml -R owner/repo --ref main -f stage=sandbox -f stack=data -f action=apply -f run=live-[0-9]*-r13 -f ttl=1$' <(calls_all) || fail "the dispatch: sandbox/data apply, ttl=1, a run ticket"
grep -q 'token exchange: Exported TF_VAR_iam_token for service account <masked> (federated; expires_in 43200 s)' <<<"${out}" || fail "the exchange line is reported: ${out}"
grep -q 'apply: Apply complete! Resources: 4 added' <<<"${out}" || fail "the apply outcome is reported: ${out}"
order="$(grep -nE '^make (init STACK=data|ttl-teardown .*DRY=1|ttl-teardown .*CONFIRM=yes|destroy-plan STACK=data|destroy STACK=data CONFIRM=yes|leftovers STACK=data)' <(calls_all) | sed 's/^[0-9]*://' | sed -E 's/ TTL=[^ ]+//' | uniq | tr '\n' '|')"
[[ "${order}" == "make init STACK=data|make ttl-teardown STAGE=sandbox STACK=data DRY=1|make ttl-teardown STAGE=sandbox STACK=data CONFIRM=yes|make destroy-plan STACK=data|make destroy STACK=data CONFIRM=yes|make leftovers STACK=data|" ]] \
  || fail "teardown order: init, TTL armed (DRY then CONFIRM) BEFORE destroy-plan/destroy, leftovers: ${order}"
grep -q "ttl-teardown STAGE=sandbox STACK=data TTL=$(cat "${S}/exp")" <(calls_all) || fail "the TTL job fires at the label read back from state"
[[ ! -s "${S}/keys-serviceaccount-e00apply" && ! -s "${S}/keys-serviceaccount-e00plan" ]] || fail "both accounts' keys are deleted"
[[ ! -e "${R}/secrets/ci-sandbox.pem" ]] || fail "the local private key is removed"
grep -q 'retirement: apply account serviceaccount-e00apply: 1 key(s) deleted, 0 listed after' <<<"${out}" || fail "the retirement is reported per account: ${out}"
[[ -f "${R}/.cache/live/state/r13-run-777.json" && -f "${R}/.cache/live/state/r13-keys-plan-before.json" && -f "${R}/.cache/live/state/r13-keys-plan-after.json" ]] || fail "evidence inputs are kept in state/"
grep -q 'TTL data: NOT RUNNING' <<<"${out}" || fail "the TTL job is cancelled after the teardown: ${out}"
ok "dispatch, report, TTL-first teardown, typed RETIRE deletes both accounts' keys and the local key"

test_name=live-r13-retire-not-typed
fresh; a4 $'yes\n'
(( rc == 0 )) || fail "declining the retirement is not a failure (rc ${rc}): ${out}"
grep -q 'auth-public-key delete' <(calls_all) && fail "ASSUME_YES and a plain yes never delete keys"
[[ -s "${S}/keys-serviceaccount-e00apply" && -e "${R}/secrets/ci-sandbox.pem" ]] || fail "keys and the local key stay"
grep -q 'retirement: NOT confirmed' <<<"${out}" || fail "it says so: ${out}"
ok "only a typed RETIRE deletes keys (ASSUME_YES does not answer it)"

test_name=live-r13-red-run
fresh; echo failure > "${S}/conclusion"; a4 $'RETIRE\n'
(( rc == 1 )) || fail "a failed apply run exits 1 (rc ${rc})"
grep -q '^make destroy STACK=data CONFIRM=yes' <(calls_all) || fail "the teardown still runs after a red run (it may have created things)"
grep -q 'list-by-account\|auth-public-key delete' <(calls_all) && fail "no retirement after a red run"
grep -q 'retirement not offered: the apply run is not green' <<<"${out}" || fail "it says why: ${out}"
ok "a red run: torn down anyway, no retirement, exit 1"

test_name=live-r13-refusals
fresh; printf 'NIP_SA_PRIVATE_KEY\n' > "${S}/gh-secrets-sandbox-plan"; a4 ''
(( rc != 0 )) || fail "an environment on the key path is refused"
grep -q 'workflow run' <(calls_all) && fail "nothing is dispatched while an environment holds NIP_SA_PRIVATE_KEY"
grep -q 'sandbox-plan hold NIP_SA_PRIVATE_KEY' <<<"${out}" || fail "it names the environment: ${out}"
fresh; echo nebius_compute_v1_filesystem.this > "${S}/state"; a4 ''
(( rc != 0 )) || fail "a data root with resources is refused"
grep -q 'workflow run' <(calls_all) && fail "nothing is dispatched over an existing root"
fresh; echo '"authkey-tf"' > "${S}/pk"; a4 $'RETIRE\n' --retire-only --run-id 777
(( rc != 0 )) || fail "a Terraform-registered key is refused"
grep -q 'auth-public-key delete' <(calls_all) && fail "no CLI delete of a key Terraform registered"
grep -q 'public_key_id is set' <<<"${out}" || fail "it says why: ${out}"
fresh; echo in_progress > "${S}/status"
sed -i.bak 's/seq 1 120/seq 1 2/; s/sleep 30$/sleep 0/' "${L}/A4-r13-federated-apply.sh"; a4 ''
mv "${L}/A4-r13-federated-apply.sh.bak" "${L}/A4-r13-federated-apply.sh"; rm -f "${S}/status"
(( rc != 0 )) || fail "a run that is not completed is never torn down under"
calls_all | grep -q '^make destroy' && fail "no destroy while the CI apply may still run"
grep -q "still 'in_progress'" <<<"${out}" || fail "it says why: ${out}"
ok "key-path environments, an occupied data root, Terraform-registered keys and a run still in progress are refused"

test_name=live-r13-retire-only
fresh; a4 $'RETIRE\n' --retire-only --run-id 777
(( rc == 0 )) || fail "--retire-only after a green run (rc ${rc}): ${out}"
grep -q 'workflow run\|^make destroy' <(calls_all) && fail "--retire-only neither dispatches nor destroys"
[[ ! -s "${S}/keys-serviceaccount-e00plan" ]] || fail "it retires the keys"
ok "--retire-only checks the given run is a green federated apply, then retires"
