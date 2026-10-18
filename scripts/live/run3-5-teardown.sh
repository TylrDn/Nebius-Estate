#!/usr/bin/env bash
# Run 3 step 5: make destroy-plan STACK=gpu-vm PROFILE=l40s-preemptible; make destroy STACK=gpu-vm
# CONFIRM=yes; make leftovers STACK=gpu-vm; ttl_cancel gpu-vm (must return 0); remove
# .run-profile.tfvars.json. Skips the destroy when the root's state is already empty.
# Executed: bash run3-5-teardown.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run3-5-teardown
header "Run 3 step 5 - R10 teardown" \
  "destroy-plan, destroy, leftovers for gpu-vm; cancel its TTL job; remove the rendered run profile" \
  "\$0; stops \$0.77/h" "about 2-4 min" "the RESULT block (Plan line, leftovers, TTL state)"
need make jq terraform nebius
check_repo
load_env
state_load run3
R=terraform/live/sandbox/gpu-vm

boot gpu-vm
key="${R3_PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
[[ -f "${key}" ]] || die "SSH public key ${key} not found (ssh_public_key is a required input of the destroy plan)"
TF_VAR_ssh_public_key="$(cat "${key}")"; export TF_VAR_ssh_public_key
if [[ -n "${R3_CIDR:-}" ]]; then TF_VAR_allowed_cidrs="$(jq -cn --arg c "${R3_CIDR}" '[$c]')"; export TF_VAR_allowed_cidrs; fi
run make init STACK=gpu-vm
line="state empty (verified), skipped"
if root_has_state gpu-vm; then
  pf="$(mktemp)"
  run make destroy-plan STACK=gpu-vm PROFILE=l40s-preemptible 2>&1 | tee "${pf}"
  line="$(grep -E '^Plan:|No changes' "${pf}" | tail -1 || true)"; rm -f "${pf}"
  confirm "Destroy sandbox/gpu-vm (${line})?"
  run make destroy STACK=gpu-vm CONFIRM=yes
  state_set run3 R3_DESTROYED_AT "$(nip_now)"
fi
run make leftovers STACK=gpu-vm 2>&1 | tee "${STATE_DIR}/leftovers-gpu-vm.txt"
ttl_cancel gpu-vm || die "ttl_cancel gpu-vm did not return 0"
rm -f "${R}/.run-profile.tfvars.json"
state_load run3

result_begin
say "gpu-vm: ${line}"
if [[ -n "${R3_APPLY_AT:-}" && -n "${R3_DESTROYED_AT:-}" ]]; then
  awk -v a="${R3_APPLY_AT}" -v e="${R3_DESTROYED_AT}" -v r="${R3_USD_PER_HOUR:-0.7686}" 'BEGIN{h=(e-a)/3600; printf "spend estimate: %.2f h x $%s/h = $%.2f (not a bill)\n", h, r, h*r}'
fi
say "--- make leftovers STACK=gpu-vm"; grep -v '^>>>' "${STATE_DIR}/leftovers-gpu-vm.txt" | sed 's/^/  /'
if ttl_running gpu-vm; then say "TTL gpu-vm: STILL RUNNING"; else say "TTL gpu-vm: none (cancelled)"; fi
say ".run-profile.tfvars.json removed"
say "next: when run 2 is torn down too: bash ${LIVE_DIR}/run2-11-leftovers.sh"
