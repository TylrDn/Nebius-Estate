#!/usr/bin/env bash
# Mint a short-lived IAM token for a stage's CI service account and export it as
# TF_VAR_iam_token — the credential path for pipelines (ADR-0009, terraform/README.md
# "Authentication"). Locally, scripts/bootstrap-backend.sh does the same from a user login.
#
# Usage:  source scripts/ci-token.sh
#
# Two paths. Key path (default) needs:
#         NIP_SA_ID        service account id (foundation output ci_identities.<stage>.service_account_id)
#         NIP_SA_KEY_ID    authorized key id: .metadata.id printed by `nebius iam auth-public-key create`
#                          (docs/credentials.md#ci-service-account-keys)
#         NIP_SA_KEY_FILE  path to the PRIVATE key (a GitHub Environment secret written to a temp file)
#         NEBIUS_PROJECT_ID  the stage's project (the profile's parent; one profile per project, per the docs)
#         nebius CLI (https://docs.nebius.com/cli/configure "set up the CLI for a service account")
#   The CLI profile lives in a throwaway config for the mint only and reads the key by path; both
#   are gone when this returns, so the key cannot mint again later in the job.
# Federated path (R13; NIP_CI_FEDERATED=1, set by .github/actions/nebius-stage-setup when the
# environment holds no private key) needs no key at all:
#         NIP_SA_ID        the account the foundation's federated credential binds (output ci_federation)
#         ACTIONS_ID_TOKEN_REQUEST_URL / ACTIONS_ID_TOKEN_REQUEST_TOKEN  GitHub's OIDC request
#                          variables (the job has `permissions: id-token: write`)
#         curl, jq
#   It swaps the job's GitHub ID token for a short-lived Nebius access token at Nebius STS
#   (https://docs.nebius.com/iam/wif#how-it-works). The request shape is assembled from the STS
#   parameter table and not yet confirmed live (runbooks/identity.md#first-federated-run).
#   Neither token is ever printed, nor passed in argv (header from a file descriptor, JWT on stdin).
#
# Refuses to run when NEBIUS_IAM_TOKEN is already set: the Nebius tooling prefers user
# credentials over service-account credentials, so a leftover user token would silently apply
# prod as a person instead of as the stage's identity.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "Run with: source ${0}  (it must export TF_VAR_iam_token into your shell)" >&2
  exit 1
fi

# Federated path: GitHub OIDC token (actor) -> Nebius STS -> access token for NIP_SA_ID (subject).
_nip_ci_token_federated() {
  local v
  for v in NIP_SA_ID ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN; do
    [[ -n "${!v:-}" ]] || { echo "Error: ${v} is not set (federated path: NIP_SA_ID from the environment; the job needs permissions id-token: write; runbooks/identity.md)" >&2; return 1; }
  done
  for v in curl jq; do command -v "${v}" >/dev/null || { echo "Error: ${v} not found" >&2; return 1; }; done
  local gh_jwt resp token
  # Tokens never go in argv (visible to every process on the runner): the request token is a
  # header read from a file descriptor (printf is a builtin), the JWT is curl's stdin.
  # STS accepts the audience sts.nebius.com only; GitHub's default (https://github.com/<owner>)
  # is refused (docs/upstream-findings.md R13-3). The request URL already carries a query.
  gh_jwt="$(curl -sSf -H @<(printf 'Authorization: bearer %s\n' "${ACTIONS_ID_TOKEN_REQUEST_TOKEN}") "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=sts.nebius.com" | jq -er .value)" \
    || { echo "Error: GitHub refused the OIDC token request (is id-token: write granted to this job?)" >&2; return 1; }
  resp="$(printf '%s' "${gh_jwt}" | curl -sS -X POST https://sts.nebius.com/oauth2/token/exchange \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
    --data-urlencode 'requested_token_type=urn:ietf:params:oauth:token-type:access_token' \
    --data-urlencode 'subject_token_type=urn:nebius:params:oauth:token-type:subject_identifier' \
    --data-urlencode "subject_token=${NIP_SA_ID}" \
    --data-urlencode 'actor_token_type=urn:ietf:params:oauth:token-type:jwt' \
    --data-urlencode 'actor_token@-')" \
    || { echo "Error: Nebius STS unreachable" >&2; return 1; }
  unset gh_jwt
  token="$(jq -er 'select(.issued_token_type == "urn:ietf:params:oauth:token-type:access_token") | .access_token' <<<"${resp}" 2>/dev/null)" \
    || { echo "Error: STS refused the exchange for ${NIP_SA_ID}: $(jq -c 'del(.access_token?)' <<<"${resp}" 2>/dev/null || echo 'non-JSON response')" >&2; return 1; }
  [[ -n "${token}" ]] || { echo "Error: empty token for ${NIP_SA_ID}" >&2; return 1; }
  export TF_VAR_iam_token="${token}" NIP_CI_FEDERATED=1
  echo "Exported TF_VAR_iam_token for service account ${NIP_SA_ID} (federated; expires_in $(jq -r '.expires_in // "?"' <<<"${resp}") s)"
}

_nip_ci_token() {
  local v
  if [[ -n "${NEBIUS_IAM_TOKEN:-}" ]]; then
    echo "Error: NEBIUS_IAM_TOKEN is set; a user token would win over the service account. Unset it first." >&2
    return 1
  fi
  if [[ "${NIP_CI_FEDERATED:-}" == 1 ]]; then
    _nip_ci_token_federated
    return
  fi
  for v in NIP_SA_ID NIP_SA_KEY_ID NIP_SA_KEY_FILE NEBIUS_PROJECT_ID; do
    [[ -n "${!v:-}" ]] || { echo "Error: ${v} is not set (environment secrets of the stage; docs/change-management.md)" >&2; return 1; }
  done
  command -v nebius >/dev/null || { echo "Error: nebius CLI not found" >&2; return 1; }
  [[ -r "${NIP_SA_KEY_FILE}" ]] || { echo "Error: ${NIP_SA_KEY_FILE} is not readable" >&2; return 1; }
  local perms
  perms="$(stat -c %a "${NIP_SA_KEY_FILE}" 2>/dev/null || stat -f %Lp "${NIP_SA_KEY_FILE}")"
  [[ "${perms}" == "600" || "${perms}" == "400" ]] || { echo "Error: ${NIP_SA_KEY_FILE} must be mode 600 or 400 (is ${perms})" >&2; return 1; }

  # A throwaway CLI config holds the profile only while the token is minted: the key is read by
  # path (--private-key-file-path, never copied into the config) and the config is deleted right
  # after, so no later step in the job can mint another token from it. Every provider and
  # script then uses TF_VAR_iam_token (scripts/tf-run.sh, scripts/wait-for-ofed.sh).
  local profile="nip-ci-${NIP_SA_ID: -8}" cfg_dir
  cfg_dir="$(mktemp -d)" || { echo "Error: mktemp failed" >&2; return 1; }
  local token="" rc=0
  if nebius --config "${cfg_dir}/config.yaml" profile create "${profile}" --endpoint api.nebius.cloud \
      --service-account-id "${NIP_SA_ID}" --public-key-id "${NIP_SA_KEY_ID}" \
      --private-key-file-path "${NIP_SA_KEY_FILE}" --parent-id "${NEBIUS_PROJECT_ID}" >/dev/null; then
    token="$(nebius --config "${cfg_dir}/config.yaml" --profile "${profile}" iam get-access-token)" || rc=2
  else
    rc=1
  fi
  rm -rf "${cfg_dir}"
  (( rc != 1 )) || { echo "Error: nebius profile create ${profile} failed: check NIP_SA_ID, NIP_SA_KEY_ID and that the key file matches the registered public key" >&2; return 1; }
  (( rc != 2 )) || { echo "Error: no token for ${NIP_SA_ID}: the authorized key may be expired or revoked (runbooks/credential-rotation.md)" >&2; return 1; }
  [[ -n "${token}" ]] || { echo "Error: empty token for ${NIP_SA_ID}" >&2; return 1; }
  export TF_VAR_iam_token="${token}"
  echo "Exported TF_VAR_iam_token for service account ${NIP_SA_ID} (CLI profile ${profile} created for this mint only, then deleted)"
}

_nip_ci_token "$@"
