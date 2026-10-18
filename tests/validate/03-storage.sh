#!/usr/bin/env bash
# Step 3 — Storage: the Filestore is mounted (virtiofs) on EVERY node, the RWX
# StorageClass exists, and sequential write and read throughput are measured on the mount (not on a
# boot disk that merely has the directory) with parallel jobs: that is the storage verdict. The
# workload's PVC is reported apart (pvc_check): Bound passes; missing is not applicable (the workload
# overlay creates it, and 04-workload cannot pass without it: seen 2026-10-12 on R1, where fio passed
# and the step failed only because the PVC did not exist yet); Pending, Lost or unreadable fails.
# Inputs: DATA_MIN_MIBPS (default 450; 0 records only): both the aggregate write and the aggregate
#           read rate must reach it. Source: 450 MiB/s is the documented ceiling of ONE Network SSD
#           disk (https://docs.nebius.com/compute/storage/types#disk-types-comparison); the docs give
#           shared filesystems only "up to" figures (per client up to 10 GiB/s write and 15 GiB/s
#           read; each 4 TiB adds up to 1.89 GiB/s write and 3.70 GiB/s read:
#           #filesystem-performance), all above it. A floor, not a target: raise it to a
#           baseline measured on the same platform and size (P6).
#         DATA_FIO_JOBS (default 4 parallel jobs), DATA_FIO_SIZE (default 1G per job).
# shellcheck source=tests/validate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; need kubectl jq
# shellcheck source=tests/validate/lib-fio.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib-fio.sh"
MOUNT="${FILESTORE_MOUNT_PATH:-/mnt/data}"
MIN_MIBPS="${DATA_MIN_MIBPS:-450}"; JOBS="${DATA_FIO_JOBS:-4}"; SIZE="${DATA_FIO_SIZE:-1G}"
[[ "${MIN_MIBPS}" =~ ^[0-9]+$ && "${JOBS}" =~ ^[1-9][0-9]*$ && "${SIZE}" =~ ^[1-9][0-9]*[KMGT]?$ ]] \
  || { echo "DATA_MIN_MIBPS must be a whole number, DATA_FIO_JOBS a positive number, DATA_FIO_SIZE like 1G" >&2; exit 2; }

# 1. Every node must show a virtiofs mount at MOUNT (host /proc/1/mounts via a node debug pod;
#    -i attaches so the output comes back; the finished debug pod is deleted afterwards).
mounts="[]"
for node in $(kubectl get nodes -o jsonpath='{.items[*].metadata.name}'); do
  line="$(kubectl debug "node/${node}" -i -q --image=busybox:1.36.1@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662 --profile=sysadmin -- \
    sh -c "grep ' ${MOUNT} ' /proc/1/mounts" 2>/dev/null | tail -1 || true)"
  kubectl get pods -o name 2>/dev/null | grep "^pod/node-debugger-${node}-" | xargs kubectl delete --ignore-not-found >/dev/null 2>&1 || true
  fstype="$(awk '{print $3}' <<<"${line}")"
  mounts="$(jq --arg n "$node" --arg t "${fstype:-missing}" --arg src "$(awk '{print $1}' <<<"${line}")" \
    '. + [{node:$n,fstype:$t,source:$src}]' <<<"$mounts")"
done
all_mounted="$(jq 'all(.[]; .fstype=="virtiofs")' <<<"$mounts")"

# 2. StorageClass + the workload's PVC (PVC_NS/PVC_NAME; PVC_NAME="" skips the PVC check, e.g. stacks/training).
#    "missing" only when the API answers that it does not exist; a failed read is "unknown".
PVC_NS="${PVC_NS:-inference}"; PVC_NAME="${PVC_NAME-model-cache}"
sc_json="$(kubectl get sc csi-mounted-fs-path-sc -o json 2>/dev/null || echo '{}')"
sc="$(jq -r '.metadata.name // empty' <<<"$sc_json")"
# The chart's default is WaitForFirstConsumer (docs kubernetes/storage/filesystem-over-csi, "Install the CSI driver").
binding="$(jq -r '.volumeBindingMode // "Immediate"' <<<"$sc_json")"
if [[ -z "$PVC_NAME" ]]; then
  pvc_phase=skipped
elif pvc_line="$(kubectl -n "$PVC_NS" get pvc "$PVC_NAME" --ignore-not-found -o jsonpath='{.metadata.name} {.status.phase}' 2>/dev/null)"; then
  if [[ -z "${pvc_line// /}" ]]; then pvc_phase=missing; else pvc_phase="$(awk '{print ($2 == "" ? "unknown" : $2)}' <<<"$pvc_line")"; fi
else
  pvc_phase=unknown
fi
case "$pvc_phase" in
  Bound)   pvc_check='{"status":"pass","reason":"Bound"}' ;;
  skipped) pvc_check='{"status":"skipped","reason":"PVC_NAME is empty"}' ;;
  missing) pvc_check="$(jq -nc --arg p "${PVC_NS}/${PVC_NAME}" '{status:"not-applicable",reason:"PVC \($p) does not exist yet: the workload overlay creates it (workloads/inference/overlays/*, base/pvc.yaml) and the vLLM Deployment mounts it, so 04-workload cannot pass without it; the storage verdict does not depend on it"}')" ;;
  Pending) if [[ "$binding" == WaitForFirstConsumer ]]; then
             pvc_check="$(jq -nc --arg p "${PVC_NS}/${PVC_NAME}" '{status:"not-applicable",reason:"PVC \($p) is Pending: its StorageClass binds on first consumer (WaitForFirstConsumer, docs kubernetes/storage/filesystem-over-csi), so it stays Pending until the vLLM pod uses it; 04-workload proves it binds"}')"
           else
             pvc_check="$(jq -nc --arg p "${PVC_NS}/${PVC_NAME}" --arg b "$binding" '{status:"fail",reason:"PVC \($p) is Pending on a \($b) StorageClass: it was not provisioned (kubectl -n \($p|split("/")[0]) describe pvc \($p|split("/")[1]))"}')"
           fi ;;
  unknown) pvc_check="$(jq -nc --arg p "${PVC_NS}/${PVC_NAME}" '{status:"fail",reason:"PVC \($p) could not be read (kubectl get failed): unknown whether it exists"}')" ;;
  *)       pvc_check="$(jq -nc --arg p "${PVC_NS}/${PVC_NAME}" --arg ph "$pvc_phase" '{status:"fail",reason:"PVC \($p) is \($ph), not Bound (kubectl -n \($p|split("/")[0]) describe pvc \($p|split("/")[1]))"}')" ;;
esac

# 3. Throughput on the mount from a GPU node (only meaningful once 1 is true): one fio run, a
#    write group then (--stonewall) a read group, JOBS parallel jobs each, 1 MiB direct I/O.
fio='{"write_MiBps":0,"read_MiBps":0,"fio_errors":1,"fio_version":null,"numjobs":0}'
if [[ "$all_mounted" == true ]]; then
  kubectl delete pod nip-fio --ignore-not-found >/dev/null 2>&1 || true
  img="xridge/fio:3.13@sha256:4a244dda3f95682895bf6508cfb83841694c45aa1534f407bee83ad6069029bd"
  overrides="$(jq -nc --arg img "$img" --arg mp "$MOUNT" --arg jobs "$JOBS" --arg size "$SIZE" '{spec:{
    nodeSelector:{"nip.nebius.io/gpu":"true"}, tolerations:[{key:"nvidia.com/gpu",operator:"Exists"}],
    containers:[{name:"fio", image:$img, volumeMounts:[{name:"d",mountPath:"/data"}],
      args:["--directory=/data","--bs=1M","--size=\($size)","--numjobs=\($jobs)","--direct=1","--group_reporting",
            "--output-format=json","--unlink=1","--name=seqwrite","--rw=write","--name=seqread","--stonewall","--rw=read"]}],
    volumes:[{name:"d",hostPath:{path:$mp,type:"Directory"}}]}}')"
  kubectl run nip-fio --rm -i --restart=Never --quiet --image="$img" --overrides="$overrides" >"${RESULTS_DIR}/03-storage-fio.json" 2>/dev/null || true
  fio="$(fio_summary "${RESULTS_DIR}/03-storage-fio.json")"
fi

storage_verdict=fail
if [[ "$all_mounted" == true && -n "$sc" ]] \
   && jq -e --argjson min "$MIN_MIBPS" '.fio_errors == 0 and .write_MiBps > 0 and .read_MiBps > 0 and .write_MiBps >= $min and .read_MiBps >= $min' <<<"$fio" >/dev/null; then
  storage_verdict=pass
fi
details="$(jq -n --argjson m "$mounts" --argjson all "$all_mounted" --arg sc "$sc" --arg pvc "$pvc_phase" --arg pvcn "${PVC_NS}/${PVC_NAME:-none}" --arg mp "$MOUNT" \
  --argjson fio "$fio" --argjson min "$MIN_MIBPS" --arg size "$SIZE" --arg verdict "$storage_verdict" --argjson pvcc "$pvc_check" \
  '{storage_verdict:$verdict,mount:$mp,all_nodes_virtiofs:$all,node_mounts:$m,storage_class:$sc,pvc:$pvcn,pvc_phase:$pvc,pvc_check:$pvcc} + $fio + {min_MiBps:$min,
    method:"fio \($fio.fio_version // "?"): \($fio.numjobs) parallel jobs x \($size), 1 MiB sequential write then read, direct=1, group_reporting, on the virtiofs mount from a GPU node; MiB/s = aggregate bw_bytes / 1048576",
    min_source:"floor: one Network SSD disk ceiling (docs compute/storage/types#disk-types-comparison); filesystem figures in the docs are upper bounds"}')"
# The step passes on the storage verdict unless the PVC exists and is broken (or cannot be read).
if [[ "$storage_verdict" == pass ]] && jq -e '.status != "fail"' <<<"$pvc_check" >/dev/null; then
  record 03-storage pass "$details"
else
  record 03-storage fail "$details"
fi
