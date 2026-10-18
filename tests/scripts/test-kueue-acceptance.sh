#!/usr/bin/env bash
# tests/validate/kueue.sh (R16 acceptance, runbooks/team-scheduling.md#validate) drives the two team
# queues: (A) the sample job is admitted with both pods in one GPU cluster; (B) team-vision fills the
# cohort and borrows beyond its nominal share; (C) a team-nlp job reclaims its share by preempting a
# borrower. kubectl is a stub answering with Kueue v1beta2 objects (status fields as in the v0.20.1
# CRDs): no cluster, no GPU.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
export APPLIED="${work}/applied"; mkdir -p "${APPLIED}"
stub kubectl '
cq() { # <name> <nominal gpus> <used> <borrowed>
  echo "{\"metadata\":{\"name\":\"$1\"},\"spec\":{\"cohortName\":\"nip-gpu\",\"resourceGroups\":[{\"coveredResources\":[\"cpu\",\"memory\",\"nvidia.com/gpu\"],\"flavors\":[{\"name\":\"nip-gpu-ib\",\"resources\":[{\"name\":\"cpu\",\"nominalQuota\":112},{\"name\":\"memory\",\"nominalQuota\":\"1400Gi\"},{\"name\":\"nvidia.com/gpu\",\"nominalQuota\":$2}]}]}]},\"status\":{\"conditions\":[{\"type\":\"Active\",\"status\":\"${CQ_ACTIVE:-True}\"}],\"flavorsUsage\":[{\"name\":\"nip-gpu-ib\",\"resources\":[{\"name\":\"nvidia.com/gpu\",\"total\":$3,\"borrowed\":$4}]}]}}"
}
node() { echo "{\"metadata\":{\"name\":\"$1\",\"labels\":{\"topology.nebius.com/gpu-cluster-id\":\"$2\"}},\"status\":{\"allocatable\":{\"nvidia.com/gpu\":\"8\"}}}"; }
wl() { # <job> <conditions json>
  echo "{\"metadata\":{\"name\":\"job-$1-abcde\",\"ownerReferences\":[{\"kind\":\"Job\",\"name\":\"$1\"}]},\"status\":{\"conditions\":$2}}"
}
adm="[{\"type\":\"Admitted\",\"status\":\"True\"}]"
evicted="[{\"type\":\"Admitted\",\"status\":\"False\"},{\"type\":\"Evicted\",\"status\":\"True\",\"reason\":\"Preempted\"},{\"type\":\"Preempted\",\"status\":\"True\",\"reason\":\"InCohortReclamation\"}]"
case "$*" in
  "get clusterqueue nip-team-nlp -o json") cq nip-team-nlp "${NLP_GPUS:-8}" 0 0 ;;
  "get clusterqueue nip-team-vision -o json") cq nip-team-vision "${VISION_GPUS:-8}" "${VISION_USED:-16}" "${VISION_BORROWED:-8}" ;;
  "get nodes -l nip.nebius.io/infiniband=true -o json") echo "{\"items\":[$(node node-a computeg-a),$(node node-b "computeg-${SPLIT:+b}a")]}" ;;
  "apply -k "*|"delete -k "*|"-n team-"*" delete jobs -l nip.nebius.io/drill=kueue-acceptance --ignore-not-found"*|"patch clusterqueue "*) ;;
  "apply -f "*) cp "${3}" "${APPLIED}/$(ls "${APPLIED}" | wc -l | tr -d " ").yaml" ;;
  "-n team-nlp get workloads -o json")
    owner=""; [[ "${RECLAIM:-yes}" == yes ]] && owner=",$(wl nip-drill-owner "${adm}")"
    echo "{\"items\":[$(wl tas-sample "${ADMIT_SAMPLE:-${adm}}")${owner}]}" ;;
  "-n team-nlp get pods -l batch.kubernetes.io/job-name=tas-sample -o json")
    echo "{\"items\":[{\"spec\":{\"nodeName\":\"node-a\"}},{\"spec\":{\"nodeName\":\"node-b\"}}]}" ;;
  "-n team-vision get workloads -o json")
    first="${adm}"; [[ "${RECLAIM:-yes}" == yes ]] && first="${evicted}"
    echo "{\"items\":[$(wl nip-drill-borrow-1 "${first}"),$(wl nip-drill-borrow-2 "${adm}")]}" ;;
  "config current-context") echo mock ;;
  *) exit 1 ;;
esac'
export RESULTS_DIR="${work}/results" KUEUE_WAIT_S=2 KUEUE_POLL_S=0
drill() { set +e; rm -f "${APPLIED}"/*; env "$@" bash "${repo_root}/tests/validate/kueue.sh" >"${work}/out" 2>&1; echo $?; set -e; }
result() { jq -r "$1" "${RESULTS_DIR}/kueue.json"; }

test_name=kueue-admission-borrow-reclaim
rc="$(drill)"
[[ "${rc}" == 0 && "$(result .status)" == pass ]] || { cat "${work}/out" >&2; fail "admission, borrow and reclaim must pass (rc ${rc})"; }
[[ "$(result .details.admission.one_gpu_cluster)" == true && "$(result .details.borrow.borrowed_gpus)" == 8 && "$(result .details.reclaim.preempted)" == 1 ]] \
  || fail "each phase recorded: $(result .details)"
# B fills the cohort (8 + 8 GPUs) with 8-GPU team-vision jobs: two of them; C is one 8-GPU team-nlp job.
vision="$(grep -l 'namespace: team-vision' "${APPLIED}"/*.yaml | wc -l | tr -d ' ')"
[[ "${vision}" == 2 ]] || fail "team-vision submits (8 + 8) / 8 = 2 borrower jobs, got ${vision}"
grep -l 'namespace: team-nlp' "${APPLIED}"/*.yaml | xargs grep -q 'nvidia.com/gpu: 8' || fail "the owner job asks for one share-sized pod"
grep -q 'kueue.x-k8s.io/queue-name: gpu' "${APPLIED}/0.yaml" || fail "drill jobs name the LocalQueue"
grep -q 'nip.nebius.io/drill: kueue-acceptance' "${APPLIED}/0.yaml" || fail "drill jobs carry the drill label"
grep -q 'nvidia/cuda:13.0.1-base-ubuntu24.04@sha256:' "${APPLIED}/0.yaml" || fail "drill jobs use the pinned image"
for ns in team-vision team-nlp; do
  grep -q -- "-n ${ns} delete jobs -l nip.nebius.io/drill=kueue-acceptance" "${LOG}" || fail "the drill jobs in ${ns} are deleted afterwards"
done
ok "sample admitted in one GPU cluster; team-vision borrows 8 GPUs; team-nlp reclaims by preemption"

test_name=kueue-split-placement
rc="$(drill SPLIT=1)"
[[ "${rc}" != 0 && "$(result .details.admission.one_gpu_cluster)" == false ]] || fail "pods in two GPU clusters must fail (rc ${rc})"
ok "pods across two GPU clusters fail the admission check"

test_name=kueue-no-borrow
rc="$(drill VISION_USED=8 VISION_BORROWED=0)"
[[ "${rc}" != 0 && "$(result .details.borrow.ok)" == false ]] || fail "no GPU borrowed must fail (rc ${rc})"
ok "a queue that never borrows fails the borrow check"

test_name=kueue-no-reclaim
rc="$(drill RECLAIM=no)"
[[ "${rc}" != 0 && "$(result .details.reclaim.ok)" == false ]] || fail "no preemption must fail the reclaim check (rc ${rc})"
ok "an owner job that is not admitted by preemption fails the reclaim check"

test_name=kueue-preflight
: > "${LOG}"
rc="$(drill VISION_GPUS=16 NLP_GPUS=16)"
[[ "${rc}" == 2 ]] || fail "a cohort (32 GPUs) larger than the GPU nodes (16) cannot be filled: refuse (rc ${rc})"
grep -q -- '--shares' "${work}/out" || fail "the refusal names --shares"
grep -q 'apply ' "${LOG}" && fail "nothing is submitted on a refusal"
rc="$(drill CQ_ACTIVE=False)"
[[ "${rc}" == 2 ]] || fail "an inactive ClusterQueue is refused (rc ${rc})"
ok "refuses when the cohort exceeds the nodes or a queue is inactive"

test_name=kueue-shares
: > "${LOG}"
rc="$(drill VISION_GPUS=16 NLP_GPUS=16 KUEUE_SHARES=8)"
[[ "${rc}" == 0 ]] || { cat "${work}/out" >&2; fail "--shares 8 lowers both shares for the drill (rc ${rc})"; }
[[ "$(grep -c '^kubectl patch clusterqueue ' "${LOG}")" == 4 ]] || fail "both queues patched to 8 and restored to 16: $(calls)"
grep '^kubectl patch clusterqueue nip-team-vision ' "${LOG}" | tail -1 | grep -q '"value":16' || fail "the original share is restored last"
ok "--shares patches both queues for the drill and restores them"
