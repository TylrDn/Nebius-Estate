#!/usr/bin/env bash
# tests/validate/ml-services.sh (R12 clients): the check Job pushes to and pulls from the registry,
# logs and reads back an MLflow run and runs psql `select 1`; then a pod pulls the pushed image on a
# node with no pull secret. Pass only when every check that ran passed. kubectl is a stub that
# answers from the fixtures in tests/validate/fixtures: no cluster, no registry.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
export FIXTURES="${repo_root}/tests/validate/fixtures"
stub kubectl '
case "$*" in
  "create namespace ml-services --dry-run=client -o yaml") echo "kind: Namespace" ;;
  "apply -f -") cat >/dev/null ;;
  "-n ml-services get secret ml-services-check -o name") [[ -n "${SECRET_MISSING:-}" ]] && exit 1; echo secret/ml-services-check ;;
  "-n ml-services create configmap ml-services-check "*"--dry-run=client -o yaml") echo "kind: ConfigMap" ;;
  "-n ml-services delete job ml-services-check --ignore-not-found"|"-n ml-services delete pod ml-services-pull-check --ignore-not-found"*) ;;
  "apply -k "*) ;;
  "-n ml-services get job ml-services-check -o json") echo "{\"status\":{\"conditions\":[{\"type\":\"${JOB_STATUS:-Complete}\",\"status\":\"True\"}]}}" ;;
  "-n ml-services logs job/ml-services-check -c registry") cat "${FIXTURES}/ml-services-registry.log" ;;
  "-n ml-services logs job/ml-services-check -c mlflow") [[ -n "${NO_MLFLOW:-}" ]] && echo "NIP-CHECK {\"check\":\"mlflow\",\"skipped\":true}" || cat "${FIXTURES}/ml-services-mlflow.log" ;;
  "-n ml-services logs job/ml-services-check -c postgresql") cat "${FIXTURES}/${PG_LOG:-ml-services-postgresql.log}" ;;
  "-n ml-services get serviceaccount default -o json") echo "{\"metadata\":{\"name\":\"default\"}}" ;;
  "-n ml-services run ml-services-pull-check "*) ;;
  "-n ml-services get pod ml-services-pull-check -o json")
    if [[ "${PULL:-ok}" == ok ]]; then echo "{\"spec\":{\"nodeName\":\"node-a\"},\"status\":{\"phase\":\"Succeeded\"}}"
    else echo "{\"spec\":{\"nodeName\":\"node-a\"},\"status\":{\"phase\":\"Pending\",\"containerStatuses\":[{\"state\":{\"waiting\":{\"reason\":\"ErrImagePull\",\"message\":\"403 Forbidden\"}}}]}}"; fi ;;
  "config current-context") echo mock ;;
  *) exit 1 ;;
esac'
export RESULTS_DIR="${work}/results" ML_CHECK_WAIT_S=5 \
  REGISTRY_URL=cr.eu-north1.nebius.cloud/e00mockregistry MLFLOW_HOST=mlflow.example.invalid PG_HOST=pg.example.invalid
check() { set +e; env "$@" bash "${repo_root}/tests/validate/ml-services.sh" >"${work}/out" 2>&1; echo $?; set -e; }
result() { jq -r "$1" "${RESULTS_DIR}/ml-services.json"; }

test_name=ml-services-all-clients
rc="$(check)"
[[ "${rc}" == 0 && "$(result .status)" == pass ]] || { cat "${work}/out" >&2; fail "every check passing must pass (rc ${rc})"; }
[[ "$(result '.details.registry.ok')" == true && "$(result '.details.mlflow.run_id')" == 0123456789abcdef && "$(result '.details.postgresql.select_1')" == 1 ]] \
  || fail "each client's result is recorded: $(result .details)"
grep -q -- '-n ml-services run ml-services-pull-check .*--image=cr.eu-north1.nebius.cloud/e00mockregistry/nip-check@sha256:1111111111111111111111111111111111111111111111111111111111111111' "${LOG}" \
  || fail "the node pull uses the digest the Job pushed: $(calls)"
grep '\-n ml-services run ml-services-pull-check ' "${LOG}" | grep -q imagePullSecrets && fail "the node pull must not carry a pull secret"
[[ "$(result '.details.node_pull.ok')" == true && "$(result '.details.node_pull.service_account_pull_secrets')" == 0 ]] || fail "node pull recorded: $(result .details.node_pull)"
grep -q 'configmap ml-services-check .*--from-literal=MLFLOW_HOST=mlflow.example.invalid' "${LOG}" || fail "inputs reach the Job's ConfigMap"
ok "registry push and pull, MLflow run, psql select 1 and a node pull without a secret: pass"

test_name=ml-services-psql-fails
rc="$(check PG_LOG=ml-services-postgresql-fail.log JOB_STATUS=Failed)"
[[ "${rc}" != 0 && "$(result .status)" == fail && "$(result '.details.postgresql.ok')" == false && "$(result '.details.registry.ok')" == true ]] \
  || fail "a failed psql fails the step and keeps the other results (rc ${rc})"
ok "a failed client fails the step"

test_name=ml-services-node-pull-fails
rc="$(check PULL=denied)"
[[ "${rc}" != 0 && "$(result '.details.node_pull.reason')" == ErrImagePull ]] || fail "a node that cannot pull fails the step (rc ${rc}): $(result .details.node_pull)"
ok "a node pull refused by the registry fails the step"

test_name=ml-services-skip-and-refuse
rc="$(check NO_MLFLOW=1 MLFLOW_HOST=)"
[[ "${rc}" == 0 && "$(result '.details.mlflow.skipped')" == true ]] || fail "a service left out (MLFLOW_HOST empty) is skipped, not failed (rc ${rc})"
rc="$(check SECRET_MISSING=1)"
[[ "${rc}" == 2 ]] || fail "no Secret ml-services-check: refuse before applying (rc ${rc})"
rc="$(check REGISTRY_URL=)"
[[ "${rc}" == 2 ]] || fail "REGISTRY_URL is required (rc ${rc})"
ok "skips a service that is not set; refuses without the Secret or the registry"
