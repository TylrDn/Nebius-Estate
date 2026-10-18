#!/usr/bin/env bash
# scripts/ci-token.sh: the private key never persists in a CLI profile, and no token reaches argv.
# shellcheck disable=SC2016,SC2030,SC2031  # stub bodies expand when the stub runs; env changes stay in their subshell on purpose
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# --- key path: a throwaway CLI config that reads the key by path, deleted once the token exists.
test_name=ci-token-key
stub nebius '
cfg=""; prev=""
for a in "$@"; do [[ "${prev}" == --config || "${prev}" == -c ]] && cfg="${a}"; prev="${a}"; done
echo "config=${cfg}" >> "$LOG"
case " $* " in
  *" profile create "*) [[ -n "${cfg}" ]] && echo "profiles: {}" > "${cfg}"; exit 0 ;;
  *" iam get-access-token"*) echo "sa-token-sentinel" ;;
  *) exit 0 ;;
esac'
key="${work}/sa.pem"; echo "-----BEGIN PRIVATE KEY-----" > "${key}"; chmod 600 "${key}"
(
  unset NEBIUS_IAM_TOKEN NIP_CI_FEDERATED
  export NIP_SA_ID=serviceaccount-e00mockci000 NIP_SA_KEY_ID=publickey-e00mock NIP_SA_KEY_FILE="${key}" NEBIUS_PROJECT_ID=project-e00mock
  # shellcheck source=scripts/ci-token.sh
  source "${repo_root}/scripts/ci-token.sh" >/dev/null
  printf '%s' "${TF_VAR_iam_token:-}" > "${work}/token"
)
[[ "$(cat "${work}/token")" == sa-token-sentinel ]] || fail "TF_VAR_iam_token was not exported"
grep -q -- '--private-key-file-path' "${LOG}" || fail "profile create must reference the key by path (--private-key-file-path), not copy it in"
grep -qE -- '--private-key-file( |$)' "${LOG}" && fail "--private-key-file copies the key into the CLI config"
cfgs="$(sed -n 's/^config=//p' "${LOG}" | sort -u)"
[[ -n "${cfgs}" && "$(wc -l <<<"${cfgs}")" -eq 1 ]] || fail "every nebius call must use one throwaway --config (got: ${cfgs:-none})"
[[ ! -e "${cfgs}" ]] || fail "the throwaway CLI config ${cfgs} must be deleted after minting"
[[ ! -e "${HOME}/.nebius" ]] || fail "nothing may be written to the default CLI config"
ok "key read by path, config deleted after minting"

# --- federated path: neither the GitHub request token nor the JWT appears in curl's argv.
test_name=ci-token-federated
: > "${LOG}"
stub curl '
for ((i = 1; i <= $#; i++)); do
  a="${!i}"
  if [[ "${a}" == -H ]]; then j=$((i + 1)); h="${!j}"; [[ "${h}" == @* ]] && cat "${h#@}" >> "$LOG.headers"; fi
  if [[ "${a}" == --data-urlencode ]]; then j=$((i + 1)); d="${!j}"; [[ "${d}" == *@- ]] && { cat >> "$LOG.stdin"; echo >> "$LOG.stdin"; }; fi
done
case "$*" in
  *oidc-request.invalid*) echo "{\"value\":\"gh-jwt-sentinel\"}" ;;
  *sts.nebius.com*) echo "{\"issued_token_type\":\"urn:ietf:params:oauth:token-type:access_token\",\"access_token\":\"neb-token\",\"expires_in\":3600}" ;;
esac'
(
  unset NEBIUS_IAM_TOKEN
  export NIP_CI_FEDERATED=1 NIP_SA_ID=serviceaccount-e00mockci000
  export ACTIONS_ID_TOKEN_REQUEST_URL="https://oidc-request.invalid/token?api-version=2.0" ACTIONS_ID_TOKEN_REQUEST_TOKEN=req-token-sentinel
  # shellcheck source=scripts/ci-token.sh
  source "${repo_root}/scripts/ci-token.sh" >/dev/null
  printf '%s' "${TF_VAR_iam_token:-}" > "${work}/token"
)
[[ "$(cat "${work}/token")" == neb-token ]] || fail "federated TF_VAR_iam_token was not exported"
grep -q 'req-token-sentinel\|gh-jwt-sentinel' "${LOG}" && fail "a token appeared in curl's argv"
grep -q 'Authorization: bearer req-token-sentinel' "${LOG}.headers" || fail "the GitHub request token must go in a header read from a file (-H @file)"
grep -qx 'gh-jwt-sentinel' "${LOG}.stdin" || fail "the GitHub JWT must reach STS on stdin (actor_token@-), unchanged"
grep -q 'oidc-request.invalid/token?api-version=2.0&audience=sts.nebius.com' "${LOG}" || fail "the GitHub OIDC token must be requested for audience sts.nebius.com, the only one STS accepts (R13-3)"
ok "tokens only in header files and stdin; audience sts.nebius.com"
