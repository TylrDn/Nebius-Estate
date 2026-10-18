#!/usr/bin/env bash
# Scanner diagnostics must retain a failing exit code without printing report contents.
# shellcheck disable=SC2016
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

test_name=scan-redacted-diagnostics
stub gitleaks '
report=""
for arg in "$@"; do case "$arg" in --report-path=*) report="${arg#*=}" ;; esac; done
printf '\''[{"RuleID":"fixture-rule","File":"tests/example.txt","StartLine":3,"Commit":"fixture-commit","Fingerprint":"fixture-fingerprint","Secret":"DO-NOT-PRINT-REPORT-SECRET","Match":"DO-NOT-PRINT-SOURCE"}]'\'' > "$report"
exit 1'
set +e
out="$(bash "${repo_root}/scripts/scan-secrets.sh" 2>&1)"; rc=$?
set -e
[[ "$rc" == 1 ]] || fail "a finding must preserve scanner failure (got $rc)"
[[ "$out" == *fixture-fingerprint* && "$out" == *tests/example.txt* ]] || fail "diagnostics must identify the exact finding"
[[ "$out" != *DO-NOT-PRINT* ]] || fail "diagnostics printed report secrets or source context"
ok "failed scan reports metadata only"

test_name=scan-clean-status
stub gitleaks 'for arg in "$@"; do case "$arg" in --report-path=*) printf "[]" > "${arg#*=}" ;; esac; done; exit 0'
bash "${repo_root}/scripts/scan-secrets.sh" >/dev/null || fail "a clean valid report must pass"
ok "clean report passes"

test_name=scan-malformed-report
stub gitleaks 'for arg in "$@"; do case "$arg" in --report-path=*) printf "invalid" > "${arg#*=}" ;; esac; done; exit 0'
set +e
bash "${repo_root}/scripts/scan-secrets.sh" >/dev/null 2>&1; rc=$?
set -e
[[ "$rc" != 0 ]] || fail "invalid report must fail closed even if scanner exits zero"
ok "invalid report fails closed"
