#!/usr/bin/env bash
# Run `terraform apply` / `terraform destroy` safely (runbooks/incident.md "Terraform run safety"):
#   - refuses a saved plan older than NIP_PLAN_MAX_AGE_H hours (default 10): a stale plan applies
#     stale state (iam_token is ephemeral now, so the plan no longer carries the ~12 h token)
#   - preflights the login without opening a browser (`nebius iam get-access-token --no-browser`;
#     NEBIUS_PROFILE selects the CLI profile). In CI (NIP_CI=1, set by the stage-setup action, or
#     NIP_CI_FEDERATED=1) there is no CLI profile on either credential path: scripts/ci-token.sh
#     deletes the key path's profile right after minting, and the federated path never has one.
#     TF_VAR_iam_token is what every provider (and scripts/wait-for-ofed.sh) uses there, so the
#     preflight requires it instead (runbooks/identity.md)
#   - runs terraform in its own process group and forwards ONE SIGINT, then waits: killing an
#     apply mid-flight loses in-flight state (a live run orphaned ~30 resources that way)
#   scripts/tf-run.sh <env-dir> <planfile>      (TERRAFORM=terraform-soperator for the Soperator recipe)
set -euo pipefail
dir="${1:?usage: tf-run.sh <terraform-root> <saved-plan-file>}"; plan="${2:?usage: tf-run.sh <terraform-root> <saved-plan-file>}"
tf="${TERRAFORM:-terraform}"
token_only=0; [[ "${NIP_CI:-}" == 1 || "${NIP_CI_FEDERATED:-}" == 1 ]] && token_only=1
for c in "${tf}" $( (( token_only )) || echo nebius); do command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 2; }; done
[[ -f "${dir}/${plan}" ]] || { echo "no saved plan ${dir}/${plan}: run make plan / make destroy-plan first" >&2; exit 2; }
# shellcheck source=scripts/lib-nebius.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib-nebius.sh"
max_h="${NIP_PLAN_MAX_AGE_H:-10}"
age_h=$(( ( $(date +%s) - $(stat -c %Y "${dir}/${plan}" 2>/dev/null || stat -f %m "${dir}/${plan}") ) / 3600 ))
if (( age_h >= max_h )); then
  echo "refusing: ${plan} is ${age_h}h old (limit ${max_h}h); re-run the plan so the token and the state are fresh" >&2; exit 1
fi
if (( token_only )); then
  [[ -n "${TF_VAR_iam_token:-}" ]] || { echo "CI run (NIP_CI=1 or NIP_CI_FEDERATED=1) but TF_VAR_iam_token is empty: source scripts/ci-token.sh first" >&2; exit 1; }
else
  nip_nebius iam get-access-token --no-browser --auth-timeout 90s >/dev/null || { echo "Nebius CLI login expired (profile ${NEBIUS_PROFILE:-default}): log in again, re-source scripts/bootstrap-backend.sh, then re-plan" >&2; exit 1; }
fi

echo "applying ${plan} in ${dir}; Ctrl-C once sends terraform a single SIGINT and waits for it to unwind (do not press it twice)"
set -m
"${tf}" -chdir="${dir}" apply -input=false "${plan}" &
pid=$!
interrupted=0
# shellcheck disable=SC2317,SC2329  # invoked through the INT trap (rule id differs by shellcheck version)
on_int() {
  if (( interrupted == 0 )); then interrupted=1; echo; echo "SIGINT received: asking terraform to stop gracefully (wait; a second Ctrl-C is ignored)" >&2; kill -INT -- "-${pid}" 2>/dev/null || true
  else echo "still unwinding; wait for terraform to exit, then run scripts/leftovers.sh" >&2; fi
}
trap on_int INT
# A trapped SIGINT makes `wait` return 130 at once; re-enter it until terraform has really exited.
set +e
while :; do
  wait "${pid}"; rc=$?
  kill -0 "${pid}" 2>/dev/null || break
done
set -e
trap - INT
if (( rc != 0 )); then
  echo "terraform exited with ${rc}. State was written for whatever completed; check 'terraform -chdir=${dir} state list' and scripts/leftovers.sh before retrying" >&2
fi
exit "${rc}"
