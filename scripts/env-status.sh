#!/usr/bin/env bash
# Report which credential slots from .env.example are set in .env (or the environment), without
# printing any value. Also checks that .env and secrets/ are private and git-ignored.
# Usage: scripts/env-status.sh [--live]   (make env-status / make env-status LIVE=1)
# Offline, it also reports the CI key expiries recorded in platform/ci-keys.yaml (NIP_CI_KEYS overrides
# the path): a warning from NIP_CI_KEY_WARN_DAYS (14) days before an expiry, naming the rotation
# runbook, and exit 1 once one has passed. NIP_DOTENV replaces .env and NIP_SECRETS_DIR replaces
# secrets/ (tests point them away).
# --live (read-only cloud calls): the portal key still mints a token, and every key of the portal
# service account is ACTIVE and more than 30 days from expiry (needs NEBIUS_PROFILE with admin read).
set -euo pipefail
live=0; [[ "${1:-}" == --live ]] && live=1
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib-time.sh
source scripts/lib-time.sh
[[ -f .env.example ]] || { echo "missing .env.example" >&2; exit 2; }
dotenv="${NIP_DOTENV:-.env}"
secrets_dir="${NIP_SECRETS_DIR:-secrets}"
# ignored <path> <label>: warn when git does not ignore <path>. git exits 1 for "not ignored" and
# 128 when it cannot answer (not a repository, or one owned by another user); the second is said as
# such, never reported as "not ignored".
ignored() {
  local rc=0
  git check-ignore -q "$1" 2>/dev/null || rc=$?
  case "${rc}" in
    0) ;;
    1) echo "WARNING: $2 is NOT git-ignored" ;;
    *) echo "WARNING: could not check that $2 is git-ignored (git exited ${rc}; run this in the repository as its owner)" ;;
  esac
}
if [[ -f "${dotenv}" ]]; then
  perms="$(stat -c %a "${dotenv}" 2>/dev/null || stat -f %Lp "${dotenv}")"
  [[ "${perms}" == 600 || "${perms}" == 400 ]] || echo "WARNING: ${dotenv} is mode ${perms}; run: chmod 600 ${dotenv}"
  [[ "${dotenv}" != .env ]] || ignored .env .env
  set -a
  # shellcheck source=/dev/null
  source "${dotenv}"
  set +a
else
  echo "no .env yet: cp .env.example .env && chmod 600 .env"
fi
if [[ -d "${secrets_dir}" ]]; then
  ignored "${secrets_dir}/x" "${secrets_dir}/"
  find "${secrets_dir}" -type f ! -perm 600 ! -perm 400 -exec echo "WARNING: {} is not mode 600" \;
fi
section=""
while IFS= read -r line; do
  if [[ "${line}" =~ ^\#\ ----\ (.*)\ -+$ ]]; then section="${BASH_REMATCH[1]}"; printf '\n%s\n' "${section}"; continue; fi
  [[ "${line}" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
  name="${BASH_REMATCH[1]}"
  value="${!name:-}"
  default="$(sed -E 's/^[^=]*=([^ #]*).*/\1/' <<<"${line}")"
  if [[ -z "${value}" ]]; then state="-  unset"
  elif [[ "${name}" == *_FILE && ! -r "${value}" && "${value}" == "${default}" ]]; then state="-  unset (template path, no file)"
  elif [[ "${name}" == *_FILE ]]; then [[ -r "${value}" ]] && state="ok file present" || state="!  file missing: ${value}"
  else state="ok set"; fi
  printf '  %-40s %s\n' "${name}" "${state}"
done < .env.example

# CI keys are GitHub Environment secrets: their expiry is recorded by hand when they are minted.
rc=0
ci_keys="${NIP_CI_KEYS:-platform/ci-keys.yaml}"
warn_days="${NIP_CI_KEY_WARN_DAYS:-14}"
if [[ -f "${ci_keys}" ]]; then
  printf '\nCI keys (%s; warning %s days before expiry)\n' "${ci_keys}" "${warn_days}"
  now="$(nip_now)"
  field() { sed -nE "s/.*[{,] *$1: *\"?([^,\"}]*)\"?.*/\1/p" <<<"$2"; }
  while IFS= read -r line; do
    [[ "${line}" =~ ^[[:space:]]*-[[:space:]]*\{ ]] || continue
    env="$(field environment "${line}")" what="$(field what "${line}")" exp="$(field expires "${line}")" rotate="$(field rotate "${line}")"
    at="$(nip_epoch "${exp}" 2>/dev/null)" || { echo "  !  ${env}: unreadable expires '${exp}' in ${ci_keys}"; rc=1; continue; }
    days=$(( (at - now) / 86400 ))
    if (( at <= now )); then echo "  !  ${env} ${what} expired ${exp}: rotate now (${rotate})"; rc=1
    elif (( at - now <= warn_days * 86400 )); then echo "  !  ${env} ${what} expires ${exp} (in ${days} days): rotate before then (${rotate})"
    else echo "  ok ${env} ${what} expires ${exp} (in ${days} days)"; fi
  done < "${ci_keys}"
fi

[[ "${live}" == 1 ]] || exit "${rc}"
printf '\nLive checks (read-only)\n'
# shellcheck source=scripts/lib-nebius.sh
source scripts/lib-nebius.sh
viewer="${NEBIUS_VIEWER_PROFILE:-nip-portal-viewer}"
if nebius profile list 2>/dev/null | grep -q "^${viewer}\b"; then
  if nebius --profile "${viewer}" iam get-access-token >/dev/null 2>&1; then echo "  ok portal key mints a token (profile ${viewer})"
  else echo "  !  portal key cannot mint a token (profile ${viewer}): check the key and its expiry"; rc=1; fi
else
  echo "  -  no CLI profile ${viewer}: create it from the portal key (docs/credentials.md#portal-read-only-service-account)"
fi
if [[ -n "${NEBIUS_SA_ID:-}" ]]; then
  soon="$(date -u -v+30d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+30 days' +%Y-%m-%dT%H:%M:%SZ)"
  report="$(for kind in "auth-public-key list-by-account" "v2 access-key list-by-account"; do
    # shellcheck disable=SC2086
    keys="$(nip_nebius iam ${kind} --account-service-account-id "${NEBIUS_SA_ID}" --format json 2>/dev/null)" \
      || { echo "  !  cannot list ${kind%% *} keys with profile ${NEBIUS_PROFILE:-default} (needs admin read)"; rc=1; continue; }
    jq -r --arg soon "${soon}" --arg k "${kind%% list*}" '.items[]? |
      (.spec.expires_at // "never") as $e | (.status.state // "-") as $s |
      if $s != "ACTIVE" then "  !  \($k) \(.metadata.id[0:14])… state \($s)"
      elif $e != "never" and $e < $soon then "  !  \($k) \(.metadata.id[0:14])… expires \($e) (within 30 days: rotate, runbooks/credential-rotation.md)"
      else "  ok \($k) \(.metadata.id[0:14])… active, expires \($e)" end' <<<"${keys}"
  done)"
  echo "${report}"
  grep -q '^  !' <<<"${report}" && rc=1
fi
exit "${rc}"
