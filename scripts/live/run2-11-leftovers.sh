#!/usr/bin/env bash
# Run 2 step 11 (the gate after BOTH run 2 and run 3 are destroyed): make leftovers-stage
# STAGE=sandbox must print only "no leftovers in <project> for nip-stage=sandbox (state bucket
# excluded by design)" and exit 0 (it does not see SecretStash; step 10 deleted the R12 secret).
# The gate also fails while the R6 endpoint exists (results/serverless-endpoint.state, or found by
# name): make leftovers-stage does not list AI endpoints. Only when that gate is clean: ttl_cancel inference, ml-services, data, gpu-vm (each returns 0) and
# remove .run-profile.tfvars.json, saved plans, .cache/kubeconfig-sandbox-inference
# (runbooks/teardown.md) and the run inputs file ml-services/zz-run.auto.tfvars.json. When the gate
# is not clean, every TTL job and every run input stays in place (a retried destroy-plan needs them).
# Refuses while run 3 is planned or applied (gpu-vm/.run-profile.tfvars.json exists; run3-5 removes
# it), so it can never race a run-3 terminal between run3-2 and run3-3.
# Executed: bash run2-11-leftovers.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-11-leftovers
header "Run 2 step 11 - stage leftovers gate and local cleanup" \
  "make leftovers-stage STAGE=sandbox (read-only gate); cancel TTL jobs; remove run-profile, saved plans, kubeconfig, zz-run inputs" \
  "\$0" "about 1-2 min" "the RESULT block (the gate's output and exit code)"
need make jq nebius terraform
check_repo
load_env

# Run 3's VM shows up in the gate while it exists: refuse until gpu-vm is destroyed. A run profile
# means run 3 is planned (run3-2) or applied and not yet torn down by run3-5.
[[ ! -f terraform/live/sandbox/gpu-vm/.run-profile.tfvars.json ]] \
  || die "terraform/live/sandbox/gpu-vm/.run-profile.tfvars.json exists: run 3 is planned or applied. Run run3-5-teardown.sh first (it removes the file)"
if [[ -f terraform/live/sandbox/gpu-vm/.terraform/terraform.tfstate || -d terraform/live/sandbox/gpu-vm/.terraform ]]; then
  boot gpu-vm
  run make init STACK=gpu-vm >/dev/null
  if root_has_state gpu-vm; then die "the gpu-vm root (run 3) still has resources: run run3-5-teardown.sh first"; fi
fi

# R6 (run2-8) is invisible to make leftovers-stage and has no TTL job: part of the gate.
erc=0; ep="$(r6_endpoint_left)" || erc=$?
case "${erc}" in
  0) ep_line="R6 endpoint: STILL THERE (bills): ${ep}. Delete: recipes/serverless/endpoint.sh delete, or nebius --profile ${NEBIUS_PROFILE} ai endpoint delete --id <id>" ;;
  1) ep_line="R6 endpoint: none (no state file, none named ${ENDPOINT_NAME:-nip-vllm-compare})" ;;
  *) ep_line="R6 endpoint: NOT CHECKED: ${ep}" ;;
esac
say "${ep_line}"

out="${STATE_DIR}/leftovers-stage.txt"
rc=0; run make leftovers-stage STAGE=sandbox 2>&1 | tee "${out}" || rc=$?
clean=no
if (( rc == 0 && erc == 1 )) && grep -qE '^no leftovers in .* for nip-stage=sandbox \(state bucket excluded by design\)' "${out}"; then clean=yes; fi

if [[ "${clean}" != yes ]]; then
  result_begin
  say "make leftovers-stage STAGE=sandbox: exit ${rc}; clean=${clean}"
  grep -v '^>>>' "${out}" | sed 's/^/  /'
  say "${ep_line}"
  for s in inference ml-services data gpu-vm; do
    if ttl_running "${s}"; then say "  TTL ${s}: STILL ARMED (left in place)"; else say "  TTL ${s}: none"; fi
  done
  say "nothing removed: run profiles, saved plans, kubeconfig and zz-run inputs kept for a retried destroy"
  say "GATE FAILED: something is left in the sandbox project (listed above). Destroy it (run2-10-teardown.sh / run3-5-teardown.sh / abort.sh, or delete by hand), then rerun this step"
  exit 1
fi

for s in inference ml-services data gpu-vm; do ttl_cancel "${s}" || die "ttl_cancel ${s} did not return 0"; done
removed=()
for f in terraform/live/sandbox/inference/.run-profile.tfvars.json terraform/live/sandbox/gpu-vm/.run-profile.tfvars.json \
         "${KCFG_REL}" terraform/live/sandbox/ml-services/zz-run.auto.tfvars.json \
         terraform/live/sandbox/{data,ml-services,inference,gpu-vm}/*.tfplan; do
  [[ -e "${f}" ]] || continue
  rm -f "${f}"; removed+=("${f}")
done

result_begin
say "make leftovers-stage STAGE=sandbox: exit ${rc}; clean=${clean}"
grep -v '^>>>' "${out}" | sed 's/^/  /'
for s in inference ml-services data gpu-vm; do
  if ttl_running "${s}"; then say "  TTL ${s}: STILL RUNNING"; else say "  TTL ${s}: none"; fi
done
say "${ep_line}"
say "removed: ${removed[*]:-nothing}"
say "gate clean. To start a fresh run-2/run-3 session later: RESET_SESSION=1 bash ${LIVE_DIR}/run2-0-preflight.sh"
