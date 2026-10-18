#!/usr/bin/env bash
# R12 — Clients: run workloads/ml-services/check-job (registry push and pull, an MLflow run logged and
# read back, psql `select 1`), then pull the pushed image by digest in a pod that has no pull secret,
# on a cluster whose node groups run as stacks/ml-services' node_service_account_id
# (runbooks/ml-services.md#validate). Passes when every check that ran passed; a service whose host
# is empty is skipped. Writes results/ml-services.json.
# Inputs (outputs of terraform/live/<stage>/ml-services):
#   REGISTRY_URL (registry_url; required), MLFLOW_HOST (mlflow.private_tracking; empty = skip),
#   PG_HOST (postgresql.private_read_write; empty = skip), MLFLOW_USER (mlflow.admin_username, default
#   admin), PG_DB (default ml), PG_USER (default ml_owner), ML_NAMESPACE (default ml-services),
#   ML_CHECK_WAIT_S (default 900), SOURCE_IMAGE (default the pinned busybox), PG_CA_URL (default the
#   docs' CA certificate URL).
# Secret first (never committed; the registry token is `nebius iam get-access-token` or a static key):
#   kubectl -n ml-services create secret generic ml-services-check --from-literal=REGISTRY_TOKEN=... \
#     --from-literal=MLFLOW_TRACKING_PASSWORD=... --from-literal=PGPASSWORD=...
# shellcheck source=tests/validate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; need kubectl jq
NS="${ML_NAMESPACE:-ml-services}"; JOB=ml-services-check; POD=ml-services-pull-check
WAIT_S="${ML_CHECK_WAIT_S:-900}"
SOURCE_IMAGE="${SOURCE_IMAGE:-busybox:1.36.1@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662}"
PG_CA_URL="${PG_CA_URL:-https://storage.eu-north1.nebius.cloud/msp-certs/ca.pem}" # postgresql/databases/connect
[[ -n "${REGISTRY_URL:-}" ]] || { echo "set REGISTRY_URL (output registry_url of the ml-services root)" >&2; exit 2; }
kdir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../workloads/ml-services/check-job" && pwd)"

kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$NS" get secret "$JOB" -o name >/dev/null 2>&1 || {
  echo "no Secret ${NS}/${JOB}: create it with REGISTRY_TOKEN, MLFLOW_TRACKING_PASSWORD, PGPASSWORD first (header of this script)" >&2; exit 2; }
run_id="$(date -u +%Y%m%d%H%M%S)"
kubectl -n "$NS" create configmap "$JOB" --from-literal=REGISTRY_URL="${REGISTRY_URL}" --from-literal=SOURCE_IMAGE="${SOURCE_IMAGE}" \
  --from-literal=RUN_ID="${run_id}" --from-literal=MLFLOW_HOST="${MLFLOW_HOST:-}" --from-literal=MLFLOW_TRACKING_USERNAME="${MLFLOW_USER:-admin}" \
  --from-literal=MLFLOW_EXPERIMENT=nip-check --from-literal=PG_HOST="${PG_HOST:-}" --from-literal=PG_DB="${PG_DB:-ml}" \
  --from-literal=PG_USER="${PG_USER:-ml_owner}" --from-literal=PG_CA_URL="${PG_CA_URL}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$NS" delete job "$JOB" --ignore-not-found >/dev/null # a Job's template is immutable
kubectl apply -k "$kdir" >/dev/null

# Complete or Failed, whichever comes first.
status=Running; deadline=$((SECONDS + WAIT_S))
while (( SECONDS < deadline )); do
  status="$(kubectl -n "$NS" get job "$JOB" -o json | jq -r '[.status.conditions[]? | select(.status == "True") | .type] | map(select(. == "Complete" or . == "Failed")) | first // "Running"')"
  [[ "$status" == Complete || "$status" == Failed ]] && break
  sleep 10
done
# Each container's last NIP-CHECK line; a container that printed none failed before its check ran.
result_of() {
  kubectl -n "$NS" logs "job/${JOB}" -c "$1" 2>/dev/null | sed -n 's/^NIP-CHECK //p' | tail -1 | jq -c . 2>/dev/null \
    | grep . || jq -nc --arg c "$1" '{check:$c,ok:false,error:"no NIP-CHECK line in the container log"}'
}
reg="$(result_of registry)"; mlf="$(result_of mlflow)"; pg="$(result_of postgresql)"

# A node pulls the pushed digest with no pull secret: neither on the pod nor on its ServiceAccount.
sa_secrets="$(kubectl -n "$NS" get serviceaccount default -o json | jq '.imagePullSecrets // [] | length')"
pull='{"ok":false,"reason":"nothing pushed"}'
digest="$(jq -r '.pushed_digest // empty' <<<"$reg")"
if [[ -n "$digest" ]]; then
  ref="${REGISTRY_URL}/nip-check@${digest}"
  kubectl -n "$NS" delete pod "$POD" --ignore-not-found >/dev/null
  kubectl -n "$NS" run "$POD" --restart=Never --image="$ref" --image-pull-policy=Always \
    --overrides='{"spec":{"tolerations":[{"key":"nvidia.com/gpu","operator":"Exists","effect":"NoSchedule"}],"securityContext":{"runAsNonRoot":true,"runAsUser":65532,"seccompProfile":{"type":"RuntimeDefault"}}}}' \
    --command -- true >/dev/null
  pull='{"ok":false,"reason":"timeout"}'; deadline=$((SECONDS + 300))
  while (( SECONDS < deadline )); do
    pod="$(kubectl -n "$NS" get pod "$POD" -o json)"
    phase="$(jq -r '.status.phase // "Pending"' <<<"$pod")"
    reason="$(jq -r '[.status.containerStatuses[]?.state.waiting.reason // empty] | first // empty' <<<"$pod")"
    if [[ "$phase" == Succeeded ]]; then
      pull="$(jq -c --arg r "$ref" '{ok:true,image:$r,node:.spec.nodeName}' <<<"$pod")"; break
    elif [[ "$phase" == Failed || "$reason" == ErrImagePull || "$reason" == ImagePullBackOff ]]; then
      pull="$(jq -c --arg r "$ref" --arg why "${reason:-$phase}" '{ok:false,image:$r,node:.spec.nodeName,reason:$why,
        message:([.status.containerStatuses[]?.state.waiting.message // empty] | first // null)}' <<<"$pod")"; break
    fi
    sleep 5
  done
  kubectl -n "$NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null
fi
pull="$(jq -c --argjson n "$sa_secrets" '. + {service_account_pull_secrets:$n}' <<<"$pull")"

details="$(jq -n --arg job "${NS}/${JOB}" --arg st "$status" --argjson reg "$reg" --argjson mlf "$mlf" --argjson pg "$pg" --argjson pull "$pull" \
  '{job:$job,status:$st,registry:$reg,mlflow:$mlf,postgresql:$pg,node_pull:$pull,
    method:"workloads/ml-services/check-job (crane push/pull as iam, mlflow log+get_run, psql select 1 sslmode=verify-full); then a pod pulls the pushed digest with imagePullPolicy Always and no pull secret"}')"
if jq -e '([.registry, .mlflow, .postgresql] | all(.skipped == true or .ok == true)) and .registry.ok == true
          and .node_pull.ok == true and .node_pull.service_account_pull_secrets == 0' <<<"$details" >/dev/null; then
  record ml-services pass "$details"
else
  record ml-services fail "$details"
fi
