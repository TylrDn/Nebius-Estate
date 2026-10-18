#!/usr/bin/env bash
# Offline check of the R11 Token Factory scripts (part of `make ci`): no key, no network, no spend.
#   - smoke.py compiles and imports, and --dry-run prints the request with the key redacted
#   - without --yes it refuses (exit 2) before reading a key or opening a connection
#   - max_tokens above the cap of 16 is refused
#   - list-models.sh parses (shellcheck runs it through `make shellcheck`)
# Usage: recipes/token-factory/test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
smoke="${here}/smoke.py"
# A sentinel instead of a real key: it must never appear in any output. The base URL is a reserved
# .invalid name, so even a bug that sent the request could not reach a real service.
sentinel="nip-test-key-must-not-print-0000"
export NIP_TF_BASE_URL="https://api.tokenfactory.invalid/v1/"
fail() { echo "FAIL: $*" >&2; exit 1; }
out="$(mktemp)"; trap 'rm -f "${out}"' EXIT

export PYTHONDONTWRITEBYTECODE=1  # leave no __pycache__ in the tree
# Compile and import it as a module (main() is not run on import).
python3 -c 'import importlib.util, sys
spec = importlib.util.spec_from_file_location("smoke", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert m.MAX_TOKENS_CAP == 16, m.MAX_TOKENS_CAP' "${smoke}" || fail "smoke.py does not import"
bash -n "${here}/list-models.sh" || fail "list-models.sh does not parse"

# 1. Dry run with no key at all.
env -u NEBIUS_API_KEY python3 "${smoke}" --dry-run >"${out}" 2>/dev/null || fail "--dry-run without NEBIUS_API_KEY exited non-zero"
python3 - "${out}" <<'PY' || fail "--dry-run output is not the expected request"
import json, sys
text = open(sys.argv[1]).read()
req = json.loads(text)
assert req["dry_run"] is True and req["method"] == "POST", req
assert req["url"] == "https://api.tokenfactory.invalid/v1/chat/completions", req["url"]
assert req["headers"]["Authorization"] == "Bearer <NEBIUS_API_KEY redacted>", req["headers"]
assert 1 <= req["body"]["max_tokens"] <= 16, req["body"]
assert req["body"]["messages"][0]["role"] == "user"
PY

# 2. Dry run with a key set: the key must not be printed.
NEBIUS_API_KEY="${sentinel}" python3 "${smoke}" --dry-run >"${out}" 2>&1 || fail "--dry-run with a key exited non-zero"
grep -qF "${sentinel}" "${out}" && fail "--dry-run printed the key"

# 3. No --yes: refuse with exit 2, without printing the key.
set +e
NEBIUS_API_KEY="${sentinel}" python3 "${smoke}" >"${out}" 2>&1; rc=$?
set -e
[[ "${rc}" == 2 ]] || fail "without --yes expected exit 2, got ${rc}"
grep -q "refusing" "${out}" || fail "without --yes the refusal message is missing"
grep -qF "${sentinel}" "${out}" && fail "the refusal printed the key"

# 4. The token cap holds, and --yes cannot be combined with --dry-run.
for args in "--dry-run --max-tokens 17" "--dry-run --max-tokens 0" "--dry-run --yes"; do
  set +e
  # shellcheck disable=SC2086  # word splitting of the argument list is intended
  python3 "${smoke}" ${args} >"${out}" 2>&1; rc=$?
  set -e
  [[ "${rc}" == 2 ]] || fail "'${args}' should be refused (exit 2), got ${rc}"
done

echo "token-factory: smoke.py dry run, refusal without --yes and token cap ok (no network, no key)"
