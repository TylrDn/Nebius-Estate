#!/usr/bin/env bash
# Z1 (plan "Zero-cost owner tasks"): live preflight of sandbox/inference on the L40S profile. Reads
# only, plus the bootstrap's usual 1-day session state key. It must print GO (warnings allowed).
# Executed: bash scripts/live/A1-preflight-and-key.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init A1-preflight-and-key
header "Z1 - live preflight (sandbox/inference, PROFILE=l40s-gpu-only)" \
  "bootstrap sandbox/inference (mints the usual 1-day state key), then make preflight; read-only" \
  "\$0" "about 1-2 min" "the RESULT block (the Preflight line)"
need make jq terraform nebius python3
check_repo
load_env
boot inference
preflight_go STAGE=sandbox STACK=inference PROFILE=l40s-gpu-only

result_begin
say "${PREFLIGHT_LINE}"
say "VERDICT: PASS (GO; warnings, if any, are listed above)"
