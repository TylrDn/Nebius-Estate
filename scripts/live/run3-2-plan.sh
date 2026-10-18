#!/usr/bin/env bash
# Run 3 steps 1-2: R10 GPU VM. bootstrap gpu-vm; TF_VAR_allowed_cidrs = your /32 and
# TF_VAR_ssh_public_key from your .pub file (both kept in state/run3.env for the later steps and the
# TTL job); make preflight; make init STACK=gpu-vm (never a bare make init: that is inference);
# make plan STACK=gpu-vm PROFILE=l40s-preemptible RUN=<ticket> TTL_HOURS=2.
# Executed: bash run3-2-plan.sh   Optional env: NIP_RUN=<ticket>, MY_CIDR=x.x.x.x/32,
# SSH_PUBKEY=~/.ssh/<key>.pub (default ~/.ssh/id_ed25519.pub). Independent of run 2's scripts.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run3-2-plan
header "Run 3 steps 1-2 - R10 preflight, init, plan" \
  "bootstrap sandbox/gpu-vm, allowlist /32 + SSH key, make preflight (GO), make init STACK=gpu-vm, make plan PROFILE=l40s-preemptible TTL_HOURS=2" \
  "\$0 (plan only)" "about 2-3 min" "the RESULT block (Preflight line, plan summary, expiry)"
need make jq terraform nebius curl python3
check_repo
load_env
state_load run3

t="${NIP_RUN:-${R3_RUN:-}}"
[[ -n "${t}" ]] || t="live-$(date -u +%Y%m%d)-run3"
run_ticket_ok "${t}" || die "nip-run '${t}' must be lowercase letters, digits, - or _"
cidr="${MY_CIDR:-${R3_CIDR:-}}"
if [[ -z "${cidr}" ]]; then
  ip="$(curl -s -m 10 https://checkip.amazonaws.com | tr -d '[:space:]')"
  [[ "${ip}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "could not detect your public IPv4; pass MY_CIDR=x.x.x.x/32"
  cidr="${ip}/32"
  confirm "Allowlist ${cidr} (your current egress address) for SSH and the API?"
fi
[[ "${cidr}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/32$ ]] || die "MY_CIDR must be a /32 (got ${cidr})"
key="${SSH_PUBKEY:-${R3_PUBKEY:-$HOME/.ssh/id_ed25519.pub}}"
[[ -f "${key}" && "${key}" == *.pub ]] || die "SSH public key ${key} not found (SSH_PUBKEY=~/.ssh/<key>.pub)"
state_set run3 R3_RUN "${t}"; state_set run3 R3_CIDR "${cidr}"; state_set run3 R3_PUBKEY "${key}"

boot gpu-vm
TF_VAR_allowed_cidrs="$(jq -cn --arg c "${cidr}" '[$c]')"; TF_VAR_ssh_public_key="$(cat "${key}")"
export TF_VAR_allowed_cidrs TF_VAR_ssh_public_key
say "TF_VAR_allowed_cidrs=${TF_VAR_allowed_cidrs}  TF_VAR_ssh_public_key from ${key}"
preflight_go STAGE=sandbox STACK=gpu-vm PROFILE=l40s-preemptible
pline="${PREFLIGHT_LINE}"
run make init STACK=gpu-vm
run make plan STACK=gpu-vm PROFILE=l40s-preemptible RUN="${t}" TTL_HOURS=2
exp="$(jq -r '.labels["nip-ttl-expires"]' terraform/live/sandbox/gpu-vm/.run-profile.tfvars.json)"
state_set run3 R3_EXP "${exp}"

result_begin
say "${pline}"
make -s plan-summary STACK=gpu-vm || true
say "nip-run ${t}; nip-ttl-expires ${exp} (2 h); allowlist ${cidr}"
say "next: bash ${LIVE_DIR}/run3-3-apply.sh  (soon: the TTL counts from this plan)"
