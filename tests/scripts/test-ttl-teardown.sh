#!/usr/bin/env bash
# scripts/ttl-teardown.sh (make ttl-teardown): the safety-net teardown at a run's nip-ttl-expires.
# The 2026-10-11 inference run scheduled it with macOS `date -j -f`, which read the UTC label as
# local time and started the destroy late (docs/evidence/2026-10-11-sandbox-inference-populate.md).
# The time arithmetic must not depend on the caller's TZ; the absolute UTC time is printed; a real
# schedule needs CONFIRM=yes and runs destroy-plan then destroy for that root only.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=scripts/lib-time.sh
source "${repo_root}/scripts/lib-time.sh"
unset CONFIRM TF_VAR_labels
tt() { "${repo_root}/scripts/ttl-teardown.sh" "$@"; }

test_name=ttl-epoch-ignores-local-tz
for tz in UTC America/New_York Asia/Kolkata Pacific/Auckland; do
  got="$(TZ="${tz}" nip_epoch 2026-10-11T10:44:28Z)" || fail "nip_epoch failed under TZ=${tz}"
  [[ "${got}" == 1791715468 ]] || fail "TZ=${tz}: 2026-10-11T10:44:28Z must be epoch 1791715468, got ${got}"
  got="$(TZ="${tz}" nip_epoch 2026-11-10)" || fail "date-only failed under TZ=${tz}"
  [[ "${got}" == 1794268800 ]] || fail "TZ=${tz}: 2026-11-10 must be midnight UTC (1794268800), got ${got}"
  got="$(TZ="${tz}" nip_utc 1791715468)"
  [[ "${got}" == 2026-10-11T10:44:28Z ]] || fail "TZ=${tz}: nip_utc must print UTC, got ${got}"
done
nip_epoch 2026-10-11T10:44:28 >/dev/null 2>&1 && fail "a time without Z is ambiguous and must be refused"
nip_epoch 2026-10-11T10:44:28+02:00 >/dev/null 2>&1 && fail "only the label format YYYY-MM-DDTHH:MM:SSZ is accepted"
ok "UTC parsing and printing are independent of the local TZ"

test_name=ttl-teardown-dry-run-arithmetic
now="$(nip_epoch 2026-10-11T07:44:28Z)"
out="$(TZ=America/New_York NIP_NOW="${now}" tt --stage sandbox --stack inference --expires 2026-10-11T10:44:28Z --dry-run 2>&1)" \
  || fail "dry run failed: ${out}"
grep -q 'at 2026-10-11T10:44:28Z (UTC)' <<<"${out}" || fail "the absolute UTC time must be printed: ${out}"
grep -q 'in 10800 s (3 h 0 min)' <<<"${out}" || fail "3 h from now is 10800 s whatever the local TZ: ${out}"
grep -q 'make destroy-plan STAGE=sandbox STACK=inference' <<<"${out}" || fail "the dry run names the commands it would run: ${out}"
[[ -s "${LOG}" ]] && fail "a dry run must not call anything"
ok "dry run prints the UTC time and the delay"

test_name=ttl-teardown-refusals
expect_refused() { # <grep pattern> <args...>
  local pat="$1" out rc; shift
  set +e; out="$(NIP_NOW="${now}" tt "$@" 2>&1)"; rc=$?; set -e
  (( rc != 0 )) || fail "must refuse: $*: ${out}"
  grep -q -- "${pat}" <<<"${out}" || fail "refusal for '$*' must say '${pat}': ${out}"
}
expect_refused 'already passed' --stage sandbox --stack inference --expires 2026-10-11T07:00:00Z --dry-run
expect_refused 'YYYY-MM-DDTHH:MM:SSZ' --stage sandbox --stack inference --expires 2026-10-11T10:44:28 --dry-run
expect_refused 'prod is torn down through the release process' --stage prod --stack inference --expires 2026-10-11T10:44:28Z --dry-run
expect_refused 'No such live root' --stage sandbox --stack nope --expires 2026-10-11T10:44:28Z --dry-run
expect_refused 'no nip-ttl-expires' --stage sandbox --stack inference --dry-run
expect_refused 'CONFIRM=yes' --stage sandbox --stack inference --expires 2026-10-11T10:44:28Z
ok "past, malformed, prod, unknown root, missing expiry and unconfirmed schedules are refused"

test_name=ttl-teardown-expiry-sources
# The rendered run profile (make plan PROFILE=...) is read first, then TF_VAR_labels.
live="${work}/repo/terraform/live/sandbox/inference"; mkdir -p "${live}"
mkdir -p "${work}/repo/scripts"; cp "${repo_root}/scripts/ttl-teardown.sh" "${repo_root}/scripts/lib-time.sh" "${work}/repo/scripts/"
out="$(cd "${work}/repo" && NIP_NOW="${now}" TF_VAR_labels='{"nip-run":"x","nip-ttl-expires":"2026-10-11T08:44:28Z"}' \
  scripts/ttl-teardown.sh --stage sandbox --stack inference --dry-run 2>&1)" || fail "TF_VAR_labels expiry: ${out}"
grep -q 'at 2026-10-11T08:44:28Z (UTC)' <<<"${out}" || fail "the expiry comes from TF_VAR_labels: ${out}"
echo '{"labels":{"nip-run":"p","nip-ttl-expires":"2026-10-11T09:44:28Z"}}' > "${live}/.run-profile.tfvars.json"
out="$(cd "${work}/repo" && NIP_NOW="${now}" TF_VAR_labels='{"nip-ttl-expires":"2026-10-11T08:44:28Z"}' \
  scripts/ttl-teardown.sh --stage sandbox --stack inference --dry-run 2>&1)" || fail "profile expiry: ${out}"
grep -q 'at 2026-10-11T09:44:28Z (UTC)' <<<"${out}" || fail "the rendered run profile wins (it is what make plan used): ${out}"
ok "expiry read from the rendered run profile, else TF_VAR_labels"

test_name=ttl-teardown-schedules
# A real schedule, 2 s ahead, against a stub make: destroy-plan then destroy CONFIRM=yes, for this root only.
stub make 'exit 0'
stub caffeinate 'shift; exec "$@"'
soon="$(nip_utc $(( $(date -u +%s) + 2 )))"
out="$(cd "${work}/repo" && CONFIRM=yes NIP_TTL_POLL=1 scripts/ttl-teardown.sh --stage sandbox --stack inference --expires "${soon}" 2>&1)" \
  || fail "schedule failed: ${out}"
grep -q "at ${soon} (UTC)" <<<"${out}" || fail "the schedule prints the absolute UTC time: ${out}"
pidfile="${live}/.terraform/ttl-teardown.pid"
[[ -s "${pidfile}" ]] || fail "the pid file is written so the schedule can be cancelled"
for _ in $(seq 1 30); do grep -q '^make destroy STAGE' "${LOG}" && break; sleep 0.5; done
makes="$(grep -E '^make [a-z-]+ STAGE=[a-z]' "${LOG}" || true)"
[[ "${makes}" == "make destroy-plan STAGE=sandbox STACK=inference RUN_PROFILE=1
make destroy STAGE=sandbox STACK=inference CONFIRM=yes" ]] || fail "at the expiry: destroy-plan with the rendered run profile, then destroy CONFIRM=yes, for this root only (got: ${makes:-nothing})"
grep -q '^caffeinate -i ' "${LOG}" || fail "on macOS the job runs under caffeinate -i (no idle sleep)"
ok "the scheduled job runs destroy-plan (with the run profile it was planned with) then destroy at the expiry"

# schedule <expected destroy-plan line> <args...>: a real schedule 2 s ahead; the job's make calls must match.
schedule() {
  local want="$1" soon out makes; shift
  : > "${LOG}"; rm -f "${live}/.terraform/ttl-teardown.pid"
  soon="$(nip_utc $(( $(date -u +%s) + 2 )))"
  out="$(cd "${work}/repo" && CONFIRM=yes NIP_TTL_POLL=1 scripts/ttl-teardown.sh --stage sandbox --stack inference --expires "${soon}" "$@" 2>&1)" \
    || fail "schedule failed: ${out}"
  for _ in $(seq 1 30); do grep -q '^make destroy STAGE' "${LOG}" && break; sleep 0.5; done
  makes="$(grep -E '^make [a-z-]+ STAGE=[a-z]' "${LOG}" || true)"
  [[ "${makes}" == "${want}
make destroy STAGE=sandbox STACK=inference CONFIRM=yes" ]] || fail "$*: got ${makes:-nothing}"
}

test_name=ttl-teardown-profile-named
schedule "make destroy-plan STAGE=sandbox STACK=inference PROFILE=l40s-gpu-only" --profile l40s-gpu-only
out="$(cd "${work}/repo" && NIP_NOW="${now}" scripts/ttl-teardown.sh --stage sandbox --stack inference --expires 2026-10-11T10:44:28Z --profile l40s-gpu-only --dry-run 2>&1)"
grep -q 'make destroy-plan STAGE=sandbox STACK=inference PROFILE=l40s-gpu-only' <<<"${out}" || fail "the dry run names the profile: ${out}"
ok "PROFILE=<name> reaches destroy-plan"

test_name=ttl-teardown-no-profile
rm -f "${live}/.run-profile.tfvars.json"
schedule "make destroy-plan STAGE=sandbox STACK=inference"
ok "without a rendered run profile, destroy-plan runs on the root's own inputs"

test_name=ttl-teardown-soperator
# The Soperator recipe labels nothing: the expiry is --expires, and the job runs the recipe's own
# destroy targets (make soperator-destroy-plan / soperator-destroy) for the stage, never a stack root.
sop="${work}/repo/terraform/live/lab/soperator"; mkdir -p "${sop}"
out="$(cd "${work}/repo" && NIP_NOW="${now}" scripts/ttl-teardown.sh --stage lab --stack soperator --expires 2026-10-11T10:44:28Z --dry-run 2>&1)" \
  || fail "soperator dry run: ${out}"
grep -q 'make soperator-destroy-plan STAGE=lab && make soperator-destroy STAGE=lab CONFIRM=yes' <<<"${out}" || fail "the dry run names the soperator targets: ${out}"
set +e; out="$(cd "${work}/repo" && NIP_NOW="${now}" scripts/ttl-teardown.sh --stage lab --stack soperator --expires 2026-10-11T10:44:28Z --profile x --dry-run 2>&1)"; rc=$?; set -e
(( rc != 0 )) || fail "a run profile must be refused for soperator: ${out}"
grep -q 'does not apply to soperator' <<<"${out}" || fail "the refusal says why: ${out}"
: > "${LOG}"
soon="$(nip_utc $(( $(date -u +%s) + 2 )))"
out="$(cd "${work}/repo" && CONFIRM=yes NIP_TTL_POLL=1 scripts/ttl-teardown.sh --stage lab --stack soperator --expires "${soon}" 2>&1)" \
  || fail "soperator schedule failed: ${out}"
[[ -s "${sop}/.terraform/ttl-teardown.pid" ]] || fail "the pid file sits in the soperator stage directory"
for _ in $(seq 1 30); do grep -q '^make soperator-destroy STAGE' "${LOG}" && break; sleep 0.5; done
makes="$(grep -E '^make [a-z-]+ STAGE=[a-z]' "${LOG}" || true)"
[[ "${makes}" == "make soperator-destroy-plan STAGE=lab
make soperator-destroy STAGE=lab CONFIRM=yes" ]] || fail "at the expiry: soperator-destroy-plan then soperator-destroy CONFIRM=yes (got: ${makes:-nothing})"
ok "soperator: the expiry schedules the recipe's destroy-plan then destroy for that stage"
