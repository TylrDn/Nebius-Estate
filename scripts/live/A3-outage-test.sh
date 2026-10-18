#!/usr/bin/env bash
# Phase A3: the portal's wake/retry fixes (F1.30, F1.31, F1.45) under a REAL network outage, against
# the live Nebius Estate portal backend on 127.0.0.1:7007. Turns Wi-Fi off and back on (macOS
# networksetup; WIFI_IF, default en0); any tool on this machine loses its connection meanwhile, which
# is expected. Takes about 2 minutes. Nothing is written to Nebius.
#   A: Wi-Fi off, then a sync starts into the outage; Wi-Fi back after about 10 s (inside the ~30 s
#      retry budget) -> the retries absorb it and the sync ends ok.
# Run it in a plain terminal window on the Mac itself (not over SSH: Wi-Fi off cuts the session):
#   bash scripts/live/A3-outage-test.sh     Paste back: everything from "=== RESULT" down.
set -uo pipefail
B=http://127.0.0.1:7007/api/nebius-estate
IF="${WIFI_IF:-en0}"
[[ -z "${SSH_CONNECTION:-}" ]] || { echo "STOP: run this on the Mac itself, not over SSH (Wi-Fi off would cut this session)"; exit 1; }
command -v networksetup >/dev/null || { echo "STOP: networksetup not found (macOS only)"; exit 1; }
tok() { curl -s -X POST http://127.0.0.1:7007/api/auth/guest/refresh | jq -r '.backstageIdentity.token // empty'; }
T=$(tok); [[ -n "$T" ]] || { echo "STOP: live backend not answering on :7007"; exit 1; }
H=(-H "Authorization: Bearer $T")
wifi() { networksetup -setairportpower "$IF" "$1"; }
trap 'wifi on' EXIT
state() { curl -s "${H[@]}" "$B/integrations" | jq -r '[.. | objects | select(.id? == "nebius-inventory")][0]
  | "state=\(.state)  lastSuccess=\(.lastSuccess)  lastRun=\(.health.recentRuns[0] | "ok=\(.ok) items=\(.items // "-") \(.durationMs)ms")  issue=\(.error // .lastError // .note // "-")"' | cut -c1-400; }
running() { curl -s "${H[@]}" "$B/integrations" | jq -r '[.. | objects | select(.id? == "nebius-inventory")][0].running'; }
# The sync request waits for the whole sync; fire it and poll `running` instead (the sync carries on server side).
sync() { curl -s -m 3 -X POST "${H[@]}" -H 'Content-Type: application/json' -d '{}' "$B/integrations/nebius-inventory/sync" >/dev/null 2>&1; echo "(sync requested)"; }
waitdone() { for _ in $(seq 1 60); do [[ "$(running)" == true ]] || return 0; sleep 3; done; echo "(sync still running after 3 min)"; }
online() { for _ in $(seq 1 40); do curl -s -m 3 -o /dev/null https://api.nebius.cloud && return 0; sleep 2; done; echo "(network not back after 80 s)"; }

echo "before:  $(state)"
waitdone; sleep 5
echo "--- A: Wi-Fi off, a sync starts into the outage, Wi-Fi back after 10 s (inside the ~30 s retry budget)"
wifi off; sleep 2; sync; sleep 8; wifi on; online; sleep 3; waitdone
T=$(tok); H=(-H "Authorization: Bearer $T"); A=$(state)
echo "=== RESULT"
echo "A (10 s outage): $A"
