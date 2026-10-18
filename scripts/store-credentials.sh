#!/usr/bin/env bash
# Store pasted credentials in .env without echoing them, then prove each one with a read-only call.
# The value is read hidden, written atomically (mode 600), never printed, and never put on a command
# line (curl reads the header from a private temp file).
# Usage: scripts/store-credentials.sh [NAME ...]    default: every slot below that is still unset
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f .env ]] || { umask 077; cp .env.example .env; }
chmod 600 .env

# name | required or optional | where to create it | read-only check URL (Bearer auth)
slots() {
  cat <<'EOF'
NEBIUS_API_KEY|required|https://tokenfactory.nebius.com/project/api-keys (Create API key; shown once)|https://api.tokenfactory.nebius.com/v1/models
HF_TOKEN|optional|https://huggingface.co/settings/tokens (read token; the portal's AI services page checks it, and gated model downloads need it)|https://huggingface.co/api/whoami-v2
EOF
}

current() { # value of NAME in .env, without printing it anywhere else
  sed -nE "s/^$1=['\"]?([^'\" #]*).*/\\1/p" .env | tail -1
}

store() { # NAME VALUE: replace or append the NAME= line atomically
  local tmp; tmp="$(mktemp .env.XXXXXX)"
  NAME="$1" VALUE="$2" python3 - .env "${tmp}" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
name, value = os.environ["NAME"], os.environ["VALUE"]
lines, done = open(src).read().splitlines(), False
for i, line in enumerate(lines):
    if line.startswith(name + "="):
        lines[i] = f"{name}='{value}'"; done = True
if not done:
    lines.append(f"{name}='{value}'")
open(dst, "w").write("\n".join(lines) + "\n")
PY
  chmod 600 "${tmp}"; mv "${tmp}" .env
}

check() { # NAME URL: HTTP status of a read-only GET with the stored key
  local hdr status; hdr="$(mktemp)"; chmod 600 "${hdr}"
  printf 'Authorization: Bearer %s\n' "$(current "$1")" > "${hdr}"
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H @"${hdr}" "$2" || echo 000)"
  rm -f "${hdr}"; echo "${status}"
}

wanted=("$@")
if [[ ${#wanted[@]} -eq 0 ]]; then
  while IFS='|' read -r name _ _ _; do [[ -z "$(current "${name}")" ]] && wanted+=("${name}"); done < <(slots)
fi
[[ ${#wanted[@]} -gt 0 ]] || { echo "Every credential slot handled here is already set. Re-run with a NAME to replace one."; exit 0; }

for name in "${wanted[@]}"; do
  row="$(slots | grep "^${name}|")" || { echo "unknown slot ${name}" >&2; exit 2; }
  IFS='|' read -r _ need where url <<<"${row}"
  printf '\n== %s (%s)\nCreate it at: %s\n' "${name}" "${need}" "${where}"
  while :; do
    printf 'Paste %s and press Enter%s: ' "${name}" "$([[ ${need} == optional ]] && echo ' (Enter alone skips)')"
    IFS= read -rs value; echo
    value="$(printf '%s' "${value}" | tr -d '[:space:]')"
    if [[ -z "${value}" ]]; then
      [[ "${need}" == optional ]] && { echo "skipped ${name}"; continue 2; }
      echo "nothing pasted; try again (Ctrl-C to stop)"; continue
    fi
    [[ "${value}" =~ ^[A-Za-z0-9._~+/=:-]+$ ]] || { echo "that does not look like a key (unexpected characters); try again"; continue; }
    store "${name}" "${value}"; unset value
    status="$(check "${name}" "${url}")"
    if [[ "${status}" == 200 ]]; then
      echo "stored ${name} in .env (mode 600, $(current "${name}" | wc -c | tr -d ' ') chars) and verified: HTTP 200"
      break
    fi
    echo "stored ${name}, but the read-only check answered HTTP ${status} (401/403 = key refused); paste it again or Ctrl-C to keep it"
  done
done
printf '\nDone. Restart the portal (or any shell that sourced .env) to pick the new values up.\n'
