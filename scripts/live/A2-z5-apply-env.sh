#!/usr/bin/env bash
# Phase A2 (Z5 step 1): GitHub Environment "sandbox" for the federated APPLY job (runbooks/identity.md step 4).
#   A2-z5-apply-env.sh          dry run: reads the foundation outputs, prints every change
#   A2-z5-apply-env.sh --apply  makes them:
#     - Environment "sandbox" (no reviewers, any ref, as platform/stages.yaml says for sandbox)
#     - secrets: NIP_SA_ID (the APPLY identity, editor), NEBIUS_TENANT_ID, NEBIUS_PROJECT_ID, and a
#       READ-WRITE state key minted for state_identities.sandbox, 30-day expiry.
#       NO NIP_SA_PRIVATE_KEY / NIP_SA_KEY_ID: their absence selects the federated path.
#     - variables: NEBIUS_REGION, NIP_STATE_BUCKET
# Secret values go to gh on stdin; none is printed or written to a file.
# The GitHub repository is this checkout's (gh repo view; GH_REPO overrides); the project, region and
# profile are the sandbox target of scripts/live/lib.sh (stage binding .nip-targets/sandbox).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
apply=false; [[ "${1:-}" == --apply ]] && apply=true
need gh jq nebius terraform
cd "${REPO}"
R="${GH_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
[[ "${R}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "cannot tell the GitHub repository (got '${R}'); set GH_REPO=<owner>/<repo>"
E=sandbox
load_env
say ">>> source scripts/bootstrap-backend.sh foundation foundation"
set +e +u +o pipefail
# shellcheck source=/dev/null
source scripts/bootstrap-backend.sh foundation foundation >/dev/null; brc=$?
set -euo pipefail
(( brc == 0 )) || die "bootstrap of the foundation root failed (message above)"
out() { terraform -chdir=terraform/live/foundation output -json "$1"; }

sa=$(out ci_federation | jq -r --arg e "$E" '.[$e].NIP_SA_ID // empty')
sub=$(out ci_federation | jq -r --arg e "$E" '.[$e].subject // empty')
rw=$(out state_identities | jq -r '.sandbox.service_account_id // empty')
bucket=$(out state_buckets | jq -r '.sandbox // empty')
[[ -n "$sa" && -n "$rw" && -n "$bucket" ]] || { echo "STOP: foundation outputs missing (sa '$sa', rw '$rw', bucket '$bucket')"; exit 1; }
[[ "$(gh api "repos/$R/actions/oidc/customization/sub" --jq .use_immutable_subject)" == true ]] || { echo "STOP: repository is not on the immutable subject"; exit 1; }
if gh api "repos/$R/environments/$E/secrets" --jq '.secrets[].name' 2>/dev/null | grep -qx NIP_SA_PRIVATE_KEY; then
  echo "STOP: environment $E already holds NIP_SA_PRIVATE_KEY (key path); remove it first"; exit 1
fi

echo "environment     $E (create; no reviewers, any ref)"
echo "NIP_SA_ID       $sa  (apply identity, editor)"
echo "expected sub    ${sub:-<see terraform output ci_federation>}"
echo "state key for   $rw  (storage.object-editor, read-write), expires in 30 days"
echo "NEBIUS_REGION   $NEBIUS_REGION   NIP_STATE_BUCKET $bucket"
$apply || { echo; echo "dry run: nothing changed. Re-run with --apply."; exit 0; }

gh api -X PUT "repos/$R/environments/$E" --silent
printf '%s' "$sa"                | gh secret set NIP_SA_ID         -R "$R" --env "$E"
printf '%s' "$NEBIUS_TENANT_ID"  | gh secret set NEBIUS_TENANT_ID  -R "$R" --env "$E"
printf '%s' "$NEBIUS_PROJECT_ID" | gh secret set NEBIUS_PROJECT_ID -R "$R" --env "$E"
gh variable set NEBIUS_REGION    -R "$R" --env "$E" --body "$NEBIUS_REGION"
gh variable set NIP_STATE_BUCKET -R "$R" --env "$E" --body "$bucket"

exp=$(TZ=UTC date -v+30d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+30 days' +%Y-%m-%dT%H:%M:%SZ)
created=$(nebius --profile "${NEBIUS_PROFILE}" iam v2 access-key create --parent-id "$NEBIUS_PROJECT_ID" \
  --name "nip-tfstate-sandbox-ci-$(TZ=UTC date +%Y%m%d%H%M%S)" --account-service-account-id "$rw" \
  --description "CI access to Terraform state ($E)" --expires-at "$exp" --format json)
kid=$(jq -r .metadata.id <<<"$created")
key=$(nebius --profile "${NEBIUS_PROFILE}" iam v2 access-key get --id "$kid" --format json)
jq -r .status.aws_access_key_id <<<"$key" | gh secret set NIP_STATE_ACCESS_KEY_ID     -R "$R" --env "$E"
jq -r .status.secret            <<<"$key" | gh secret set NIP_STATE_SECRET_ACCESS_KEY -R "$R" --env "$E"
unset key created

echo; echo "=== RESULT"; echo "secrets in $E:"; gh secret list -R "$R" --env "$E"
echo "read-write state key expires $exp"
