#!/usr/bin/env bash
# tests/validate/lib.sh ERR trap: a step that fails unexpectedly is recorded as fail; a step that
# recorded its own fail keeps its details; a step that recorded pass and then failed must not leave
# the pass on disk (the evidence would say pass while the script exited 1).
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
export RESULTS_DIR="${work}/results"
lib="${repo_root}/tests/validate/lib.sh"
step() { printf 'source %q\n%s\n' "${lib}" "$2" > "${work}/$1.sh"; set +e; STEP="$1" bash "${work}/$1.sh" >/dev/null 2>&1; rc=$?; set -e; }
stub kubectl 'exit 1'

test_name=validate-lib-unexpected
step s1 'false'
[[ "${rc}" -eq 1 && "$(jq -r .status "${RESULTS_DIR}/s1.json")" == fail && "$(jq -r .details.error "${RESULTS_DIR}/s1.json")" == "command failed" ]] \
  || fail "an unexpected failure must exit 1 and be recorded (rc ${rc})"
ok "an unexpected failure is recorded"

test_name=validate-lib-own-fail
step s2 'record s2 fail "{\"why\":\"bar\"}"'
[[ "${rc}" -eq 1 && "$(jq -r .details.why "${RESULTS_DIR}/s2.json")" == bar ]] || fail "a recorded fail must keep its details (rc ${rc})"
ok "a step's own fail keeps its details"

test_name=validate-lib-pass-then-fail
step s3 'record s3 pass "{}"; false'
[[ "${rc}" -eq 1 && "$(jq -r .status "${RESULTS_DIR}/s3.json")" == fail ]] \
  || fail "pass then a failing command must leave fail on disk (rc ${rc}): $(cat "${RESULTS_DIR}/s3.json")"
ok "a failure after a recorded pass overwrites it with fail"
