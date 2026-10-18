#!/usr/bin/env bash
# Run 4, part 1: R7 (stacks/network: VPC, subnets, custom NAT VM) in the lab stage, ONE command.
#   bash scripts/live/run4-r7.sh          (after L0-create-nip-lab.sh --apply; in a terminal or tmux)
# docs/plans/2026-10-12-live-runs.md "Run 4" steps 0-3. In order:
#   0 target: .nip-targets/lab, else the one nip-lab project (must be uk-south1); it must be empty
#     (scripts/leftovers.sh --stage lab --expect-empty) and have >= 4 non-GPU vCPU free
#   1 bootstrap lab/network (the first one binds lab to nip-lab: NIP_BOOTSTRAP_NEW_STAGE=1, its own
#     state bucket and identity); TF_VAR_labels nip-run + nip-ttl-expires = now + 3 h; make preflight
#     (GO); make init plan; TTL job armed BEFORE the apply (DRY=1, ttl_cancel, CONFIRM=yes); apply (asks)
#   2 acceptance without a cluster: the NAT VM nip-lab-network-nat is RUNNING; the workload subnet
#     has a custom route table (spec.route_table_id) holding 0.0.0.0/0 with an allocation (the NAT's)
#     as next hop (vpc/routing/manage); results/lab-network.json
#   3 teardown, ALWAYS once something may exist: destroy-plan, destroy (asks), make leftovers
#     STACK=network, ttl_cancel network, then the stage gate (leftovers --stage lab --expect-empty)
# Exit 0: applied, accepted, torn down, gate clean; 3: torn down and clean but the acceptance failed;
# 1: stopped before the apply (nothing created), or the teardown / gate failed (abort: the RESULT
# block names the TTL job that still guards the root).
# Evidence (git-ignored): .cache/live/logs/run4-r7-<UTC>.log, results/lab-network.json,
# .cache/live/state/lab-r7-gate.txt -> docs/evidence/<date>-lab-network.md
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib-lab.sh"
step_init run4-r7
header "Run 4 / R7 - lab network (VPC + NAT VM) in nip-lab, uk-south1" \
  "bootstrap lab/network, preflight, plan, TTL (3 h) before the apply, apply, NAT/route acceptance, destroy, leftovers, stage gate" \
  "about \$0.14/h (cpu-d3 4vcpu-16gb NAT VM + 50 GiB SSD, uk-south1 rates of 2026-10-07/08): about \$0.05 for 20 min, \$0.41 at the 3 h TTL" \
  "about 15-20 min" "the RESULT block (preflight, apply, NAT state, route, teardown, gate)"
need make jq terraform nebius
check_repo
lab_target
T="${NIP_RUN:-live-$(date -u +%Y%m%d)-r7}"
run_ticket_ok "${T}" || die "nip-run '${T}' must be lowercase letters, digits, - or _"
ROOT=terraform/live/lab/network
summary=()

ttl_running network && die "a TTL job for lab/network is already running: another run uses this root"
lab_stage_gate lab-r7-before.txt || die "the lab project is not empty (listed above): this run must start from nothing"
lab_vcpu_free 4

lab_boot network
TF_VAR_labels="$(lab_labels "${T}" 3)"; export TF_VAR_labels
EXP="$(jq -r '.["nip-ttl-expires"]' <<<"${TF_VAR_labels}")"
say "TF_VAR_labels=${TF_VAR_labels}"
preflight_go STAGE=lab STACK=network; summary+=("${PREFLIGHT_LINE}")
run make init STAGE=lab STACK=network
run make plan STAGE=lab STACK=network
make -s plan-summary STAGE=lab STACK=network || true
ttl_arm network TTL="${EXP}"
FAIL_HINT="lab/network TTL job armed for ${EXP}; it stays armed. Rerun this script's teardown by hand: make destroy-plan STAGE=lab STACK=network && make destroy STAGE=lab STACK=network CONFIRM=yes"
confirm "Apply lab/network (NAT VM, about \$0.14/h, TTL ${EXP})?"
apply_rc=0
run make apply STAGE=lab STACK=network CONFIRM=yes || apply_rc=$?
(( apply_rc == 0 )) && summary+=("apply lab/network: done") || summary+=("apply lab/network: FAILED (rc ${apply_rc}); tearing down what was created")

# --- acceptance (read-only) ---
acc=fail
if (( apply_rc == 0 )); then
  nat="$(nebius --profile "${NEBIUS_PROFILE}" compute instance get-by-name --parent-id "${NEBIUS_PROJECT_ID}" --name nip-lab-network-nat --format json 2>/dev/null || true)"
  nat_state="$(jq -r '.status.state // "unknown"' <<<"${nat:-null}" 2>/dev/null || echo unknown)"
  subnet="$(terraform -chdir="${ROOT}" output -raw subnet_id 2>/dev/null || true)"
  rt="" routes='[]' default_route=no
  if [[ -n "${subnet}" ]]; then
    # The custom route table (spec.route_table_id); status.route_table may be the network's default one.
    rt="$(nebius --profile "${NEBIUS_PROFILE}" vpc subnet get --id "${subnet}" --format json 2>/dev/null | jq -r '.spec.route_table_id // empty' || true)"
    if [[ -n "${rt}" ]]; then
      routes="$(nebius --profile "${NEBIUS_PROFILE}" vpc route list --parent-id "${rt}" --format json 2>/dev/null | jq -c '[(.items // [])[] | {name: .metadata.name, destination: (.spec.destination.cidr // null), via_allocation: ((.spec.next_hop.allocation.id // "") != "")}]' || echo '[]')"
      if jq -e 'any(.[]; .destination == "0.0.0.0/0" and .via_allocation)' <<<"${routes}" >/dev/null; then default_route=yes; fi
    fi
  fi
  [[ "${nat_state}" == RUNNING && -n "${rt}" && "${default_route}" == yes ]] && acc=pass
  mkdir -p results
  jq -n --arg s "${acc}" --arg ts "$(date -u +%FT%TZ)" --arg nat "${nat_state}" --arg rt "${rt:+set}" --argjson routes "${routes}" --arg dr "${default_route}" \
    '{step:"lab-network", status:$s, timestamp:$ts, details:{stage:"lab", region:"uk-south1", nat_vm_state:$nat, workload_route_table:($rt != ""), routes:$routes, default_route_via_nat:($dr == "yes"),
      not_shown:"egress through the NAT from a workload (tests/validate/network.sh needs a cluster in the workload subnet)"}}' > results/lab-network.json
  summary+=("acceptance: ${acc} (NAT VM ${nat_state}; workload route table ${rt:+present}${rt:-MISSING}; 0.0.0.0/0 route ${default_route})")
fi

# --- teardown (always after an apply attempt) ---
pf="$(mktemp)"
run make destroy-plan STAGE=lab STACK=network 2>&1 | tee "${pf}"
line="$(grep -E '^Plan:|No changes' "${pf}" | tail -1 || true)"; rm -f "${pf}"
confirm "Destroy lab/network (${line})?"
run make destroy STAGE=lab STACK=network CONFIRM=yes
summary+=("destroy lab/network: done (${line})")
run make leftovers STAGE=lab STACK=network 2>&1 | tee "${STATE_DIR}/lab-r7-leftovers.txt"
ttl_cancel network || die "ttl_cancel network did not return 0"
FAIL_HINT=""
gate=0; lab_stage_gate lab-r7-gate.txt || gate=$?
summary+=("stage gate (leftovers --stage lab --expect-empty): $( (( gate == 0 )) && echo clean || echo "NOT CLEAN (rc ${gate})")")

result_begin
printf '  %s\n' "${summary[@]}"
say "TTL lab/network: $(ttl_status network)"
say "evidence: ${LOG}; results/lab-network.json; ${STATE_DIR}/lab-r7-gate.txt -> docs/evidence/$(date -u +%F)-lab-network.md"
if (( gate != 0 )); then say "VERDICT: FAIL (the lab project is not empty: see ${STATE_DIR}/lab-r7-gate.txt)"; exit 1; fi
if [[ "${acc}" != pass ]]; then say "VERDICT: PARTIAL (torn down and clean; acceptance ${acc})"; exit 3; fi
say "VERDICT: PASS"
say "next: bash ${LIVE_DIR}/run4-r4.sh"
