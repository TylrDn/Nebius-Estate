#!/usr/bin/env bash
# scripts/mlflow-artifacts.sh (R12 teardown): the artifact bucket Managed MLflow creates outlives the
# cluster and keeps billing (mlflow/clusters/delete). `list` shows every mlflow-*-artifacts bucket
# and whether its cluster still exists; `delete` removes one only when its cluster is gone, the name
# is a service-made artifact bucket, and CONFIRM=yes. `nebius` is a stub: no cloud.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
stub nebius '
b() { echo "{\"metadata\":{\"id\":\"$1\",\"name\":\"$2\"}}"; }
case "$*" in
  "storage bucket list"*) echo "{\"items\":[$(b bucket-e00live mlflow-mlflowcluster-e00live-artifacts),$(b bucket-e00gone mlflow-mlflowcluster-e00gone-artifacts),$(b bucket-e00data nip-sandbox-datasets-e00mock)]}" ;;
  "msp mlflow v1alpha1 cluster list"*) echo "{\"items\":[{\"metadata\":{\"id\":\"mlflowcluster-e00live\",\"name\":\"nip-sandbox-mlflow\"}}]}" ;;
  "storage bucket delete --id bucket-e00gone --ttl "*) echo "{}" ;;
  *) exit 1 ;;
esac'
export NEBIUS_PROJECT_ID=project-e00mock
s="${repo_root}/scripts/mlflow-artifacts.sh"
run() { set +e; "$@" >"${work}/out" 2>&1; echo $?; set -e; }

test_name=mlflow-artifacts-list
rc="$(run "${s}" list)"
[[ "${rc}" == 0 ]] || { cat "${work}/out" >&2; fail "list failed (rc ${rc})"; }
grep -q 'mlflow-mlflowcluster-e00gone-artifacts.*orphaned' "${work}/out" || fail "a bucket whose cluster is gone is orphaned: $(cat "${work}/out")"
grep -q 'mlflow-mlflowcluster-e00live-artifacts.*in use' "${work}/out" || fail "a bucket whose cluster exists is in use: $(cat "${work}/out")"
grep -q 'nip-sandbox-datasets' "${work}/out" && fail "only MLflow artifact buckets are listed"
grep -q 'delete' "${LOG}" && fail "list must not delete anything"
ok "lists artifact buckets, orphaned or in use, and deletes nothing"

test_name=mlflow-artifacts-delete-refusals
: > "${LOG}"
rc="$(run "${s}" delete --bucket mlflow-mlflowcluster-e00gone-artifacts)"
[[ "${rc}" == 1 ]] || fail "delete without CONFIRM=yes must refuse (rc ${rc})"
grep -q 'CONFIRM=yes' "${work}/out" || fail "the refusal names CONFIRM=yes"
rc="$(run env CONFIRM=yes "${s}" delete --bucket mlflow-mlflowcluster-e00live-artifacts)"
[[ "${rc}" == 1 ]] || fail "a bucket whose MLflow cluster still exists must not be deleted (rc ${rc})"
rc="$(run env CONFIRM=yes "${s}" delete --bucket nip-sandbox-datasets-e00mock)"
[[ "${rc}" == 2 ]] || fail "a bucket that is not mlflow-*-artifacts must be refused (rc ${rc})"
rc="$(run env CONFIRM=yes "${s}" delete --bucket mlflow-mlflowcluster-e00gone-artifacts --ttl 1week)"
[[ "${rc}" == 2 ]] || fail "a malformed --ttl must be refused (rc ${rc})"
grep -q 'bucket delete' "${LOG}" && fail "nothing may be deleted on a refusal"
ok "refuses without CONFIRM=yes, while the cluster exists, for other buckets and bad TTLs"

test_name=mlflow-artifacts-delete
: > "${LOG}"
rc="$(run env CONFIRM=yes "${s}" delete --bucket mlflow-mlflowcluster-e00gone-artifacts)"
[[ "${rc}" == 0 ]] || { cat "${work}/out" >&2; fail "delete of an orphaned bucket failed (rc ${rc})"; }
grep -q '^nebius storage bucket delete --id bucket-e00gone --ttl 0s$' "${LOG}" || fail "deletes by id with --ttl 0s (object-storage/buckets/manage): $(calls)"
: > "${LOG}"
rc="$(run env CONFIRM=yes "${s}" delete --bucket mlflow-mlflowcluster-e00gone-artifacts --ttl 24h)"
[[ "${rc}" == 0 ]] || fail "delete with --ttl failed (rc ${rc})"
grep -q -- '--ttl 24h$' "${LOG}" || fail "--ttl schedules the deletion instead: $(calls)"
ok "an orphaned artifact bucket is deleted by id, now or after --ttl"
