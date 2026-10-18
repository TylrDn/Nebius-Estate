# Shared helpers for the R14 read-only clients (metrics.sh, logs.sh); sourced, not run.
# Every request is a GET with a bearer token passed to curl on stdin (-K -), so the token is never
# in argv (ps) or in any output. --dry-run prints the request with the token redacted and makes no
# call, needs no token and no network.
#
# Token, first match wins:
#   NEBIUS_IAM_TOKEN   an IAM access token (`nebius iam get-access-token`, valid about 12 h)
#   PROMETHEUS_TOKEN   an OBSERVABILITY static key (docs/credentials.md#observability-static-key),
#                      from the environment or the repository's .env
#   the nebius CLI     `nebius --profile "${NEBIUS_PROFILE:-nip-portal-viewer}" iam get-access-token`
#                      (the read-only portal identity's profile by default)
# Project: --project, else NEBIUS_PROJECT_ID (environment or .env).
# shellcheck shell=bash
# shellcheck disable=SC2034  # O11Y_STATUS is read by the scripts that source this file

o11y_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
o11y_ua="nip-observability/1"

o11y_die() { echo "$*" >&2; exit 2; }

# Read one variable from .env in a separate shell, so nothing else in the file enters this process.
o11y_from_env_file() {
  [[ -f "${o11y_repo_root}/.env" ]] || return 0
  # shellcheck disable=SC2016  # expanded by the inner shell
  env -i PATH="${PATH}" bash --noprofile --norc -c 'set -a; source "$1" >/dev/null 2>&1; printf "%s" "${!2:-}"' _ "${o11y_repo_root}/.env" "$1"
}

# o11y_project <flag value>: the project ID, or exit 2.
o11y_project() {
  local p="${1:-${NEBIUS_PROJECT_ID:-}}"
  [[ -n "${p}" ]] || p="$(o11y_from_env_file NEBIUS_PROJECT_ID)"
  [[ -n "${p}" ]] || o11y_die "no project: pass --project project-... or set NEBIUS_PROJECT_ID"
  [[ "${p}" =~ ^project-[a-z0-9]+$ ]] || o11y_die "project must be a Nebius project ID (project-...), got '${p}'"
  printf '%s' "${p}"
}

# o11y_token: print the bearer token (never echoed by the callers).
o11y_token() {
  if [[ -n "${NEBIUS_IAM_TOKEN:-}" ]]; then printf '%s' "${NEBIUS_IAM_TOKEN}"; return; fi
  local t="${PROMETHEUS_TOKEN:-}"
  [[ -n "${t}" ]] || t="$(o11y_from_env_file PROMETHEUS_TOKEN)"
  if [[ -n "${t}" ]]; then printf '%s' "${t}"; return; fi
  command -v nebius >/dev/null || o11y_die "no token: set NEBIUS_IAM_TOKEN or PROMETHEUS_TOKEN, or install the nebius CLI"
  t="$(nebius --profile "${NEBIUS_PROFILE:-nip-portal-viewer}" iam get-access-token 2>/dev/null)" \
    || o11y_die "nebius iam get-access-token failed for profile ${NEBIUS_PROFILE:-nip-portal-viewer} (log in, or set NEBIUS_IAM_TOKEN)"
  printf '%s' "${t}"
}

# o11y_get <dry_run 0|1> <out file> <url> [--data-urlencode k=v ...]: GET, print nothing on success.
# Returns curl's HTTP status in O11Y_STATUS. With dry_run=1 prints the request as JSON and returns.
o11y_get() {
  local dry="$1" out="$2" url="$3"; shift 3
  if (( dry )); then
    python3 -I - "${url}" "$@" <<'PY'
import json, sys, urllib.parse
url, rest = sys.argv[1], sys.argv[2:]
params = [tuple(rest[i + 1].split("=", 1)) for i in range(0, len(rest), 2) if rest[i] == "--data-urlencode"]
print(json.dumps({"dry_run": True, "method": "GET", "url": url, "params": dict(params),
                  "full_url": url + ("?" + urllib.parse.urlencode(params) if params else ""),
                  "headers": {"Authorization": "Bearer <token redacted>", "Accept": "application/json"}}, indent=1))
PY
    O11Y_STATUS="dry-run"
    return 0
  fi
  command -v curl >/dev/null || o11y_die "missing: curl"
  local token
  token="$(o11y_token)" || exit 2
  O11Y_STATUS="$(curl -sS -G -o "${out}" -w '%{http_code}' --max-time 60 -K - "${url}" "$@" \
    -H 'Accept: application/json' -H "User-Agent: ${o11y_ua}" \
    <<<"header = \"Authorization: Bearer ${token}\"")" || { echo "GET ${url} failed (network)" >&2; exit 1; }
}

# o11y_since <duration like 15m, 2h, 7d>: seconds.
o11y_since() {
  [[ "$1" =~ ^([0-9]+)([smhd])$ ]] || o11y_die "--since takes a duration such as 15m, 2h or 7d, got '$1'"
  local n="${BASH_REMATCH[1]}"
  case "${BASH_REMATCH[2]}" in s) echo "${n}" ;; m) echo $((n * 60)) ;; h) echo $((n * 3600)) ;; d) echo $((n * 86400)) ;; esac
}
