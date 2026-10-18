#!/usr/bin/env bash
# Run 2 step 1: re-price the session footprint (read-only billing calculator) and keep the gpu-node
# line as BENCH_USD_PER_HOUR for step 3's 05-load.sh (state/run2.env). An R1-only session (run-r1.sh)
# prices recipes/finance/examples/inference-l40s-r1-only.json instead (no R8 filesystem).
# Executed: bash run2-1-reprice.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-1-reprice
header "Run 2 step 1 - re-price (recipes/finance/price.py)" \
  "--dry-run of the requests, then the priced call with --contract: preemptible gpu-l40s-a 1gpu-8vcpu-32gb 3 h, 512 GiB boot disk, R8 256 GiB filesystem 4 h" \
  "\$0 (calculator only creates nothing)" "under 1 min" "the RESULT block (rows + BENCH_USD_PER_HOUR)"
need python3 jq nebius
check_repo
load_env
FP=recipes/finance/examples/inference-l40s-sandbox.json
# An R1-only session (run-r1.sh) prices R1 alone: GPU node, boot disk and its own 64 GiB filestore.
MODE="$(session_mode)"
if [[ "${MODE}" == r1-only ]]; then FP=recipes/finance/examples/inference-l40s-r1-only.json; fi
say "footprint: ${FP} (session mode ${MODE})"
[[ -f "${FP}" ]] || die "${FP} missing"

run python3 recipes/finance/price.py "${FP}" --project "${NEBIUS_PROJECT_ID}" --contract --dry-run
# price.py falls back to the default CLI profile for its token; give it the session profile's token.
NEBIUS_IAM_TOKEN="$(nebius --profile "${NEBIUS_PROFILE}" iam get-access-token)"; export NEBIUS_IAM_TOKEN
out="${STATE_DIR}/price-run2.json"
say ">>> python3 recipes/finance/price.py ${FP} --project ${NEBIUS_PROJECT_ID} --contract --json > ${out}"
# Not through run(): only the JSON answer may land in the file.
python3 recipes/finance/price.py "${FP}" --project "${NEBIUS_PROJECT_ID}" --contract --json > "${out}"
hourly="$(jq -r '[.rows[] | select(.item == "gpu-node" and .offer == "preemptible") | .hourly] | first // empty' "${out}")"
[[ -n "${hourly}" && "${hourly}" != null ]] || die "no preemptible gpu-node price in the answer (see ${out})"
state_set run2 BENCH_USD_PER_HOUR_STATE "${hourly}"

result_begin
jq -r '"as_of \(.as_of) \(.currency)", (.rows[] | "  \(.item) [\(.offer)] \(.what) hourly=\(.hourly // "-") per_run=\(.per_run // "-") \(.note // "")"),
  (.scenarios | to_entries[] | "  scenario \(.key): hourly=\(.value.hourly) per_run=\(.value.per_run) unpriced=\(.value.unpriced)"), (.notes[]? | "  note: \(.)")' "${out}"
say "BENCH_USD_PER_HOUR=${hourly}  (gpu-node line; saved for run2-3d-load.sh)"
if [[ "${MODE}" == r1-only ]]; then
  say "R1-only estimate (2026-10-12 rates): about \$0.81/h, \$1.61 (2 h) to \$2.42 (3 h TTL); spot prices move every 15 min"
  say "next: bash ${LIVE_DIR}/run2-2c-inference.sh"
else
  say "plan's estimate: R1 about \$0.78/h, session \$2.91 (2 h) to \$5.04 (TTLs) + R6; spot prices move every 15 min"
  say "next: bash ${LIVE_DIR}/run2-2a-data.sh"
fi
