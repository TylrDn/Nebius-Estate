#!/usr/bin/env bash
# R8 — Copy throughput: wait for the staging Job of workloads/data/copy-job and record what it
# moved from Object Storage onto the shared filesystem, and how fast (runbooks/data.md).
# Filesystem write and read throughput itself is 03-storage.sh (fio, DATA_MIN_MIBPS); this step measures the bucket ->
# filesystem path a training run depends on. Passes when the Job completed, rclone reported no
# errors, and it copied something (a re-run that skips everything has no throughput: point TARGET
# at a fresh path, or delete the target directory, to measure again).
# Inputs: DATA_NAMESPACE (default training), DATA_JOB (default stage-dataset),
#         DATA_WAIT_S (default 3600), COPY_MIN_MIBPS (default 0: record only, no bar; rclone's rate
#         depends on object sizes and count, and the docs publish no figure for this path).
# shellcheck source=tests/validate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; need kubectl jq
NS="${DATA_NAMESPACE:-training}"; JOB="${DATA_JOB:-stage-dataset}"
WAIT_S="${DATA_WAIT_S:-3600}"; MIN_MIBPS="${COPY_MIN_MIBPS:-0}"

kubectl -n "$NS" get job "$JOB" >/dev/null 2>&1 || {
  echo "no Job ${NS}/${JOB}: apply workloads/data/copy-job first (runbooks/data.md)" >&2; exit 2; }

# Complete or Failed, whichever comes first.
status="Running"; deadline=$((SECONDS + WAIT_S))
while (( SECONDS < deadline )); do
  status="$(kubectl -n "$NS" get job "$JOB" -o json | jq -r '[.status.conditions[]? | select(.status == "True") | .type] | map(select(. == "Complete" or . == "Failed")) | first // "Running"')"
  [[ "$status" == Complete || "$status" == Failed ]] && break
  sleep 15
done
job="$(kubectl -n "$NS" get job "$JOB" -o json)"
image="$(jq -r '.spec.template.spec.containers[0].image' <<<"$job")"
wall_s="$(jq '(.status.completionTime // empty | fromdateiso8601) - (.status.startTime | fromdateiso8601)' <<<"$job" 2>/dev/null || true)"

# rclone runs with --use-json-log: every stats line carries a "stats" object; the last one is the total.
stats="$(kubectl -n "$NS" logs "job/${JOB}" 2>/dev/null | jq -Rc 'fromjson? | select(type == "object" and has("stats")) | .stats' | tail -1 || true)"
[[ -n "$stats" ]] || stats='{}'
bytes="$(jq '.bytes // 0' <<<"$stats")"
elapsed="$(jq '.elapsedTime // 0' <<<"$stats")"
errors="$(jq '.errors // 0' <<<"$stats")"
mibps="$(jq -n --argjson b "$bytes" --argjson e "$elapsed" 'if $e > 0 then ($b / $e / 1048576 * 10 | floor / 10) else 0 end')"

details="$(jq -n --arg ns "$NS" --arg job "$JOB" --arg st "$status" --arg img "$image" --argjson s "$stats" \
  --argjson mibps "$mibps" --argjson min "$MIN_MIBPS" --arg wall "${wall_s:-}" \
  '{job:"\($ns)/\($job)",status:$st,image:$img,bytes:($s.bytes // 0),files:($s.transfers // 0),checks:($s.checks // 0),
    errors:($s.errors // 0),rclone_elapsed_s:($s.elapsedTime // 0),job_wall_s:($wall|tonumber? // null),
    avg_MiBps:$mibps,min_MiBps:$min,method:"rclone copy bucket prefix -> shared filesystem claim (workloads/data/copy-job); bytes / rclone elapsed time"}')"
if [[ "$status" == Complete && "$errors" == 0 && "$bytes" -gt 0 ]] \
   && awk -v r="$mibps" -v m="$MIN_MIBPS" 'BEGIN{exit !(r+0 >= m+0)}'; then
  record data pass "$details"
else
  record data fail "$details"
fi
