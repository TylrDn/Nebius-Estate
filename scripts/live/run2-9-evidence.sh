#!/usr/bin/env bash
# Run 2 step 9: gather what the evidence files need (no file under docs/ is written here;
# docs/evidence/* is written from this paste-back). Read-only: result files, TTL jobs, elapsed time per
# root and the plan's rates (estimates, not a bill). Run again after step 11 to add the residue.
# Executed: bash run2-9-evidence.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-9-evidence
header "Run 2 step 9 - evidence bundle (read-only)" \
  "summaries of every results/*.json of this session, TTL job state, spend estimate per root" \
  "\$0" "under 1 min" "the whole RESULT block"
need jq
check_repo
state_load run2

result_begin
say "session mode: ${SESSION_MODE:-run2}; R14 token Secret: ${R14_TOKEN:-not run}; R14 failing cause classes: ${R14_CAUSES:-none}"
say "session: nip-run ${NIP_RUN_STATE:-?}; labels ${LABELS:-?}; R1_EXP ${R1_EXP:-?}; LATE ${LATE:-?}"
say "flags: reuse_z5=${REUSE_Z5:-0} vllm_lowered=${VLLM_LOWERED:-0} f31_blocked=${F31_BLOCKED:-0} storage_rate_only_fail=${STORAGE_RATE_ONLY_FAIL:-0} r12_secret='${R12_SECRET_METHOD:-?}'"
say "gpu layers: 00=${GPU_L00:-not run} 01=${GPU_L01:-not run} 02=${GPU_L02:-not run}; vllm_deployed=${VLLM_DEPLOYED:-0}"
now="$(nip_now)"
est() { # <label> <applied epoch> <destroyed epoch or empty> <usd/h>
  [[ -n "$2" ]] || { say "  $1: not applied"; return 0; }
  local end="${3:-${now}}"
  awk -v a="$2" -v e="${end}" -v r="$4" -v n="$1" -v open="${3:-running}" 'BEGIN{h=(e-a)/3600; printf "  %s: %.2f h x $%s/h = $%.2f (%s)\n", n, h, r, h*r, (open=="running"?"still running":"destroyed")}'
}
say "spend estimate (plan rates; spot prices move; not a bill):"
est "R1 inference" "${APPLY_AT_R1:-}" "${DESTROYED_AT_R1:-}" 0.78
est "R12 ml-services" "${APPLY_AT_ML:-}" "${DESTROYED_AT_ML:-}" 0.648
est "R8 data" "${APPLY_AT_DATA:-}" "${DESTROYED_AT_DATA:-}" 0.0281
say "R6 endpoint: about \$1.57/h while it exists (derived: on-demand VM + 200 GiB disk, recipes/serverless/README.md; see serverless-endpoint-create/delete timestamps below)"
say "TTL jobs:"
for s in inference ml-services data gpu-vm; do
  say "  ${s}: $(ttl_status "${s}")"
done
say "results:"
for f in 00-nodes 01-gpu 02-interconnect 03-storage 04-workload 05-load checkpoint-restore ml-services o11y-acceptance \
         serverless-endpoint-create serverless-endpoint-measure serverless-endpoint-delete; do
  [[ -f "results/${f}.json" ]] && jq -r --arg f "${f}" '"  \($f): \(.status) at \(.timestamp)"' "results/${f}.json"
done
[[ -f results/summary.json ]] && say "  summary.json steps: $(jq -c .steps results/summary.json); versions: $(jq -c .versions results/summary.json)"
[[ -f results/05-load.json ]] && { say "  05-load points:"; bench_summary results/05-load.json | sed 's/^/    /'; }
[[ -f results/05-load.f6.1.json ]] && { say "  F6.1 05-load points:"; bench_summary results/05-load.f6.1.json | sed 's/^/    /'; }
[[ -f results/03-storage.json ]] && jq -r '"  fio: write \(.details.write_MiBps) read \(.details.read_MiBps) MiB/s (\(.details.method))"' results/03-storage.json
say "logs of this session: ${LOG_DIR}"
find "${LOG_DIR}" -name '*.log' -type f | sort | tail -n 30 | sed 's/^/  /'
