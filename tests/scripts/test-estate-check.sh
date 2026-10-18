#!/usr/bin/env bash
# scripts/live/estate-check.sh: what the live portal shows for a run. Offline, against a stub curl that answers
# the portal's routes with fixtures: no portal, no token, no cloud.
# Followup 22: the check listed only resources labelled nip-run; a node VM and its boot disk carry no nip-run
# label and are attributed to the run by the portal through their node group (attribution.run, inheritedFrom).
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

R="${work}/repo"
mkdir -p "${R}/scripts/live" "${R}/.cache/live/state"
cp "${repo_root}/scripts/live/estate-check.sh" "${repo_root}/scripts/live/lib.sh" "${R}/scripts/live/"
cp "${repo_root}/scripts/lib-time.sh" "${R}/scripts/" 2>/dev/null || true

RUN=run-e00mock-1
cat > "${work}/resources.json" <<JSON
{ "items": [
  { "type": "mk8s-node-group", "name": "ng-gpu", "status": "running", "region": "eu-north1", "labels": { "nip-run": "${RUN}", "nip-ttl-expires": "2026-10-13T18:00:00Z" }, "attribution": { "run": "${RUN}", "ttlExpires": "2026-10-13T18:00:00Z" } },
  { "type": "compute-instance", "name": "mk8snodegroup-e00mockng-abc", "status": "running", "region": "eu-north1", "labels": { "mk8s-node-group-id": "mk8snodegroup-e00mockng" }, "attribution": { "run": "${RUN}", "ttlExpires": "2026-10-13T18:00:00Z", "inheritedFrom": "node group ng-gpu" } },
  { "type": "compute-disk", "name": "mk8snodegroup-e00mockng-abc-boot", "status": "running", "region": "eu-north1", "labels": {}, "attribution": { "run": "${RUN}", "inheritedFrom": "node group ng-gpu" } },
  { "type": "compute-instance", "name": "other-vm", "status": "running", "region": "eu-north1", "labels": { "nip-run": "another-run" }, "attribution": { "run": "another-run" } },
  { "type": "compute-disk", "name": "unattributed-disk", "status": "running", "region": "eu-north1", "labels": {}, "attribution": {} }
] }
JSON
echo '{"unavailableReason":"stub"}' > "${work}/runrate.json"
export FIX="${work}/resources.json" RRFIX="${work}/runrate.json" STUB_LOG="${LOG}"
# scripts/live/lib.sh sets its own LOG (the step log): this stub logs to STUB_LOG instead of lib.sh's stub().
{ printf '#!/usr/bin/env bash\n'; printf 'echo "curl $*" >> "${STUB_LOG}"\n'; printf '%s\n' '
url="${*: -1}"
case "${url}" in
  */api/auth/guest/refresh) echo "{\"backstageIdentity\":{\"token\":\"stub-token\"}}" ;;
  */integrations) echo "{\"connectors\":[{\"id\":\"nebius-inventory\",\"state\":\"ok\",\"lastSuccess\":\"2026-10-13T10:00:00Z\",\"running\":false}]}" ;;
  */resources) cat "${FIX}" ;;
  */fleet) echo "{\"gpus\":{\"runningNow\":1,\"inRange\":1},\"freshness\":{\"state\":\"live\"}}" ;;
  */workloads) echo "{\"clusters\":[],\"workloads\":[],\"events\":[]}" ;;
  */alerts) echo "{\"counts\":{\"firing\":0,\"pending\":0,\"resolved\":0},\"alerts\":[]}" ;;
  */runrate/live) cat "${RRFIX}" ;;
  *) echo "{}" ;;
esac'; } > "${bin}/curl"
chmod +x "${bin}/curl"

test_name=estate-check-attributed-by-portal
out="$(cd "${R}" && bash scripts/live/estate-check.sh "${RUN}" --expect "compute-instance:1 compute-disk:1 mk8s-node-group:1" 2>&1)" || fail "the node VM and its disk count for the run: ${out}"
grep -q '  compute-instance: mk8snodegroup-e00mockng-abc .*(via node group ng-gpu)' <<<"${out}" || fail "the node VM is listed with where its run comes from: ${out}"
grep -q '  compute-disk: mk8snodegroup-e00mockng-abc-boot .*(via node group ng-gpu)' <<<"${out}" || fail "the boot disk is listed: ${out}"
grep -q 'ttl=2026-10-13T18:00:00Z' <<<"${out}" || fail "the inherited TTL is shown: ${out}"
grep -q 'counts: compute-disk:1 compute-instance:1 mk8s-node-group:1' <<<"${out}" || fail "counts include attributed resources: ${out}"
grep -q 'other-vm\|unattributed-disk' <<<"${out}" && fail "another run's and unattributed resources are not listed: ${out}"
ok "resources the portal attributes to the run (via their node group) are listed and counted"

test_name=estate-check-missing
set +e; out="$(cd "${R}" && bash scripts/live/estate-check.sh "${RUN}" --expect "compute-instance:2" 2>&1)"; rc=$?; set -e
(( rc == 1 )) || fail "an unmet --expect exits 1 (rc=${rc}): ${out}"
grep -q 'expect compute-instance >= 2: MISSING (1)' <<<"${out}" || fail "the shortfall is named: ${out}"
ok "an unmet --expect count still fails"

# /runrate/live answers a LivePriceResponse: .value is an estimate object (source, lines, hourly, currency, unpriced),
# not a figure; the evidence line printed the object as JSON.
test_name=estate-check-runrate-figure
cat > "${work}/runrate.json" <<'JSON'
{ "value": { "source": "Nebius billing calculator (list price)", "offer": "list", "asOf": "2026-10-13T10:00:00Z", "currency": "XTS", "projectId": "project-e00mocka",
  "lines": [{ "count": 2 }], "hourly": { "amount": "3.4500", "currency": "XTS" }, "contract": { "attempted": false, "available": null }, "unpriced": ["Disk pvc-e00mock: the API answer has no size to price"] } }
JSON
out="$(cd "${R}" && bash scripts/live/estate-check.sh "${RUN}" 2>&1)" || fail "estate-check runs: ${out}"
grep -q 'run-rate (live list prices): 3.4500 XTS/h (1 without a price)' <<<"${out}" || fail "the run-rate line prints the hourly total and its currency: ${out}"
grep -q '"source"' <<<"${out}" && fail "the run-rate line does not dump the estimate as JSON: ${out}"
echo '{ "value": { "currency": "XTS", "lines": [], "hourly": null, "unpriced": ["VM a: no rate"] } }' > "${work}/runrate.json"
out="$(cd "${R}" && bash scripts/live/estate-check.sh "${RUN}" 2>&1)" || fail "estate-check runs: ${out}"
grep -q 'run-rate (live list prices): no total (1 without a price)' <<<"${out}" || fail "an estimate with no total says so: ${out}"
echo '{ "value": null, "nothingRunning": { "currency": "XTS" } }' > "${work}/runrate.json"
out="$(cd "${R}" && bash scripts/live/estate-check.sh "${RUN}" 2>&1)" || fail "estate-check runs: ${out}"
grep -q 'run-rate (live list prices): 0 XTS/h (nothing running)' <<<"${out}" || fail "nothing running is 0, not unavailable: ${out}"
ok "the run-rate evidence line prints the hourly total, not the estimate object"
