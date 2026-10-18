#!/usr/bin/env bash
# Shared helpers for the bottom-up validation steps. Each step writes
# results/<step>.json so evidence is machine-readable (P6), including when a
# command fails unexpectedly (ERR trap below).
set -euo pipefail

RESULTS_DIR="${RESULTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/results}"
mkdir -p "${RESULTS_DIR}"
STEP="${STEP:-$(basename "${BASH_SOURCE[1]:-unknown}" .sh)}"

need() { for c in "$@"; do command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 2; }; done; }

# record <step> <status pass|fail> <json-object-of-details>
record() {
  local step="$1" status="$2" details="${3:-{\}}"
  jq -n --arg step "$step" --arg status "$status" --arg ts "$(date -u +%FT%TZ)" \
     --arg ctx "$(kubectl config current-context 2>/dev/null || echo none)" \
     --argjson details "$details" \
     '{step:$step,status:$status,timestamp:$ts,context:$ctx,details:$details}' \
     | tee "${RESULTS_DIR}/${step}.json"
  [[ "$status" == "pass" ]] && return 0
  NIP_RECORDED_FAIL="${step}"; return 1
}

# Any unexpected non-zero command (set -e) is recorded as a failed step with the
# line number, so run-all.sh and the evidence directory never silently miss it.
_on_err() {
  local line="$1" cmd="$2"
  trap - ERR
  # A step that has just recorded its own failure keeps that record (and its measurements).
  [[ -n "${NIP_RECORDED_FAIL:-}" ]] && exit 1
  record "${STEP}" fail "$(jq -n --arg l "$line" --arg c "$cmd" '{error:"command failed",line:($l|tonumber),command:$c}')" || true
  exit 1
}
trap '_on_err "$LINENO" "$BASH_COMMAND"' ERR
