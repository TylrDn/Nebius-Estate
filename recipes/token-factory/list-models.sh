#!/usr/bin/env bash
# R11 Token Factory: list the models the API key can call. Read-only and free: one GET /v1/models
# (https://docs.tokenfactory.nebius.com/api-reference/models/list-models). Creates nothing, sends
# no prompt, spends no credit.
#
# Usage: recipes/token-factory/list-models.sh [--verbose] [--json]
#   (default)   one line per model: id and owner (owned_by)
#   --verbose   ask for ?verbose=true and add context length, the prompt/completion price fields and
#               the per-model requests/tokens per minute, exactly as the API returns them (the
#               published schema states neither the price unit nor the per_request_limits keys)
#   --json      print the raw response instead of the table
# Needs: NEBIUS_API_KEY (Token Factory → API keys), from the environment or the repository's .env
#        (docs/credentials.md). The key is passed to curl on stdin, never on the command line, and
#        never printed. NIP_TF_BASE_URL overrides the base URL (default https://api.tokenfactory.nebius.com/v1).
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
base_url="${NIP_TF_BASE_URL:-https://api.tokenfactory.nebius.com/v1}"
base_url="${base_url%/}"
verbose=0 json=0
for arg in "$@"; do
  case "${arg}" in
    --verbose) verbose=1 ;;
    --json) json=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: ${arg} (see --help)" >&2; exit 2 ;;
  esac
done
for c in curl jq; do command -v "${c}" >/dev/null || { echo "missing: ${c}" >&2; exit 2; }; done

# Read only NEBIUS_API_KEY from .env, in a subshell, so nothing else in the file enters this process.
key="${NEBIUS_API_KEY:-}"
if [[ -z "${key}" && -f "${repo_root}/.env" ]]; then
  # shellcheck disable=SC1091
  key="$(set -a; source "${repo_root}/.env" >/dev/null 2>&1; printf '%s' "${NEBIUS_API_KEY:-}")"
fi
[[ -n "${key}" ]] || { echo "NEBIUS_API_KEY is not set (environment or ${repo_root}/.env; docs/credentials.md)" >&2; exit 2; }

url="${base_url}/models"
(( verbose )) && url="${url}?verbose=true"
body="$(mktemp)"; trap 'rm -f "${body}"' EXIT
# The Authorization header goes through a curl config read from stdin (-K -), so it is not in argv
# (ps) and not in any output. -w prints only the status code.
status="$(curl -sS -o "${body}" -w '%{http_code}' --max-time 30 -K - "${url}" \
  -H 'Accept: application/json' -H 'User-Agent: nip-token-factory-list-models/1' \
  <<<"header = \"Authorization: Bearer ${key}\"")" || { echo "request to ${url} failed (network)" >&2; exit 1; }
unset key
if [[ "${status}" != 200 ]]; then
  echo "GET ${url} returned HTTP ${status}: $(jq -c '.detail // .' "${body}" 2>/dev/null || head -c 300 "${body}")" >&2
  exit 1
fi

if (( json )); then
  jq . "${body}"
elif (( verbose )); then
  jq -r '["ID","OWNER","CONTEXT","PROMPT_PRICE","COMPLETION_PRICE","RPM","TPM"], (.data | sort_by(.id)[]
    | [.id, (.owned_by // "-"), ((.context_length // "-") | tostring), (.pricing.prompt // "-"), (.pricing.completion // "-"),
       ((.per_request_limits.requests_per_minute // "-") | tostring), ((.per_request_limits.tokens_per_minute // "-") | tostring)]) | @tsv' "${body}"
else
  jq -r '["ID","OWNER"], (.data | sort_by(.id)[] | [.id, (.owned_by // "-")]) | @tsv' "${body}"
fi
echo "$(jq '.data | length' "${body}") models at ${base_url} ($(date -u +%FT%TZ))" >&2
