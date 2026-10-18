#!/usr/bin/env bash
# Run 3 step 3: before the apply, so a failed apply is guarded too: make ttl-teardown DRY=1,
# ttl_cancel gpu-vm, CONFIRM=yes (2 h after the plan); then make apply STACK=gpu-vm CONFIRM=yes;
# then re-price recipes/finance/examples/gpu-vm-l40s-sandbox.json (its per-hour total feeds step 4).
# Refuses when fewer than 30 min are left before R3_EXP (2 h after run3-2's plan): a job firing
# during make apply fails on the state lock and exits, leaving the VM up with no TTL job.
# ttl_arm also refuses unless the cached IAM token lives until R3_EXP + 60 min.
# Executed: bash run3-3-apply.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run3-3-apply
header "Run 3 step 3 - TTL job, apply, re-price" \
  "TTL job for gpu-vm at the plan's expiry, make apply STACK=gpu-vm (1 preemptible L40S VM, public IP, API to the allowlist), price.py" \
  "\$0.7686/h: \$0.22 (17 min) to \$1.54 (2 h TTL)" "about 3-5 min (vLLM then needs about 8 min)" \
  "the RESULT block (TTL pid/time, apply outcome, per-hour price)"
need make jq terraform nebius python3
check_repo
load_env
state_load run3
[[ -n "${R3_CIDR:-}" && -n "${R3_PUBKEY:-}" && -f terraform/live/sandbox/gpu-vm/.run-profile.tfvars.json ]] || die "run run3-2-plan.sh first"
# The job fires at the rendered profile's label (what ttl-teardown.sh reads), normally = R3_EXP.
R3_EXP="$(jq -r '.labels["nip-ttl-expires"] // empty' terraform/live/sandbox/gpu-vm/.run-profile.tfvars.json)"
[[ "${R3_EXP}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || die "no nip-ttl-expires in the gpu-vm run profile: rerun bash ${LIVE_DIR}/run3-2-plan.sh"
left=$(( ( $(nip_epoch "${R3_EXP}") - $(nip_now) ) / 60 ))
say "gpu-vm TTL time ${R3_EXP}: ${left} min from now (apply + vLLM + bench need >= 30 min)"
(( left >= 30 )) || die "only ${left} min before the gpu-vm TTL time ${R3_EXP}: a TTL job firing during make apply would fail on the state lock and leave the VM up with no TTL job. Rerun bash ${LIVE_DIR}/run3-2-plan.sh for a fresh 2 h, then this step"

boot gpu-vm
TF_VAR_allowed_cidrs="$(jq -cn --arg c "${R3_CIDR}" '[$c]')"; TF_VAR_ssh_public_key="$(cat "${R3_PUBKEY}")"
export TF_VAR_allowed_cidrs TF_VAR_ssh_public_key   # the TTL job's destroy-plan needs them
ttl_arm gpu-vm PROFILE=l40s-preemptible
FAIL_HINT="gpu-vm TTL job armed for ${R3_EXP:-?} (pid $(cat terraform/live/sandbox/gpu-vm/.terraform/ttl-teardown.pid)); it stays armed. bash ${LIVE_DIR}/run3-5-teardown.sh, or abort.sh"
confirm "Apply sandbox/gpu-vm (preemptible L40S VM, about \$0.77/h, TTL ${R3_EXP:-?})?"
[[ -n "${R3_APPLY_AT:-}" ]] || state_set run3 R3_APPLY_AT "$(nip_now)"
run make apply STACK=gpu-vm CONFIRM=yes

NEBIUS_IAM_TOKEN="$(nebius --profile "${NEBIUS_PROFILE}" iam get-access-token)"; export NEBIUS_IAM_TOKEN
out="${STATE_DIR}/price-run3.json"
say ">>> python3 recipes/finance/price.py recipes/finance/examples/gpu-vm-l40s-sandbox.json --project ${NEBIUS_PROJECT_ID} --json > ${out}"
# Not through run(): only the JSON answer may land in the file. The VM is up by now, so a failed
# re-price only warns (then pass BENCH_USD_PER_HOUR=0.7686 to step 4); it never fails the step.
hourly=""
if python3 recipes/finance/price.py recipes/finance/examples/gpu-vm-l40s-sandbox.json --project "${NEBIUS_PROJECT_ID}" --json > "${out}"; then
  hourly="$(jq -r '.scenarios.preemptible.hourly // empty' "${out}" || true)"
fi
if [[ -n "${hourly}" ]]; then state_set run3 R3_USD_PER_HOUR "${hourly}"
else say "WARNING: re-price failed or gave no preemptible per-hour total (see ${out}); the VM is up and its TTL job armed. Step 4: BENCH_USD_PER_HOUR=0.7686 bash ${LIVE_DIR}/run3-4-bench.sh"; fi

result_begin
say "apply sandbox/gpu-vm: done; TTL job: $(ttl_status gpu-vm)"
jq -r '(.rows[] | "  \(.item) [\(.offer)] \(.what) hourly=\(.hourly // "-") \(.note // "")"), "  preemptible per-hour total: \(.scenarios.preemptible.hourly // "-")"' "${out}" || say "  (no price answer in ${out})"
terraform -chdir=terraform/live/sandbox/gpu-vm output -json | jq -r '{public_ip: .public_ip.value, platform: .platform.value, model: .model.value}'
say "next: about 8 min for vLLM, then bash ${LIVE_DIR}/run3-4-bench.sh"
