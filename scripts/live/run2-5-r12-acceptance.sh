#!/usr/bin/env bash
# Run 2 step 5: R12 acceptance, as runbooks/ml-services.md#validate except the Secret: passwords
# read at silent prompts and given to kubectl as files (process substitution, printf builtin),
# never --from-literal on argv. Then tests/validate/ml-services.sh, the Secret is deleted and the
# registry is emptied of the nip-check image the check pushed (so the TTL job's destroy can delete it).
# Executed: bash run2-5-r12-acceptance.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-5-r12-acceptance
header "Run 2 step 5 - R12 acceptance (registry, MLflow, PostgreSQL, node pull)" \
  "Secret ml-services-check from files; REGISTRY_URL/MLFLOW_HOST/PG_HOST from outputs; tests/validate/ml-services.sh; delete the Secret" \
  "\$0 extra" "about 5-15 min (check Job waits up to 15 min)" "the RESULT block (ml-services.json checks)"
need kubectl terraform jq nebius
need_tty
check_repo
load_env
kube_env

boot ml-services
o() { terraform -chdir=terraform/live/sandbox/ml-services output -json | jq -r "$1"; }
REGISTRY_URL="$(o .registry_url.value)"
MLFLOW_HOST="$(o '.mlflow.value.private_tracking // empty')"
PG_HOST="$(o '.postgresql.value.private_read_write // empty')"
[[ -n "${REGISTRY_URL}" ]] || die "empty registry_url output"
say "REGISTRY_URL=${REGISTRY_URL} MLFLOW_HOST=${MLFLOW_HOST:-<skip>} PG_HOST=${PG_HOST:-<skip>}"

cleanup() { kubectl -n ml-services delete secret ml-services-check --ignore-not-found >/dev/null 2>&1 || true; }
trap 'rc=$?; cleanup; _on_exit $rc' EXIT
run kubectl create namespace ml-services --dry-run=client -o yaml | kubectl apply -f -
cleanup
if [[ -n "${R12_BATCH_PG_PW:-}" && -n "${R12_BATCH_MLFLOW_PW:-}" ]]; then  # run2-all.sh
  PG_PW="${R12_BATCH_PG_PW}" MLFLOW_PW="${R12_BATCH_MLFLOW_PW}"
else
  read -rs -p "PostgreSQL password (SecretStash postgresql-password; hidden): " PG_PW; echo
  read -rs -p "MLflow admin password (SecretStash mlflow-admin-password; hidden): " MLFLOW_PW; echo
fi
[[ -n "${PG_PW}" && -n "${MLFLOW_PW}" ]] || die "empty password"
say ">>> nebius iam get-access-token | kubectl -n ml-services create secret generic ml-services-check --from-file=REGISTRY_TOKEN=/dev/stdin --from-file=MLFLOW_TRACKING_PASSWORD=<(...) --from-file=PGPASSWORD=<(...)"
nebius --profile "${NEBIUS_PROFILE}" iam get-access-token | kubectl -n ml-services create secret generic ml-services-check \
  --from-file=REGISTRY_TOKEN=/dev/stdin --from-file=MLFLOW_TRACKING_PASSWORD=<(printf %s "${MLFLOW_PW}") --from-file=PGPASSWORD=<(printf %s "${PG_PW}") >/dev/null
unset PG_PW MLFLOW_PW
rc=0
REGISTRY_URL="${REGISTRY_URL}" MLFLOW_HOST="${MLFLOW_HOST}" PG_HOST="${PG_HOST}" tests/validate/ml-services.sh || rc=$?
cleanup
say "Secret ml-services-check after cleanup: $(kubectl -n ml-services get secret ml-services-check -o name 2>/dev/null || echo 'gone')"
# ml-services.sh pushed REGISTRY_URL/nip-check@<digest> and leaves it; a registry with images cannot
# be deleted (runbooks/ml-services.md "Teardown" step 2), which would also break the ml-services TTL
# job's destroy. Empty it now (step 10 and abort.sh empty it again before their destroy).
registry_purge || say "WARNING: ${REGISTRY_NOTE}; step 10 retries it before the destroy"

result_begin
say "ml-services.sh exit ${rc}"
say "${REGISTRY_NOTE}"
jq -c '{status, details}' results/ml-services.json 2>/dev/null || say "results/ml-services.json missing"
state_load run2
say "SecretStash secret created by: ${R12_SECRET_METHOD:-unknown} (record in the R12 evidence)"
say "evidence: docs/evidence/<date>-sandbox-ml-services-acceptance.md"
(( rc == 0 )) || exit "${rc}"
say "next: bash ${LIVE_DIR}/run2-6-r14-acceptance.sh"
