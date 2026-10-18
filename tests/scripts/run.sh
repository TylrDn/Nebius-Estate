#!/usr/bin/env bash
# Offline tests of the operational scripts against stub CLIs (part of `make selftest`): no token,
# no network, no cloud. Each tests/scripts/test-*.sh runs in its own process and temp dir.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
rc=0
for t in test-*.sh; do
  bash "${t}" || { echo "FAIL ${t}" >&2; rc=1; }
done
(( rc == 0 )) && echo "script tests passed"
exit "${rc}"
