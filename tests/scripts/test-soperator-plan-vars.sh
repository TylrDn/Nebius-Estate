#!/usr/bin/env bash
# The upstream recipe's terraform.tfvars sets slurm_login_ssh_root_public_keys = [""], and a
# -var-file beats TF_VAR_*, so the documented `export TF_VAR_slurm_login_ssh_root_public_keys=...`
# never reached the plan ("SSH public keys must not be empty strings", live plan 2026-10-11).
# `make soperator-plan` must pass the exported keys as a -var after the var files.
# shellcheck disable=SC2016  # the expected text holds a literal ${...}
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
test_name="soperator-plan-ssh-keys"
out="$(TF_VAR_slurm_login_ssh_root_public_keys='["ssh-ed25519 AAAAmock op@host"]' make -s -n -C "${repo_root}" soperator-plan STAGE=sandbox)"
grep -qF -- '-var="slurm_login_ssh_root_public_keys=${TF_VAR_slurm_login_ssh_root_public_keys}"' <<<"${out}" \
  || fail "the exported keys must follow the var files as a -var: ${out}"
tr -d '\\\n' <<<"${out}" | grep -qE -- 'stage\.tfvars .*-var="slurm_login' || fail "the -var must come after the var files: ${out}"
ok "exported keys win over the recipe's empty list"
test_name="soperator-plan-no-keys"
out="$(env -u TF_VAR_slurm_login_ssh_root_public_keys make -s -n -C "${repo_root}" soperator-plan STAGE=sandbox)"
grep -q 'slurm_login_ssh_root_public_keys' <<<"${out}" && fail "no -var without exported keys: ${out}"
ok "no -var when nothing is exported"
test_name="soperator-destroy-plan"
# The destroy plan runs on the same three var files and the same exported keys as the plan.
out="$(TF_VAR_slurm_login_ssh_root_public_keys='["ssh-ed25519 AAAAmock op@host"]' make -s -n -C "${repo_root}" soperator-destroy-plan STAGE=lab)"
tr -d '\\\n' <<<"${out}" | grep -qE -- 'plan -destroy .*lab\.tfvars .*live/lab/soperator/stage\.tfvars .*-var="slurm_login.*-out=soperator-lab-destroy\.tfplan' \
  || fail "destroy plan: -destroy, the lab profile, the stage's tfvars, the keys, its own plan file: ${out}"
grep -q 'fetch-soperator.sh --stage lab' <<<"${out}" || fail "the recipe is fetched with the stage's backend first: ${out}"
out="$(make -s -n -C "${repo_root}" soperator-destroy-plan STAGE=staging MR_URL=https://example.invalid/mr/1)"
grep -qF -- '-var iam_merge_request_url=https://example.invalid/mr/1' <<<"${out}" || fail "the destroy plan passes MR_URL like the plan: ${out}"
ok "soperator-destroy-plan mirrors soperator-plan for the stage"
test_name="soperator-destroy-refusals"
for t in soperator-destroy-plan soperator-destroy; do
  set +e; out="$(make -s -C "${repo_root}" "${t}" STAGE=prod 2>&1)"; rc=$?; set -e
  (( rc != 0 )) || fail "${t} must refuse prod: ${out}"
  grep -q 'prod is torn down through the release process' <<<"${out}" || fail "${t} says why prod is refused: ${out}"
done
set +e; out="$(env -u CONFIRM make -s -C "${repo_root}" soperator-destroy STAGE=lab 2>&1)"; rc=$?; set -e
(( rc != 0 )) || fail "soperator-destroy must refuse without CONFIRM=yes: ${out}"
grep -q 'set CONFIRM=yes after reviewing soperator-lab-destroy.tfplan' <<<"${out}" || fail "the refusal names the plan to review: ${out}"
[[ -s "${LOG}" ]] && fail "a refused destroy must call nothing"
ok "soperator destroy targets refuse prod and an unconfirmed destroy"
test_name="soperator-apply-ttl-armed"
# The recipe labels nothing, so modules/stage-policy never sees a nip-ttl-expires: in a stage whose
# policy has require_ttl_label (sandbox, lab), soperator-apply refuses unless the stage's ttl-teardown
# job (make ttl-teardown STACK=soperator) is armed: its pid file names a live ttl-teardown process.
# Run in a copy of the repo so a real pid file under terraform/live/ is neither read nor written.
r="${work}/repo"; mkdir -p "${r}/scripts" "${r}/platform"
cp "${repo_root}/Makefile" "${r}/"; cp "${repo_root}/platform/stages.yaml" "${r}/platform/"
cp "${repo_root}/scripts/render-live-roots.py" "${repo_root}/scripts/ttl-armed.sh" "${r}/scripts/"
printf '#!/usr/bin/env bash\necho "tf-run $*" >> "$LOG"\n' > "${r}/scripts/tf-run.sh"; chmod +x "${r}/scripts/tf-run.sh"
for s in sandbox staging lab; do mkdir -p "${r}/terraform/live/${s}/soperator/.terraform"; done
pidfile="${r}/terraform/live/lab/soperator/.terraform/ttl-teardown.pid"
apply() { : > "${LOG}"; set +e; out="$(make -s -C "${r}" soperator-apply STAGE="$1" CONFIRM=yes 2>&1)"; rc=$?; set -e; }
refused_unarmed() { # <why>
  apply lab
  (( rc != 0 )) || fail "$1: soperator-apply must refuse lab without an armed TTL: ${out}"
  grep -q 'Refusing: lab requires a TTL.*make ttl-teardown STAGE=lab STACK=soperator' <<<"${out}" || fail "$1: the refusal names the safety net: ${out}"
  [[ -s "${LOG}" ]] && fail "$1: a refused apply must call nothing"
  return 0
}
refused_unarmed "no pid file"
sleep 60 & other=$!
echo "${other}" > "${pidfile}"; refused_unarmed "a live pid that is not ttl-teardown"
kill "${other}"; wait "${other}" 2>/dev/null || true
refused_unarmed "a dead pid"
bash -c 'sleep 60; :' ttl-teardown 2>/dev/null & armed=$!  # like the real job: bash stays the process (no exec)
echo "${armed}" > "${pidfile}"; apply lab
pkill -P "${armed}" 2>/dev/null || true; kill "${armed}"; wait "${armed}" 2>/dev/null || true
(( rc == 0 )) || fail "an armed TTL lets the apply run: ${out}"
grep -q 'tf-run .*soperator-lab.tfplan' "${LOG}" || fail "the armed apply runs tf-run.sh on the saved plan: $(calls)"
apply sandbox
(( rc != 0 )) || fail "sandbox also requires a TTL: ${out}"
apply staging
(( rc == 0 )) || fail "staging has no require_ttl_label: its apply is not gated on a TTL: ${out}"
ok "soperator-apply refuses a TTL-bound stage unless its ttl-teardown job is running"
