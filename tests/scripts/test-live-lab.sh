#!/usr/bin/env bash
# scripts/live/run4-r7.sh and run4-r4.sh (run 4 in the lab stage, nip-lab in uk-south1), against stub
# nebius / terraform / make / kubectl and a stub leftovers.sh (no cloud). Guards: the target is the
# lab binding, else the one nip-lab project, which must be in uk-south1 (the first bootstrap alone gets
# NIP_BOOTSTRAP_NEW_STAGE=1); the project must be empty and have the vCPU; the TTL job is armed BEFORE
# the apply; the teardown runs after any apply attempt (failed apply, failed acceptance); the stage
# gate decides the verdict.
# shellcheck disable=SC2016,SC2015  # stub bodies expand when the stub runs; "A && B || fail" fails when either does
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
unset ASSUME_YES NIP_RUN SSH_CONNECTION NEBIUS_PROJECT_ID NEBIUS_REGION NEBIUS_PROFILE SSH_PUBKEY

R="${work}/repo"; L="${R}/scripts/live"
mkdir -p "${L}" "${R}/terraform/live/lab/network" "${R}/terraform/live/lab/soperator" "${R}/platform"
cp "${repo_root}/scripts/live/lib.sh" "${repo_root}/scripts/live/lib-lab.sh" "${repo_root}/scripts/live/run4-r7.sh" "${repo_root}/scripts/live/run4-r4.sh" "${L}/"
cp "${repo_root}/scripts/lib-time.sh" "${R}/scripts/"
for t in preflight init plan plan-summary apply destroy-plan destroy ttl-teardown kubeconfig leftovers leftovers-stage; do echo "${t}:"; done > "${R}/Makefile"
printf '#!/usr/bin/env bash\n' > "${R}/scripts/ttl-teardown.sh"; chmod +x "${R}/scripts/ttl-teardown.sh"
# The bootstrap as these scripts see it; the first lab bind (NIP_BOOTSTRAP_NEW_STAGE=1) writes .nip-targets/lab.
cat > "${R}/scripts/bootstrap-backend.sh" <<'EOF'
echo "bootstrap $* new=${NIP_BOOTSTRAP_NEW_STAGE:-0}" >> "${LOG}"
if [[ ! -f .nip-targets/lab ]]; then
  [[ "${NIP_BOOTSTRAP_NEW_STAGE:-0}" == 1 ]] || { echo "no binding and no NIP_BOOTSTRAP_NEW_STAGE" >&2; return 1; }
  mkdir -p .nip-targets; echo "${NEBIUS_PROJECT_ID} ${NEBIUS_REGION}" > .nip-targets/lab
fi
export TF_VAR_parent_id="${NEBIUS_PROJECT_ID}" TF_VAR_region="${NEBIUS_REGION}" AWS_ACCESS_KEY_ID=k AWS_SECRET_ACCESS_KEY=s TF_VAR_iam_token=t
EOF
printf '#!/usr/bin/env bash\necho "leftovers.sh $*" >> "${LOG}"\nrc="$(cat "$S/gate_rc" 2>/dev/null || echo 0)"; (( rc == 0 )) && echo "nothing in the project" || echo "LEFT: disk-x"; exit "${rc}"\n' > "${R}/scripts/leftovers.sh"
chmod +x "${R}/scripts/leftovers.sh"
printf 'NEBIUS_TENANT_ID=tenant-fake\nNEBIUS_PROFILE=p1\n' > "${R}/.env"; chmod 600 "${R}/.env"
mkdir -p "${HOME}/.nebius" "${HOME}/.ssh"; printf 'x:\n  federation/f/p1:\n    expires_at: 2099-01-01T00:00:00Z\n' > "${HOME}/.nebius/credentials.yaml"
echo "ssh-ed25519 AAAAtest op@host" > "${HOME}/.ssh/id_ed25519.pub"
S="${work}/sim"; mkdir -p "${S}"; export S

# The toolbox image has no ps: the stand-in of test-live-lib.sh, answering `ps -p <pid> [-o command=]`
# from /proc (a zombie counts as gone), so ttl_running/ttl_cancel run unchanged. On a Mac the real ps.
if ! command -v ps >/dev/null 2>&1; then
  stub ps 'p=""; o=""; while (( $# )); do case "$1" in -p) p="$2"; shift 2 ;; -o) o="$2"; shift 2 ;; *) shift ;; esac; done
[[ -r "/proc/${p}/cmdline" ]] || exit 1
[[ "$(cut -d" " -f3 "/proc/${p}/stat" 2>/dev/null)" != Z ]] || exit 1
if [[ "${o}" == command= ]]; then tr "\0" " " < "/proc/${p}/cmdline"; echo; else echo "${p}"; fi'
fi
stub nebius 'a="$*"
case "$a" in
  *"iam v2 project list"*) cat "$S/projects" ;;
  *"quota-allowance list --parent-id tenant-fake"*) echo "{\"items\":[{\"metadata\":{\"name\":\"compute.instance.non-gpu.vcpu\"},\"spec\":{\"region\":\"uk-south1\",\"limit\":\"$(cat "$S/vcpu")\"},\"status\":{\"usage\":\"0\"}}]}" ;;
  *"quota-allowance list"*) echo "{\"items\":[]}" ;;
  *"compute instance get-by-name"*) echo "{\"status\":{\"state\":\"$(cat "$S/nat")\"}}" ;;
  *"vpc subnet get"*) echo "{\"spec\":{\"route_table_id\":\"vpcroutetable-x\"}}" ;;
  *"vpc route list"*) echo "{\"items\":[{\"metadata\":{\"name\":\"via-nat\"},\"spec\":{\"destination\":{\"cidr\":\"0.0.0.0/0\"},\"next_hop\":{\"allocation\":{\"id\":\"vpcallocation-x\"}}}}]}" ;;
esac'
stub terraform 'case "$*" in *"output -raw subnet_id"*) echo vpcsubnet-x ;; esac'
stub make 'a="$*"
case "$a" in
  *"ttl-teardown"*"CONFIRM=yes"*) s="${a##*STACK=}"; s="${s%% *}"; d="terraform/live/lab/$s/.terraform"; mkdir -p "$d"; ( bash -c "sleep 120; :" ttl-teardown >/dev/null 2>&1 & echo $! > "$d/ttl-teardown.pid" ) ;;
  "preflight"*) s="${a##*STACK=}"; echo "Preflight lab/${s%% *}: GO, 1 warning(s)" ;;
  "apply"*|"soperator-apply"*) exit "$(cat "$S/apply_rc" 2>/dev/null || echo 0)" ;;
  "destroy-plan"*|"soperator-destroy-plan"*) echo "Plan: 0 to add, 0 to change, 3 to destroy." ;;
esac'
stub kubectl 'a="$*"
case "$a" in
  *"chroot /mnt/jail sinfo --version"*) echo "slurm 25.05.0" ;;
  *"chroot /mnt/jail sinfo"*) echo "PARTITION AVAIL NODES STATE"; echo "main* up 1 idle" ;;
  *"chroot /mnt/jail sbatch"*) echo 4242 ;;
  *"chroot /mnt/jail sacct -j 4242 -n -X -o State"*) cat "$S/jstate" ;;
  *"chroot /mnt/jail sacct"*) echo "4242 $(cat "$S/jstate") 00:00:02 worker-0" ;;
esac'

# lab <script> [env...]: one run-4 script on a pseudo-terminal; $out, $rc.
lab() {
  local sc="$1"; shift
  set +e
  out="$(cd "${R}" && env ASSUME_YES=1 LIVE_ALLOW_TMP=1 "$@" python3 -c 'import os, pty, sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))' bash "${L}/${sc}" </dev/null 2>&1)"
  rc=$?
  set -e
}
calls_all() { cat "${LOG}" "${R}"/.cache/live/logs/*.log 2>/dev/null | grep -E '^(nebius|terraform|make|kubectl|bootstrap|leftovers.sh) ' || true; }
first() { calls_all | grep -nE "$1" | head -1 | cut -d: -f1; }
fresh() {
  echo '{"items":[{"metadata":{"id":"project-e00lab","name":"nip-lab"},"spec":{"region":"uk-south1"}},{"metadata":{"id":"project-e00other","name":"other"},"spec":{"region":"uk-south1"}}]}' > "${S}/projects"
  echo 200 > "${S}/vcpu"; echo RUNNING > "${S}/nat"; echo COMPLETED > "${S}/jstate"; rm -f "${S}/apply_rc" "${S}/gate_rc" "${R}/.nip-targets/lab"
  : > "${LOG}"; rm -rf "${R}/.cache/live/logs" "${R}/results"
}

test_name=live-lab-r7-first-bind
fresh; lab run4-r7.sh
(( rc == 0 )) || fail "R7 applied, accepted, torn down, gate clean: exit 0 (rc ${rc}): ${out}"
[[ "$(cat "${R}/.nip-targets/lab")" == "project-e00lab uk-south1" ]] || fail "the first bootstrap binds lab to nip-lab in uk-south1"
calls_all | grep -q '^bootstrap lab network new=1$' || fail "only the first bind gets NIP_BOOTSTRAP_NEW_STAGE=1: $(calls_all)"
arm="$(first '^make ttl-teardown STAGE=lab STACK=network TTL=.* CONFIRM=yes')"; app="$(first '^make apply STAGE=lab STACK=network CONFIRM=yes')"
[[ -n "${arm}" && -n "${app}" ]] && (( arm < app )) || fail "the TTL job is armed BEFORE the apply: $(calls_all)"
(( $(first '^leftovers.sh --stage lab --expect-empty') < $(first '^bootstrap lab network') )) || fail "the project is checked empty before anything is created"
(( $(first '^make destroy STAGE=lab STACK=network CONFIRM=yes') > app )) || fail "the destroy runs after the apply"
calls_all | grep -q '^make leftovers STAGE=lab STACK=network' || fail "make leftovers for the stack"
jq -e '.status == "pass" and .details.default_route_via_nat and .details.nat_vm_state == "RUNNING"' "${R}/results/lab-network.json" >/dev/null || fail "results/lab-network.json records the acceptance"
grep -q 'VERDICT: PASS' <<<"${out}" || fail "verdict: ${out}"
grep -q 'TTL lab/network: NOT RUNNING' <<<"${out}" || fail "the TTL job is cancelled after the teardown: ${out}"
ok "R7: binds lab to nip-lab, TTL before apply, NAT + route acceptance, destroy, leftovers, gate"

test_name=live-lab-r7-bound-again
: > "${LOG}"; rm -rf "${R}/.cache/live/logs"; lab run4-r7.sh
(( rc == 0 )) || fail "a second run on the existing binding (rc ${rc}): ${out}"
calls_all | grep -q '^bootstrap lab network new=0$' || fail "with a binding, no NIP_BOOTSTRAP_NEW_STAGE: $(calls_all)"
calls_all | grep -q 'iam v2 project list' && fail "with a binding the project is not looked up by name"
ok "an existing .nip-targets/lab is the target; no new-stage bootstrap"

test_name=live-lab-r7-acceptance-or-apply-fails
fresh; echo STOPPED > "${S}/nat"; lab run4-r7.sh
(( rc == 3 )) || fail "a failed acceptance with a clean teardown is PARTIAL, exit 3 (rc ${rc}): ${out}"
calls_all | grep -q '^make destroy STAGE=lab STACK=network CONFIRM=yes' || fail "torn down after a failed acceptance"
fresh; echo 1 > "${S}/apply_rc"; lab run4-r7.sh
(( rc == 3 )) || fail "a failed apply, torn down: exit 3 (rc ${rc}): ${out}"
calls_all | grep -q '^make destroy STAGE=lab STACK=network CONFIRM=yes' || fail "torn down after a failed apply (it may have created part)"
fresh; echo 1 > "${S}/gate_rc"; lab run4-r7.sh
(( rc == 1 )) || fail "a project that is not empty before the run is refused (rc ${rc})"
calls_all | grep -q '^bootstrap' && fail "nothing is bootstrapped in a project that is not empty"
ok "failed acceptance or apply: still torn down, exit 3; a non-empty project: refused before anything"

test_name=live-lab-target-refusals
fresh; echo '{"items":[{"metadata":{"id":"project-e00lab","name":"nip-lab"},"spec":{"region":"eu-north1"}}]}' > "${S}/projects"; lab run4-r7.sh
(( rc == 1 )) || fail "nip-lab outside uk-south1 is refused"
grep -q "is in 'eu-north1', not uk-south1" <<<"${out}" || fail "it says why: ${out}"
fresh; echo '{"items":[]}' > "${S}/projects"; lab run4-r7.sh
(( rc == 1 )) && grep -q 'L0-create-nip-lab.sh --apply' <<<"${out}" || fail "no nip-lab project: refused, naming L0: ${out}"
calls_all | grep -q '^bootstrap' && fail "nothing bootstrapped without the project"
ok "no nip-lab, or nip-lab in another region: refused, nothing created"

test_name=live-lab-r4
fresh; lab run4-r4.sh
(( rc == 0 )) || fail "R4 applied, job COMPLETED, torn down, gate clean: exit 0 (rc ${rc}): ${out}"
arm="$(first '^make ttl-teardown STAGE=lab STACK=soperator TTL=.* CONFIRM=yes')"; app="$(first '^make soperator-apply STAGE=lab CONFIRM=yes')"
[[ -n "${arm}" && -n "${app}" ]] && (( arm < app )) || fail "the soperator TTL job is armed BEFORE soperator-apply: $(calls_all)"
(( $(first '^make soperator-plan STAGE=lab') < arm )) || fail "plan, then TTL, then apply"
calls_all | grep -q 'kubectl --context nebius-nip-slurm -n soperator exec login-0 -c sshd -- chroot /mnt/jail sbatch' || fail "the job is submitted through the login pod"
(( $(first '^make soperator-destroy STAGE=lab CONFIRM=yes') > app )) || fail "soperator-destroy after the apply"
calls_all | grep -q '^kubectl config delete-context nebius-nip-slurm' || fail "the recipe's kube context is removed"
jq -e '.status == "pass" and .details.job_state == "COMPLETED"' "${R}/results/lab-soperator.json" >/dev/null || fail "results/lab-soperator.json records the job"
grep -q 'TTL lab/soperator: NOT RUNNING' <<<"${out}" || fail "the TTL job is cancelled after the teardown: ${out}"
ok "R4: plan, TTL before soperator-apply, sbatch COMPLETED, soperator-destroy, context removed, gate"

test_name=live-lab-r4-failures
fresh; echo FAILED > "${S}/jstate"; lab run4-r4.sh
(( rc == 3 )) || fail "a failed job, torn down: exit 3 (rc ${rc})"
calls_all | grep -q '^make soperator-destroy STAGE=lab CONFIRM=yes' || fail "torn down after a failed job"
fresh; echo 16 > "${S}/vcpu"; lab run4-r4.sh
(( rc == 1 )) && grep -q 'only 16 non-GPU vCPU free in uk-south1; this run needs 52' <<<"${out}" || fail "too little vCPU is refused before anything: ${out}"
calls_all | grep -q '^bootstrap' && fail "nothing bootstrapped without the vCPU"
ok "a failed job still tears down (exit 3); too little vCPU: refused before anything"
