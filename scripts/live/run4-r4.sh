#!/usr/bin/env bash
# Run 4, part 2: R4 (the upstream Soperator recipe, lab profile: CPU only) in the lab stage, ONE command.
#   bash scripts/live/run4-r4.sh          (after run4-r7.sh, or at least L0; in a terminal or tmux)
#   SSH_PUBKEY=~/.ssh/<key>.pub            the Slurm login key (default ~/.ssh/id_ed25519.pub)
# docs/plans/2026-10-12-live-runs.md "Run 4" steps 4-6. In order:
#   0 target (lib-lab.sh): nip-lab in uk-south1, EMPTY (leftovers --stage lab --expect-empty: R7 must be
#     torn down), >= 52 non-GPU vCPU free
#   1 bootstrap lab/soperator (binds lab on the first run); the login key; make preflight STAGE=lab
#     STACK=soperator (GO; the TTL warning is expected); make soperator-plan STAGE=lab; the TTL job
#     (now + 3 h) armed BEFORE the apply: the recipe labels nothing, so this job is the run's only safety
#     net and make soperator-apply refuses until it runs (scripts/ttl-armed.sh); apply (asks). NEVER
#     interrupt the apply (runbooks/incident.md): Ctrl-C here can leave the recipe half-applied.
#   2 acceptance (break-glass through the login pod, kube context nebius-nip-slurm that the recipe
#     writes): sinfo until a node is idle (15 min), sbatch --wrap hostname as root, sacct until
#     COMPLETED (10 min); results/lab-soperator.json
#   3 teardown, ALWAYS once the apply started: make soperator-destroy-plan / soperator-destroy (asks),
#     ttl_cancel soperator, kube context and login.sh removed, stage gate (leftovers --stage lab
#     --expect-empty: the recipe labels nothing, so only the stage-wide check sees its residue)
# Exit 0 PASS; 3 torn down and clean but the acceptance failed; 1 stopped before the apply, or the
# teardown / gate failed (the RESULT block names the TTL job still armed).
# Evidence (git-ignored): .cache/live/logs/run4-r4-<UTC>.log, results/lab-soperator.json,
# .cache/live/state/lab-r4-gate.txt -> docs/evidence/<date>-lab-soperator.md
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib-lab.sh"
step_init run4-r4
header "Run 4 / R4 - Soperator (lab profile, CPU only) in nip-lab, uk-south1" \
  "bootstrap lab/soperator, preflight, soperator-plan, TTL (3 h) before the apply, soperator-apply, sinfo/sbatch/sacct, soperator-destroy, stage gate" \
  "about \$1.89/h + ~280 GiB IO_M3 (rate unknown), uk-south1 rates of 2026-10-07/08: about \$1.40 for 45 min, \$5.67 + IO_M3 at the 3 h TTL" \
  "about 60-90 min (the passing upstream run took 43 min end to end)" "the RESULT block (plan, apply, sinfo, job state, destroy, gate)"
need make jq terraform nebius kubectl python3
check_repo
lab_target
key="${SSH_PUBKEY:-${HOME}/.ssh/id_ed25519.pub}"
[[ -f "${key}" && "${key}" == *.pub ]] || die "SSH public key ${key} not found (SSH_PUBKEY=~/.ssh/<key>.pub)"
SOP_DIR=terraform/stacks/soperator/upstream/soperator/installations/example
CTX=nebius-nip-slurm
summary=()

ttl_running soperator && die "a TTL job for lab/soperator is already running: another run uses this stage"
lab_stage_gate lab-r4-before.txt || die "the lab project is not empty (listed above): tear R7 down first (run4-r7.sh does)"
lab_vcpu_free 52

unset TF_VAR_labels TF_VAR_subnet_id TF_VAR_vpc_subnet_id
lab_boot soperator
TF_VAR_slurm_login_ssh_root_public_keys="$(jq -cn --arg k "$(cat "${key}")" '[$k]')"; export TF_VAR_slurm_login_ssh_root_public_keys
preflight_go STAGE=lab STACK=soperator; summary+=("${PREFLIGHT_LINE}")
run make soperator-plan STAGE=lab
EXP="$(utc_plus_min 180)"
ttl_arm soperator TTL="${EXP}"
FAIL_HINT="lab/soperator TTL job armed for ${EXP} (make soperator-destroy-plan/soperator-destroy STAGE=lab); it stays armed. Tear down by hand: make soperator-destroy-plan STAGE=lab && make soperator-destroy STAGE=lab CONFIRM=yes"
confirm "Apply Soperator in lab (6 CPU VMs, 3 filesystems, about \$1.89/h + IO_M3, TTL ${EXP}); do NOT interrupt the apply once it starts?"
apply_rc=0
run make soperator-apply STAGE=lab CONFIRM=yes || apply_rc=$?
if (( apply_rc == 0 )); then summary+=("soperator-apply lab: done"); else summary+=("soperator-apply lab: FAILED (rc ${apply_rc}); tearing down what was created"); fi

# --- acceptance (break-glass through the login pod; no SSH needed) ---
acc=fail sinfo_out="" job="" jstate="" sacct_out="" ver=""
if (( apply_rc == 0 )); then
  K=(kubectl --context "${CTX}" -n soperator)
  J() { "${K[@]}" exec login-0 -c sshd -- chroot /mnt/jail "$@"; }
  run "${K[@]}" get pods || true
  for _ in $(seq 1 30); do
    sinfo_out="$(J sinfo 2>/dev/null || true)"
    grep -qw idle <<<"${sinfo_out}" && break
    sleep 30
  done
  say "${sinfo_out}"
  ver="$(J sinfo --version 2>/dev/null || true)"
  if grep -qw idle <<<"${sinfo_out}"; then
    job="$(J sbatch --parsable -J nip-hello -N 1 --ntasks-per-node=1 -t 00:05:00 --wrap hostname 2>&1 | tail -1 || true)"
    if [[ "${job}" =~ ^[0-9]+ ]]; then
      job="${job%%;*}"
      for _ in $(seq 1 40); do
        jstate="$(J sacct -j "${job}" -n -X -o State 2>/dev/null | awk 'NF {print $1; exit}' || true)"
        [[ "${jstate}" =~ ^(COMPLETED|FAILED|CANCELLED|TIMEOUT|NODE_FAIL|OUT_OF_MEMORY)$ ]] && break
        sleep 15
      done
      sacct_out="$(J sacct -j "${job}" --format=JobID,State,Elapsed,NodeList 2>/dev/null || true)"
      say "${sacct_out}"
      [[ "${jstate}" == COMPLETED ]] && acc=pass
    else
      say "sbatch did not return a job id: ${job}"
    fi
  fi
  mkdir -p results
  jq -n --arg s "${acc}" --arg ts "$(date -u +%FT%TZ)" --arg sinfo "${sinfo_out}" --arg ver "${ver}" --arg job "${job}" --arg st "${jstate}" --arg sacct "${sacct_out}" \
    '{step:"lab-soperator", status:$s, timestamp:$ts, details:{stage:"lab", region:"uk-south1", profile:"terraform/stacks/soperator/profiles/lab.tfvars",
      slurm_version:$ver, sinfo:$sinfo, job_id:$job, job_state:$st, sacct:$sacct,
      method:"kubectl exec login-0 -c sshd -- chroot /mnt/jail (runbooks/soperator-jobs.md break-glass); the job ran as root, not a soperator-createuser user"}}' > results/lab-soperator.json
  summary+=("acceptance: ${acc} (sinfo idle: $(grep -qw idle <<<"${sinfo_out}" && echo yes || echo no); job ${job:-none} ${jstate:-no state})")
fi

# --- teardown (always once the apply started) ---
pf="$(mktemp)"
run make soperator-destroy-plan STAGE=lab 2>&1 | tee "${pf}"
line="$(grep -E '^Plan:|No changes' "${pf}" | tail -1 || true)"; rm -f "${pf}"
confirm "Destroy Soperator in lab (${line})?"
run make soperator-destroy STAGE=lab CONFIRM=yes
summary+=("soperator-destroy lab: done (${line})")
ttl_cancel soperator || die "ttl_cancel soperator did not return 0"
FAIL_HINT=""
kubectl config delete-context "${CTX}" >/dev/null 2>&1 && summary+=("kube context ${CTX} deleted") || summary+=("kube context ${CTX}: none")
rm -f "${SOP_DIR}/login.sh"
gate=0; lab_stage_gate lab-r4-gate.txt || gate=$?
summary+=("stage gate (leftovers --stage lab --expect-empty): $( (( gate == 0 )) && echo clean || echo "NOT CLEAN (rc ${gate}): the controller spool PVC disk is the usual one (runbooks/teardown.md)")")

result_begin
printf '  %s\n' "${summary[@]}"
say "TTL lab/soperator: $(ttl_status soperator)"
say "evidence: ${LOG}; results/lab-soperator.json; ${STATE_DIR}/lab-r4-gate.txt -> docs/evidence/$(date -u +%F)-lab-soperator.md"
if (( gate != 0 )); then say "VERDICT: FAIL (the lab project is not empty: see ${STATE_DIR}/lab-r4-gate.txt)"; exit 1; fi
if [[ "${acc}" != pass ]]; then say "VERDICT: PARTIAL (torn down and clean; acceptance ${acc})"; exit 3; fi
say "VERDICT: PASS"
