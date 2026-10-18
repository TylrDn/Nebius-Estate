#!/usr/bin/env bash
# estate-check.sh [<nip-run label>] [--expect "<type>:<count> ..."]   (default label: the run-2
# session's nip-run from .cache/live/state/run2.env)
# Read-only snapshot of what the LIVE Nebius Estate portal (backend 127.0.0.1:7007) shows for a run:
# connector health, the run's resources (its nip-run label, or the run the portal attributes through a node group or
# cluster: node VMs and their disks carry no nip-run label), Fleet GPUs, Workloads, alerts and the live
# run-rate. GET requests only (plus the guest sign-in POST), guest identity; prints no secret. Used after every live step so each
# deliverable's evidence records what the portal saw. Exit 1 when an --expect count is not met.
set -uo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
RUN="${1:-$(sed -n 's/^NIP_RUN_STATE=//p' "${STATE_DIR}/run2.env" 2>/dev/null)}"
EXPECT=""; [[ "${2:-}" == --expect ]] && EXPECT="${3:-}"
B=http://127.0.0.1:7007/api/nebius-estate
T=$(curl -s -m 10 -X POST http://127.0.0.1:7007/api/auth/guest/refresh | jq -r '.backstageIdentity.token // empty')
[[ -n "$T" ]] || { echo "STOP: the live portal backend is not answering on :7007"; exit 2; }
get() { curl -s -m 30 -H "Authorization: Bearer $T" "$B/$1"; }
counts="$(mktemp)"; trap 'rm -f "${counts}" "${counts}.res"' EXIT

echo "=== Estate check $(date -u +%FT%TZ)  run=${RUN:-<none>}"
get integrations | jq -r '
  ([.. | objects | select(.id? == "nebius-inventory")][0] | "inventory: \(.state), last success \(.lastSuccess), running=\(.running)"),
  ([.. | objects | select(has("id") and has("state") and (.state != "ok") and (.state != "not-needed") and (.state != "optional"))] | unique_by(.id) | map("  connector \(.id): \(.state)") | .[])'
echo "--- resources of run ${RUN} (nip-run label, or attributed by the portal)"
# The portal's attribution.run covers the label and what inherits it (followup 22); the label is the fallback.
# shellcheck disable=SC2016  # a jq expression: $r is a jq variable
run_of='($r != "" and ((.attribution.run? // .labels["nip-run"]? // "") == $r))'
get resources > "${counts}.res"
jq -r --arg r "$RUN" '(.items // .resources // .) | if type=="array" then . else [] end
  | map(select('"${run_of}"'))
  | (if length == 0 then ["  (none seen yet)"] else map("  \(.type): \(.name)  status=\(.status)  region=\(.region)  ttl=\(.attribution.ttlExpires? // .labels["nip-ttl-expires"] // "-")\(if .attribution.inheritedFrom? then "  (via \(.attribution.inheritedFrom))" else "" end)") end) | .[]' "${counts}.res"
jq -r --arg r "$RUN" '(.items // .resources // .) | if type=="array" then . else [] end
  | map(select('"${run_of}"')) | group_by(.type) | map("\(.[0].type):\(length)") | "counts: " + join(" ")' "${counts}.res" > "${counts}"
cat "${counts}"
echo "--- fleet / workloads / alerts / run-rate"
get fleet | jq -r '"fleet: GPUs running now=\(.gpus.runningNow // 0), in range=\(.gpus.inRange // 0), freshness=\(.freshness.state // "-") (last sample \(.freshness.lastSampleAt // "-"))"'
get workloads | jq -r '"workloads: clusters=\(.clusters | length), workloads=\(.workloads | length), events=\(.events | length)"'
get alerts | jq -r '"alerts: firing=\(.counts.firing) pending=\(.counts.pending) resolved=\(.counts.resolved)",
  (.alerts | map(select(.state == "firing")) | map("  firing: \(.title // .rule // .name)") | .[0:8] | .[])'
# /runrate/live is a LivePriceResponse: .value is the estimate (hourly total or null when incomplete, unpriced lines).
get runrate/live | jq -r '
  (.value.unpriced // [] | length) as $u
  | (if $u > 0 then " (\($u) without a price)" else "" end) as $note
  | if .value then
      "run-rate (live list prices): \(if .value.hourly then "\(.value.hourly.amount) \(.value.hourly.currency)/h" else "no total" end)\($note)"
    elif .nothingRunning then "run-rate (live list prices): 0 \(.nothingRunning.currency)/h (nothing running)"
    else "run-rate: unavailable (\(.unavailableReason // "-"))" end'
rc=0
for e in $EXPECT; do
  t="${e%%:*}" n="${e##*:}"
  have=$(grep -o "${t}:[0-9]*" "${counts}" | head -1 | cut -d: -f2); have="${have:-0}"
  if (( have >= n )); then echo "expect ${t} >= ${n}: OK (${have})"; else echo "expect ${t} >= ${n}: MISSING (${have})"; rc=1; fi
done
exit "$rc"
