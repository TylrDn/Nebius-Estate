#!/usr/bin/env bash
# R16 — Team queues (runbooks/team-scheduling.md#validate), three phases on the two ClusterQueues of
# workloads/kueue (cohort nip-gpu):
#   A admission  the sample job (team-nlp, 2 pods x 8 GPUs, required topology gpu-cluster-id) is
#                admitted and both pods land on nodes with the same topology.nebius.com/gpu-cluster-id;
#   B borrow     team-vision submits share-sized jobs until they fill the whole cohort: its GPU usage
#                passes its nominal share (ClusterQueue status.flavorsUsage[].resources[].borrowed > 0);
#   C reclaim    a team-nlp job of one share-sized pod is admitted by preempting a team-vision workload
#                (reclaimWithinCohort: Any); the evicted workload carries an Evicted (reason Preempted)
#                or a Preempted condition.
# The drill jobs (label nip.nebius.io/drill=kueue-acceptance) are deleted afterwards. They hold GPUs
# on nodes that already exist: approval as for any paid GPU job (runbooks/team-scheduling.md).
# Filling the cohort needs as many free GPUs on the InfiniBand nodes as both nominal shares together;
# --shares N (or KUEUE_SHARES=N) lowers both GPU shares to N for the drill and restores them after.
# Inputs: KUEUE_WAIT_S (default 600 per phase), KUEUE_POLL_S (default 10), KUEUE_JOB_GPUS (default 8,
# one node), KUEUE_HOLD_S (default 900: how long a drill pod keeps its GPUs).
# Status fields: Kueue v1beta2 at the pinned v0.20.1 (ClusterQueue flavorsUsage, Workload conditions).
# shellcheck source=tests/validate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; need kubectl jq
SHARES="${KUEUE_SHARES:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --shares) SHARES="${2:?--shares needs a GPU count}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
WAIT_S="${KUEUE_WAIT_S:-600}"; POLL_S="${KUEUE_POLL_S:-10}"; GPUS="${KUEUE_JOB_GPUS:-8}"; HOLD_S="${KUEUE_HOLD_S:-900}"
[[ -z "$SHARES" || "$SHARES" =~ ^[1-9][0-9]*$ ]] || { echo "--shares must be a positive GPU count" >&2; exit 2; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OWNER=nip-team-nlp; BORROWER=nip-team-vision; DRILL=nip.nebius.io/drill=kueue-acceptance
IMAGE="nvidia/cuda:13.0.1-base-ubuntu24.04@sha256:f8ef28f579ea42a44b415d2c5d46f788e6a9b395c6c83f2929416e1fc192c143"

cqj() { kubectl get clusterqueue "$1" -o json; }
gpu_index() { jq '.spec.resourceGroups[0].flavors[0].resources | map(.name) | index("nvidia.com/gpu")' <<<"$1"; }
nominal() { jq '.spec.resourceGroups[0].flavors[0].resources[] | select(.name == "nvidia.com/gpu") | .nominalQuota' <<<"$1"; }
active() { jq -e 'any(.status.conditions[]?; .type == "Active" and .status == "True")' <<<"$1" >/dev/null; }

# ---- preflight: queues active, and enough GPUs on the InfiniBand nodes to fill the cohort ----
owner_cq="$(cqj "$OWNER")"; borrower_cq="$(cqj "$BORROWER")"
{ active "$owner_cq" && active "$borrower_cq"; } || { echo "ClusterQueues ${OWNER} and ${BORROWER} must be Active (runbooks/team-scheduling.md step 4)" >&2; exit 2; }
owner_orig="$(nominal "$owner_cq")"; borrower_orig="$(nominal "$borrower_cq")"
owner_n="${SHARES:-$owner_orig}"; borrower_n="${SHARES:-$borrower_orig}"
cap="$(kubectl get nodes -l nip.nebius.io/infiniband=true -o json | jq '[.items[].status.allocatable["nvidia.com/gpu"] // "0" | tonumber] | add // 0')"
cohort=$((owner_n + borrower_n))
if (( cohort > cap || cohort % GPUS != 0 || owner_n < GPUS )); then
  echo "cannot drill: the cohort's shares (${OWNER} ${owner_n} + ${BORROWER} ${borrower_n} = ${cohort} GPUs) must fit the ${cap} GPUs on InfiniBand nodes, in ${GPUS}-GPU jobs; lower both shares for the drill with --shares <gpus> (e.g. --shares $((cap / 2 / GPUS * GPUS)))" >&2
  exit 2
fi

restore_shares() { :; }
if [[ -n "$SHARES" ]]; then
  share_patch() { # <queue> <queue json> <value>
    kubectl patch clusterqueue "$1" --type=json -p "[{\"op\":\"replace\",\"path\":\"/spec/resourceGroups/0/flavors/0/resources/$(gpu_index "$2")/nominalQuota\",\"value\":$3}]" >/dev/null
  }
  restore_shares() { share_patch "$OWNER" "$owner_cq" "$owner_orig"; share_patch "$BORROWER" "$borrower_cq" "$borrower_orig"; }
  share_patch "$OWNER" "$owner_cq" "$SHARES"; share_patch "$BORROWER" "$borrower_cq" "$SHARES"
fi
tmp="$(mktemp -d)"
cleanup() {
  kubectl delete -k "${here}/workloads/kueue/sample-job" --ignore-not-found >/dev/null 2>&1 || true
  for ns in team-vision team-nlp; do kubectl -n "$ns" delete jobs -l "$DRILL" --ignore-not-found >/dev/null 2>&1 || true; done
  restore_shares || echo "could not restore the ClusterQueue GPU shares (${owner_orig}, ${borrower_orig}): kubectl apply --server-side -k workloads/kueue/overlays/<stage>" >&2
  rm -rf "$tmp"
}
trap cleanup EXIT

# workloads <namespace>: [{job, admitted, preempted}] from the Workloads Kueue made for the jobs
workloads() {
  kubectl -n "$1" get workloads -o json | jq -c '[.items[] | {
    job: ([.metadata.ownerReferences[]? | select(.kind == "Job") | .name] | first),
    admitted: any(.status.conditions[]?; .type == "Admitted" and .status == "True"),
    preempted: any(.status.conditions[]?; (.type == "Evicted" and .status == "True" and .reason == "Preempted") or (.type == "Preempted" and .status == "True"))}]'
}
# until <seconds> <command...>: poll until the command succeeds; non-zero at the deadline
until_ok() { local end=$((SECONDS + $1)); shift; while ! "$@"; do (( SECONDS >= end )) && return 1; sleep "$POLL_S"; done; }
drill_job() { # <namespace> <name>: one pod holding GPUS GPUs for HOLD_S seconds through the team's LocalQueue
  cat >"$tmp/$2.yaml" <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: $2
  namespace: $1
  labels:
    kueue.x-k8s.io/queue-name: gpu
    nip.nebius.io/drill: kueue-acceptance
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 600
  template:
    metadata:
      labels:
        nip.nebius.io/drill: kueue-acceptance
      annotations:
        kueue.x-k8s.io/podset-preferred-topology: topology.nebius.com/gpu-cluster-id
    spec:
      restartPolicy: Never
      securityContext:
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: hold
          image: ${IMAGE}
          command: ["sleep", "${HOLD_S}"]
          resources:
            requests: { cpu: "1", memory: 2Gi, nvidia.com/gpu: ${GPUS} }
            limits: { memory: 2Gi, nvidia.com/gpu: ${GPUS} }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
EOF
  kubectl apply -f "$tmp/$2.yaml" >/dev/null
}

# ---- A: admission and placement ----
kubectl apply -k "${here}/workloads/kueue/sample-job" >/dev/null
sample_admitted() { workloads team-nlp | jq -e 'any(.[]; .job == "tas-sample" and .admitted)' >/dev/null; }
placed() { [[ "$(kubectl -n team-nlp get pods -l batch.kubernetes.io/job-name=tas-sample -o json | jq '[.items[].spec.nodeName // empty] | length')" == 2 ]]; }
a_admitted=false; until_ok "$WAIT_S" sample_admitted && a_admitted=true
clusters='[]'
if [[ "$a_admitted" == true ]] && until_ok "$WAIT_S" placed; then
  nodes="$(kubectl get nodes -l nip.nebius.io/infiniband=true -o json)"
  clusters="$(kubectl -n team-nlp get pods -l batch.kubernetes.io/job-name=tas-sample -o json | jq -c --argjson n "$nodes" '
    ($n.items | map({key: .metadata.name, value: (.metadata.labels["topology.nebius.com/gpu-cluster-id"] // "none")}) | from_entries) as $c
    | [.items[].spec.nodeName | $c[.] // "none"]')"
fi
admission="$(jq -nc --argjson a "$a_admitted" --argjson c "$clusters" \
  '{admitted:$a, gpu_cluster_ids:$c, one_gpu_cluster:(($c | length) == 2 and ($c | unique | length) == 1 and ($c[0] != "none"))} | .ok = (.admitted and .one_gpu_cluster)')"
kubectl delete -k "${here}/workloads/kueue/sample-job" --ignore-not-found >/dev/null

# ---- B: team-vision fills the cohort and borrows ----
k=$((cohort / GPUS))
for i in $(seq 1 "$k"); do drill_job team-vision "nip-drill-borrow-${i}"; done
borrowed_gpus() { cqj "$BORROWER" | jq '[.status.flavorsUsage[]?.resources[]? | select(.name == "nvidia.com/gpu") | .borrowed // 0] | add // 0'; }
borrowing() { (( $(borrowed_gpus) > 0 )); }
b_ok=false; until_ok "$WAIT_S" borrowing && b_ok=true
borrow="$(jq -nc --argjson ok "$b_ok" --argjson jobs "$k" --argjson b "$(borrowed_gpus)" --argjson n "$borrower_n" \
  '{ok:$ok, jobs:$jobs, gpus_per_job:'"$GPUS"', nominal_gpus:$n, borrowed_gpus:$b}')"

# ---- C: team-nlp reclaims its share ----
c_ok=false; preempted=0
if [[ "$b_ok" == true ]]; then
  drill_job team-nlp nip-drill-owner
  reclaimed() {
    workloads team-nlp | jq -e 'any(.[]; .job == "nip-drill-owner" and .admitted)' >/dev/null \
      && workloads team-vision | jq -e 'any(.[]; .preempted)' >/dev/null
  }
  until_ok "$WAIT_S" reclaimed && c_ok=true
  preempted="$(workloads team-vision | jq '[.[] | select(.preempted)] | length')"
fi
reclaim="$(jq -nc --argjson ok "$c_ok" --argjson p "$preempted" '{ok:$ok, preempted:$p}')"

details="$(jq -n --argjson a "$admission" --argjson b "$borrow" --argjson c "$reclaim" --argjson cap "$cap" \
  --arg shares "${SHARES:-stage overlay}" --argjson on "$owner_n" --argjson bn "$borrower_n" \
  '{admission:$a, borrow:$b, reclaim:$c, infiniband_gpus:$cap, shares:{source:$shares, "nip-team-nlp":$on, "nip-team-vision":$bn},
    method:"A: workloads/kueue/sample-job admitted, pods node gpu-cluster-id equal; B: team-vision share-sized jobs filling the cohort, ClusterQueue flavorsUsage borrowed > 0; C: one team-nlp share-sized job admitted while a team-vision Workload is Evicted/Preempted"}')"
if jq -e '.admission.ok and .borrow.ok and .reclaim.ok' <<<"$details" >/dev/null; then record kueue pass "$details"; else record kueue fail "$details"; fi
