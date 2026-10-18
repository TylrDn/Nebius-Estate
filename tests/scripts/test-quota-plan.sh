#!/usr/bin/env bash
# scripts/quota-plan.py against a stub `nebius`: the 2026-10-11 eu-west2 incident in miniature.
# Reports project caps above the tenant limit (no effect), below it (caps the project), at 0 (blocks
# the project), tenant limits of 0 the stacks need; a placeholder (no id) is never a cap. Read-only by
# default; --plan-align prints updates; --apply needs CONFIRM=yes, writes the rollback first, never deletes.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
stub nebius '
[[ -n "${FAIL_ON:-}" && "$*" == *"${FAIL_ON}"* ]] && exit 1
q() { # <name> <region> <limit|-> [id] [created_at]
  local lim="" id="" created="${5:-2026-10-11T14:32:44Z}"
  [[ "$3" != "-" ]] && lim=",\"limit\":\"$3\""
  [[ -n "${4:-}" ]] && id="\"id\":\"$4\","
  echo "{\"metadata\":{${id}\"name\":\"$1\",\"created_at\":\"${created}\",\"resource_version\":\"3\"},\"spec\":{\"region\":\"$2\"${lim}},\"status\":{\"description\":\"desc of $1\",\"unit\":\"count\"$([[ -n "${4:-}" ]] && echo ",\"state\":\"STATE_ACTIVE\"")}}"
}
case "$*" in
  *"quota-allowance list"*"--parent-id tenant-e00mock"*)
    echo "{\"items\":[$(q compute.instance.count eu-west2 12 quotaallowance-t1),$(q vpc.allocation.count eu-west2 1000 quotaallowance-t2),$(q mysterybox.secret.count eu-west2 3000 quotaallowance-t3),$(q dns.zone.count eu-west2 100 quotaallowance-t4),$(q mk8s.cluster.count eu-west2 2 quotaallowance-t5),$(q compute.instance.non-gpu.vcpu eu-north1 - quotaallowance-t6),$(q compute.instance.gpu.h100 eu-north1 32 quotaallowance-t7),$(q mk8s.cluster.count eu-north1 2 quotaallowance-t8),$(q compute.instance.preemptible.count eu-north1 8 quotaallowance-t9)]}" ;;
  *"quota-allowance list"*"--parent-id project-e00mocka"*)
    echo "{\"items\":[$(q compute.instance.count eu-west2 22 quotaallowance-p1),$(q vpc.allocation.count eu-west2 13 quotaallowance-p2),$(q mysterybox.secret.count eu-west2 20 quotaallowance-p3),$(q dns.zone.count eu-west2 - quotaallowance-p4),$(q mk8s.cluster.count eu-west2 2 quotaallowance-p5),$(q compute.instance.gpu.h100 eu-north1 - "" 1970-01-01T00:00:00Z)]}" ;;
  *"quota-allowance list"*"--parent-id project-e00mockb"*)
    echo "{\"items\":[$(q compute.instance.count eu-west2 - "" 1970-01-01T00:00:00Z)]}" ;;
  *"iam project get"*"--id project-e00mocka"*) echo "{\"metadata\":{\"id\":\"project-e00mocka\",\"name\":\"sandbox-a\",\"parent_id\":\"tenant-e00mock\"}}" ;;
  *"iam project get"*) exit 1 ;;
  *"quota-allowance update"*)
    [[ -s "${QP_ROLLBACK}" ]] || { echo "update before the rollback file was written" >&2; exit 1; } ;;
  *) exit 1 ;;
esac'
export NIP_DOTENV=/dev/null NEBIUS_TENANT_ID=tenant-e00mock NEBIUS_PROJECT_IDS=project-e00mocka,project-e00mockb NEBIUS_PROFILE=nip-portal-viewer
export QP_ROLLBACK="${work}/rollback.json"
unset CONFIRM NEBIUS_REGION
qp() { python3 "${repo_root}/scripts/quota-plan.py" "$@"; }

test_name=quota-plan-report
out="$(qp 2>&1)" || fail "read-only report failed: ${out}"
grep -q 'compute.instance.count.*22.*12.*no effect' <<<"${out}" || fail "a cap above the tenant limit must read 'no effect': ${out}"
grep -q 'vpc.allocation.count.*13.*1000.*caps this project; intended?' <<<"${out}" || fail "a cap below the tenant limit must ask 'caps this project; intended?': ${out}"
grep -q 'mysterybox.secret.count.*20.*3000.*caps this project; intended?' <<<"${out}" || fail "mysterybox cap below tenant missing: ${out}"
grep -q 'dns.zone.count.*0.*100.*blocks' <<<"${out}" || fail "an id'd project cap with no limit is 0 and blocks the project: ${out}"
grep -q 'mk8s.cluster.count.*eu-west2' <<<"${out}" && fail "a cap equal to the tenant limit is fine and not listed: ${out}"
grep -q 'compute.instance.gpu.h100' <<<"$(grep -v -i 'request from Nebius\|justification' <<<"${out}")" && fail "a placeholder (no id) inherits the tenant quota and is never a cap: ${out}"
grep -q 'sandbox-a' <<<"${out}" || fail "the project is named when iam project get answers: ${out}"
grep -q 'compute.instance.non-gpu.vcpu.*eu-north1.*request from Nebius (console → Administration → Limits → Change quota)' <<<"${out}" \
  || fail "a tenant limit of 0 the stacks need must be reported with where to request it: ${out}"
grep -q 'Justification: .*compute.instance.non-gpu.vcpu' <<<"${out}" || fail "a pre-filled justification line is printed: ${out}"
grep -q 'compute.instance.preemptible.count.*request from' <<<"${out}" && fail "a needed quota with a non-zero tenant limit is not a request: ${out}"
grep -q 'quota-allowance update' "${LOG}" && fail "the default run must never update"
grep -q -- '--profile nip-portal-viewer' "${LOG}" || fail "NEBIUS_PROFILE must be honoured"
grep -v -- '--profile nip-portal-viewer' "${LOG}" | grep -q . && fail "every call must use the profile"
ok "no effect, caps, zero caps and tenant zeros reported; placeholders ignored; read-only"

test_name=quota-plan-project-flag
: > "${LOG}"
out="$(qp --project project-e00mockb 2>&1)" || fail "--project failed: ${out}"
grep -q 'parent-id project-e00mocka' "${LOG}" && fail "--project replaces NEBIUS_PROJECT_IDS"
grep -q 'vpc.allocation.count' <<<"${out}" && fail "project b has no caps: ${out}"
ok "--project limits the run to the named project"

test_name=quota-plan-tenant-from-project
: > "${LOG}"
out="$(NEBIUS_TENANT_ID='' qp --project project-e00mocka 2>&1)" || fail "tenant from the project's parent failed: ${out}"
grep -q 'parent-id tenant-e00mock' "${LOG}" || fail "the tenant is read from the project's parent_id when NEBIUS_TENANT_ID is unset"
ok "tenant id derived from the project"

test_name=quota-plan-align
: > "${LOG}"
out="$(qp --plan-align 2>&1)" || fail "--plan-align failed: ${out}"
grep -q 'update --id quotaallowance-p2 --limit 1000' <<<"${out}" || fail "plan sets vpc.allocation.count to the tenant limit: ${out}"
grep -q 'update --id quotaallowance-p4 --limit 100' <<<"${out}" || fail "plan sets the zero cap to the tenant limit: ${out}"
grep -q 'quotaallowance-p1' <<<"${out}" && fail "a no-effect cap is not in the plan unless asked: ${out}"
grep -q 'quota-allowance update' "${LOG}" && fail "--plan-align must never update"
out="$(qp --plan-align --include-no-effect --quota 'compute.*' 2>&1)" || fail "--include-no-effect failed: ${out}"
grep -q 'update --id quotaallowance-p1 --limit 12' <<<"${out}" || fail "--include-no-effect adds no-effect caps: ${out}"
grep -q 'quotaallowance-p2' <<<"${out}" && fail "--quota narrows the plan: ${out}"
ok "--plan-align prints the updates to the tenant limit, read-only"

test_name=quota-plan-apply-refused
: > "${LOG}"
set +e; out="$(qp --apply 2>&1)"; rc=$?; set -e
[[ "${rc}" -eq 2 ]] || fail "--apply without CONFIRM=yes must refuse with exit 2 (got ${rc}): ${out}"
grep -q 'CONFIRM=yes' <<<"${out}" || fail "the refusal names CONFIRM=yes: ${out}"
grep -q 'quota-allowance update' "${LOG}" && fail "nothing is updated without CONFIRM=yes"
ok "--apply refuses without CONFIRM=yes"

test_name=quota-plan-apply
: > "${LOG}"
out="$(CONFIRM=yes qp --apply --rollback-file "${QP_ROLLBACK}" 2>&1)" || fail "--apply failed: ${out}"
[[ -s "${QP_ROLLBACK}" ]] || fail "the rollback file is written"
python3 - "${QP_ROLLBACK}" <<'PY' || fail "rollback content"
import json, sys
d = json.load(open(sys.argv[1]))
rows = {r["id"]: r for r in d["updates"]}
assert rows["quotaallowance-p2"]["previous_limit"] == 13 and rows["quotaallowance-p2"]["new_limit"] == 1000, rows
assert rows["quotaallowance-p4"]["previous_limit"] == 0 and rows["quotaallowance-p4"]["new_limit"] == 100, rows
assert "quotaallowance-p1" not in rows
PY
grep -q 'quota-allowance update --id quotaallowance-p2 --limit 1000 --patch' "${LOG}" || fail "update by --id with --patch"
grep -q 'quota-allowance update --id quotaallowance-p3 --limit 3000 --patch' "${LOG}" || fail "mysterybox update"
grep -q 'quota-allowance delete\|quota-allowance create' "${LOG}" && fail "never delete or create"
grep -q 'Rollback' <<<"${out}" || fail "the run says where the rollback is: ${out}"
ok "--apply writes the rollback first, then updates by id (never deletes)"

test_name=quota-plan-fail-loud
for f in "parent-id tenant-e00mock" "parent-id project-e00mockb"; do
  set +e; FAIL_ON="${f}" qp >/dev/null 2>&1; rc=$?; set -e
  [[ "${rc}" -eq 2 ]] || fail "a failed list (${f}) must stop with exit 2 (got ${rc})"
done
ok "a failed listing stops the check"

test_name=quota-plan-dotenv
: > "${LOG}"
printf 'NEBIUS_PROJECT_IDS=project-e00mockb   # comma-separated projects\nNEBIUS_API_KEY=never-read\n' > "${work}/dotenv"
out="$(NIP_DOTENV="${work}/dotenv" NEBIUS_PROJECT_IDS='' qp 2>&1)" || fail "ids from .env with a trailing comment: ${out}"
grep -q 'parent-id project-e00mockb --all' "${LOG}" || fail "NEBIUS_PROJECT_IDS is read from .env without its comment"
ok "unset ids are read from .env (comments stripped)"

test_name=quota-plan-json
: > "${LOG}"
out="$(qp --json --region eu-north1 2>/dev/null)" || fail "--json report failed: ${out}"
python3 - "${out}" <<'PY' || fail "--json shape: ${out}"
import json, sys
d = json.loads(sys.argv[1])
assert d["tenant_id"] == "tenant-e00mock" and d["projects"] == ["project-e00mocka", "project-e00mockb"], d
t = {(q["name"], q["region"]): q for q in d["tenant"]}
assert t[("compute.instance.non-gpu.vcpu", "eu-north1")]["limit"] == 0, t   # an omitted tenant limit is 0
assert t[("compute.instance.preemptible.count", "eu-north1")]["limit"] == 8, t
caps = {(c["name"], c["region"]): c for c in d["caps"]["project-e00mocka"]}
assert caps[("dns.zone.count", "eu-west2")]["real"] and caps[("dns.zone.count", "eu-west2")]["limit"] == 0, caps
assert not caps[("compute.instance.gpu.h100", "eu-north1")]["real"], caps          # a placeholder is never a cap
assert all("usage_reported" in q for q in d["tenant"]), d["tenant"]
f = {(x["kind"], x["name"]): x for x in d["findings"]}
assert f[("below", "vpc.allocation.count")]["message"] == "vpc.allocation.count: project cap 13, tenant 1000 -> caps this project; intended?", f
assert ("no-effect", "compute.instance.count") in f and ("zero", "dns.zone.count") in f, f
z = [x for x in d["zeros"] if x["listed"]]
assert [x["quota"] for x in z] == ["compute.instance.non-gpu.vcpu"], z
assert z[0]["message"].startswith("compute.instance.non-gpu.vcpu eu-north1: tenant limit 0 -> request from Nebius"), z
PY
set +e; qp --json --strict --region eu-north1 >/dev/null 2>&1; rc=$?; set -e
[[ "${rc}" -eq 3 ]] || fail "--json keeps --strict's exit 3 (got ${rc})"
set +e; qp --json --plan-align >/dev/null 2>&1; rc=$?; set -e
[[ "${rc}" -eq 2 ]] || fail "--json with --plan-align is refused (got ${rc})"
grep -q 'quota-allowance update' "${LOG}" && fail "--json must never update"
ok "--json prints the parsed allowances, findings and tenant zeros (scripts/preflight.py reads it)"
