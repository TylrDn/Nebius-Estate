# shellcheck shell=bash
# Shared by tests/scripts/test-*.sh (`make selftest`): each test gets a temp dir whose bin/ comes
# first on PATH, so `nebius`, `curl`, `git`, `kubectl`, `docker`, `terraform` and `openssl` are
# stubs that log their argv to $LOG and never reach a network, a cluster or the cloud.
set -euo pipefail
# shellcheck disable=SC2034  # repo_root and work are for the test files that source this one
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
bin="${work}/bin"; mkdir -p "${bin}"
export LOG="${work}/calls.log"; : > "${LOG}"
export PATH="${bin}:${PATH}"
export HOME="${work}/home"; mkdir -p "${HOME}"
fail() { echo "FAIL ${test_name:-?}: $*" >&2; [[ -s "${LOG}" ]] && sed 's/^/  call: /' "${LOG}" >&2; exit 1; }
ok() { echo "ok   ${test_name:-?}: $*"; }
# stub <name> <bash body>: the body sees "$@" and $LOG; every call is logged as "<name> <argv>".
# Bodies are single-quoted on purpose (they expand when the stub runs): the test files disable SC2016.
stub() {
  # shellcheck disable=SC2016  # $* and $LOG are for the stub, not this shell
  { printf '#!/usr/bin/env bash\n'; printf 'echo "%s $*" >> "$LOG"\n' "$1"; printf '%s\n' "$2"; } > "${bin}/$1"
  chmod +x "${bin}/$1"
}
calls() { cat "${LOG}"; }
