#!/usr/bin/env bash
# R12 teardown: the Object Storage bucket Managed MLflow creates for artifacts is not deleted with
# the cluster and keeps billing until it is (https://docs.nebius.com/mlflow/clusters/delete). The
# service names it mlflow-<cluster id>-artifacts (live run 2026-10-11) and gives it no labels, so
# `make destroy` and the label-based residue check never see it.
#   scripts/mlflow-artifacts.sh list
#       every mlflow-*-artifacts bucket in the project, "in use" while a cluster whose id is in the
#       name exists, otherwise "orphaned". Read-only.
#   CONFIRM=yes scripts/mlflow-artifacts.sh delete --bucket <name> [--ttl <delay>]
#       delete one orphaned artifact bucket, objects included: `nebius storage bucket delete --ttl`
#       (default 0s = now; e.g. 24h keeps a restore window, and the bucket bills until it is purged)
#       (https://docs.nebius.com/object-storage/buckets/manage#how-to-delete-buckets). Refused while
#       its cluster exists, for any other bucket name, and without CONFIRM=yes. Export what must be
#       kept first (https://docs.nebius.com/mlflow/clusters/export-data).
# A bucket set through mlflow.storage_bucket_name belongs to its owner and does not match the name.
# Needs: NEBIUS_PROJECT_ID (the stage's project); nebius CLI (NEBIUS_PROFILE honoured); jq.
set -euo pipefail
cmd="${1:-}"; [[ $# -gt 0 ]] && shift
bucket=""; ttl="0s"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket) bucket="${2:?--bucket needs a name}"; shift 2 ;;
    --ttl) ttl="${2:?--ttl needs a delay like 0s, 30m or 24h}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "${cmd}" in list|delete) ;; -h|--help|"") sed -n '2,19p' "$0"; exit 0 ;; *) echo "unknown command: ${cmd} (list | delete)" >&2; exit 2 ;; esac
for c in nebius jq; do command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 2; }; done
# shellcheck source=scripts/lib-nebius.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib-nebius.sh"
: "${NEBIUS_PROJECT_ID:?set NEBIUS_PROJECT_ID to the stage project}"
p="${NEBIUS_PROJECT_ID}"

# One listing of every page; a failed call stops the script instead of reading as "nothing there".
list_all() {
  local out
  out="$(nip_nebius "$@" list --parent-id "${p}" --all --format json 2>/dev/null)" \
    || { echo "could not list (nebius $* list): check the login and that NEBIUS_PROJECT_ID is the stage project" >&2; exit 2; }
  jq -c '.items // .clusters // []' <<<"${out:-{\}}"
}
clusters="$(list_all msp mlflow v1alpha1 cluster | jq -c '[.[].metadata.id]')"
buckets="$(list_all storage bucket | jq -c --argjson ids "${clusters}" '[.[]
  | select(.metadata.name | test("^mlflow-.+-artifacts$"))
  | .metadata.name as $n
  | {id: .metadata.id, name: $n, in_use: any($ids[]; . as $id | $n | contains($id))}]')"

if [[ "${cmd}" == list ]]; then
  [[ "$(jq length <<<"${buckets}")" == 0 ]] && { echo "no MLflow artifact buckets in ${p}"; exit 0; }
  jq -r '.[] | "  \(.id)  \(.name)  \(if .in_use then "in use (its MLflow cluster exists)" else "orphaned (no MLflow cluster with this id)" end)"' <<<"${buckets}"
  exit 0
fi

[[ -n "${bucket}" ]] || { echo "delete needs --bucket <name> (scripts/mlflow-artifacts.sh list)" >&2; exit 2; }
[[ "${bucket}" =~ ^mlflow-.+-artifacts$ ]] || { echo "refusing ${bucket}: not an artifact bucket the MLflow service created (mlflow-<cluster id>-artifacts)" >&2; exit 2; }
[[ "${ttl}" =~ ^([0-9]+h)?([0-9]+m)?([0-9]+s)?$ && -n "${ttl}" ]] || { echo "refusing --ttl ${ttl}: use a delay like 0s, 30m or 24h" >&2; exit 2; }
row="$(jq -c --arg n "${bucket}" '.[] | select(.name == $n)' <<<"${buckets}")"
[[ -n "${row}" ]] || { echo "no bucket ${bucket} in ${p}" >&2; exit 1; }
[[ "$(jq -r .in_use <<<"${row}")" == false ]] || { echo "refusing ${bucket}: its MLflow cluster still exists; destroy the cluster first (runbooks/ml-services.md#teardown)" >&2; exit 1; }
id="$(jq -r .id <<<"${row}")"
if [[ "${CONFIRM:-}" != yes ]]; then
  echo "would delete bucket ${bucket} (${id}) and every object in it, ttl ${ttl}; set CONFIRM=yes after exporting what must be kept" >&2
  exit 1
fi
nip_nebius storage bucket delete --id "${id}" --ttl "${ttl}" >/dev/null
echo "deleted ${bucket} (${id}), ttl ${ttl}$([[ "${ttl}" != 0s ]] && echo ': scheduled; it bills until purged (nebius storage bucket purge --id '"${id}"')')"
