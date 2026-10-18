#!/usr/bin/env bash
# Step 3 (training env) — Interconnect: run an NCCL MPIJob overlay, wait, and record the
# result. Pass rules by overlay (P4, P6):
#   lab-1gpu          exit 0 + "Out of bounds values : 0 OK" + NCCL version (plumbing only;
#                     busbw on one rank is 0 by definition and is not recorded)
#   single-node-8gpu  the same, plus the avg bus bandwidth is recorded (NVLink, no bar)
#   multi-node-*      the same, plus: NCCL transport is InfiniBand (NET/IB ... /IB, not /RoCE
#                     and not NET/Socket), every worker sits on a node of the same GPU cluster,
#                     and avg bus bandwidth >= NCCL_MIN_BUSBW GB/s (default 300, the docs' bar:
#                     "higher than 300 GB/sec, the connection is stable"); set NCCL_MIN_BUSBW to a
#                     client's bar or a baseline measured on the same platform (docs/rescoping.md)
# Usage: tests/validate/03-nccl.sh <overlay>   (lab-1gpu | single-node-8gpu | multi-node-2x8 | multi-node-2x8-b200)
overlay="${1:-lab-1gpu}"
export STEP="03-nccl-${overlay}"
# shellcheck source=tests/validate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; need kubectl jq
# shellcheck source=tests/validate/lib-nccl.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib-nccl.sh"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="${here}/../../workloads/training/nccl/overlays/${overlay}"
[[ -d "$dir" ]] || { echo "unknown overlay: $overlay" >&2; exit 2; }
# NCCL_PLATFORM (e.g. gpu-h100-sxm) looks the bar up in nccl-bars.tsv and records the docs' figures
# for that platform; NCCL_MIN_BUSBW, when set, wins. Without either, the docs' general bar (300).
platform_bar="$(nccl_bar "${NCCL_PLATFORM:-unset}")"
MIN_BUSBW="${NCCL_MIN_BUSBW:-$(jq -r '.min_busbw_GBps // 300' <<<"$platform_bar")}"
# Which rule set MIN_BUSBW, recorded so an unlisted platform's null row never looks like its bar.
if [[ -n "${NCCL_MIN_BUSBW:-}" ]]; then bar_source="NCCL_MIN_BUSBW (set by the caller)"
elif [[ -n "${NCCL_PLATFORM:-}" && "$(jq -r '.min_busbw_GBps // empty' <<<"$platform_bar")" != "" ]]; then
  bar_source="tests/validate/nccl-bars.tsv row ${NCCL_PLATFORM}"
elif [[ -n "${NCCL_PLATFORM:-}" ]]; then
  bar_source="general docs bar (300 GB/s, docs.nebius.com/kubernetes/gpu/nccl-test): ${NCCL_PLATFORM} is not in tests/validate/nccl-bars.tsv"
else bar_source="general docs bar (300 GB/s, docs.nebius.com/kubernetes/gpu/nccl-test): NCCL_PLATFORM unset"; fi
# Checked before the MPIJob is applied: a run whose bar cannot be compared is GPU time for nothing.
if ! [[ "$MIN_BUSBW" =~ ^[0-9]+(\.[0-9]+)?$ ]] || ! awk -v m="$MIN_BUSBW" 'BEGIN{exit !(m > 0)}'; then
  echo "NCCL_MIN_BUSBW must be a positive number of GB/s (got '${MIN_BUSBW}')" >&2; exit 2
fi

kubectl delete mpijob nccl-test -n nccl-test --ignore-not-found >/dev/null
kubectl apply -k "$dir" >/dev/null
# Spec facts are read before the wait so a timed-out (deleted) job still yields evidence.
spec="$(kubectl -n nccl-test get mpijob nccl-test -o json)"
image="$(jq -r '.spec.mpiReplicaSpecs.Worker.template.spec.containers[0].image' <<<"$spec")"
workers="$(jq '.spec.mpiReplicaSpecs.Worker.replicas' <<<"$spec")"
slots="$(jq '.spec.slotsPerWorker' <<<"$spec")"
flags="$(jq -r '.spec.mpiReplicaSpecs.Launcher.template.spec.containers[0].args[0]' <<<"$spec" | tr -s ' \n' ' ')"

# Succeeded or Failed, whichever comes first. The MPIJob's activeDeadlineSeconds matches
# this 30-minute wait so a hung run is killed server-side too.
phase="Pending"; worker_nodes=""
for _ in $(seq 1 180); do
  phase="$(kubectl -n nccl-test get mpijob nccl-test -o json | jq -r '[.status.conditions[]?|select(.status=="True")|.type]|last // "Pending"')"
  # cleanPodPolicy: Running deletes the workers once the job finishes, so their nodes are
  # captured while the pods exist, not after Succeeded.
  if [[ -z "$worker_nodes" ]]; then
    worker_nodes="$(kubectl -n nccl-test get pod -l training.kubeflow.org/job-name=nccl-test,training.kubeflow.org/replica-type=worker -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' 2>/dev/null | grep -v '^$' || true)"
  fi
  [[ "$phase" == "Succeeded" || "$phase" == "Failed" ]] && break
  sleep 10
done
# Training Operator labels the launcher pod replica-type=launcher (job-role is "master").
launcher="$(kubectl -n nccl-test get pod -l training.kubeflow.org/job-name=nccl-test,training.kubeflow.org/replica-type=launcher -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
log="$(kubectl -n nccl-test logs "$launcher" 2>/dev/null || true)"
# Which GPU cluster each worker's node belongs to (the same id on every node = one fabric).
cluster_ids="$(printf '%s\n' "$worker_nodes" | grep -v '^$' \
  | xargs -r -n1 kubectl get node -o jsonpath='{.metadata.labels.topology\.nebius\.com/gpu-cluster-id}{"\n"}' 2>/dev/null | sort -u || true)"
if [[ "$phase" != "Succeeded" && "$phase" != "Failed" ]]; then
  echo "MPIJob nccl-test still ${phase} after the wait; deleting it so the GPUs are released" >&2
  kubectl -n nccl-test delete mpijob nccl-test --ignore-not-found >/dev/null || true
  phase="TimedOut"
fi

logfile="$(mktemp)"; printf '%s\n' "$log" > "$logfile"
parsed="$(nccl_parse "$logfile")"; rm -f "$logfile"
busbw="$(jq -r '.avg_bus_bandwidth_GBps // empty' <<<"$parsed")"
nccl_ver="$(jq -r '.nccl_version' <<<"$parsed")"
oob_ok="$(jq -r '.out_of_bounds_ok' <<<"$parsed")"
transport="$(jq -r '.transport' <<<"$parsed")"
table="$(jq -c '.table' <<<"$parsed")"
same_cluster=false; [[ "$(wc -l <<<"$cluster_ids")" -eq 1 && -n "$cluster_ids" ]] && same_cluster=true

bw_json=null; [[ "$overlay" != lab-1gpu && -n "${busbw:-}" ]] && bw_json="$busbw"
details="$(jq -n --arg o "$overlay" --arg p "$phase" --argjson bw "$bw_json" --arg t "$transport" --arg v "${nccl_ver:-}" \
  --argjson oob "$oob_ok" --arg img "$image" --arg flags "$flags" --argjson workers "$workers" --argjson slots "$slots" \
  --argjson min "$MIN_BUSBW" --argjson pbar "$(if [[ -n "${NCCL_PLATFORM:-}" ]]; then echo "$platform_bar"; else echo null; fi)" --arg bsrc "$bar_source" --arg clusters "$cluster_ids" --argjson same "$same_cluster" --argjson table "$table" \
  '{overlay:$o,phase:$p,workers:$workers,gpus_per_worker:$slots,image:$img,nccl_version:$v,mpirun:$flags,
    out_of_bounds_ok:$oob,transport:$t,gpu_cluster_ids:($clusters|split("\n")|map(select(.!=""))),all_workers_same_gpu_cluster:$same,
    avg_bus_bandwidth_GBps:$bw,min_bus_bandwidth_GBps:(if ($o|startswith("multi-node")) then $min else null end),platform_bar:$pbar,bar_source:(if ($o|startswith("multi-node")) then $bsrc else null end),table:$table}')"
ok=1
[[ "$phase" == "Succeeded" && "$oob_ok" == true && -n "${nccl_ver:-}" ]] || ok=0
if [[ "$overlay" == multi-node* ]]; then
  # A multi-node run that is not on InfiniBand, spans fabrics, or is slow is a platform failure, not a result (P4).
  [[ "$transport" == ib && "$same_cluster" == true ]] || ok=0
  [[ -n "${busbw:-}" ]] && awk -v b="$busbw" -v m="$MIN_BUSBW" 'BEGIN{exit !(b+0 >= m+0)}' || ok=0
fi
if [[ $ok == 1 ]]; then record "$STEP" pass "$details"; else record "$STEP" fail "$details"; fi
