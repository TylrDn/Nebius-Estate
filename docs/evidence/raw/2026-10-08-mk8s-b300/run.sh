#!/usr/bin/env bash
# Usage: invoked by the lab harness, which exports LAB_CHDIR (the assembled Terraform dir) and LAB_STATE (its state file).
# Lab 03: fetch a kubeconfig for the k8s-training cluster into .cache (never ~/.kube/config), run the GPU smoke Job
# (job.yaml: nvidia-smi, bf16 matmul TFLOPS, single-rank NCCL all_reduce) and save the cluster view and the Job log
# to labs/03-k8s-gpu-nccl/results/<UTC timestamp>.md.
# Every step is bounded, so `demo` always reaches `down` while the B300 bills: terraform and nebius run under a
# watchdog (`bounded`), nebius never opens a browser (it fails instead of waiting for an interactive re-auth), the
# kubeconfig's exec plugin (`nebius ... get-token`) gets the same flags, kubectl waits carry --timeout, and every other
# kubectl call --request-timeout.
set -euo pipefail
LAB=03-k8s-gpu-nccl
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
JOB_YAML="$ROOT/labs/$LAB/job.yaml"
JOB=gpu-smoke
RT=--request-timeout=60s   # bounds each short kubectl API call (not the waits: it would cut their watch short)
: "${LAB_CHDIR:?run via the lab harness (LAB_CHDIR is the assembled Terraform dir)}"

# Watchdog: SIGALRM survives exec, so the command is killed after N seconds. Portable (macOS has no timeout(1)).
bounded() { perl -e 'alarm shift; exec @ARGV or die "exec $ARGV[0]: $!\n"' "$@"; }

# output.tf:2-8: kube_cluster = { id, name, endpoints }. Read from Terraform, not by parsing the state file.
ID=$(bounded 120 terraform -chdir="$LAB_CHDIR" output -json kube_cluster \
  | python3 -c 'import json, sys; print(json.load(sys.stdin).get("id") or "")')
[[ -n $ID ]] || { echo "no kube_cluster.id in the Terraform outputs: is the lab up?" >&2; exit 1; }
echo "MK8s cluster: $ID"

# Flags confirmed with `nebius mk8s v1 cluster get-credentials --help` (CLI 0.12.285): --id, --external,
# --kubeconfig <path>, --force (overwrite the context); global --no-browser, --auth-timeout.
mkdir -p "$ROOT/.cache/labs/$LAB"
export KUBECONFIG="$ROOT/.cache/labs/$LAB/kubeconfig"
rm -f "$KUBECONFIG"
bounded 120 nebius mk8s v1 cluster get-credentials --id "$ID" --external --kubeconfig "$KUBECONFIG" --force \
  --no-browser --auth-timeout 90s

# get-credentials cannot set the exec plugin's flags, so add them: kubectl runs `nebius ... get-token` itself and has
# no timeout for exec plugins. Rewritten as JSON (a valid kubeconfig) from kubectl's own local view of the file.
# The view goes through a 0600 file, never argv (argv is visible to every local user in `ps`).
KC_FILE="$ROOT/.cache/labs/$LAB/kubeconfig.view.json"
(umask 077; kubectl config view --raw -o json > "$KC_FILE")
python3 - "$KUBECONFIG" "$KC_FILE" <<'PY'
import json, os, sys
path, view = sys.argv[1], sys.argv[2]
try:
    with open(view) as f:
        cfg = json.load(f)
finally:
    os.remove(view)
patched = 0
for user in cfg.get("users") or []:
    ex = (user.get("user") or {}).get("exec")
    if ex and ex.get("command", "").endswith("nebius"):
        args = ex.setdefault("args", [])
        if "--no-browser" not in args:
            args.append("--no-browser")
        if "--auth-timeout" not in args:
            args += ["--auth-timeout", "90s"]
        patched += 1
if not patched:
    sys.exit("kubeconfig has no nebius exec user to patch")
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
PY

kubectl wait --for=condition=Ready nodes --all --timeout=15m

# The device plugin (driverfull image, helm.tf:36-42) advertises nvidia.com/gpu once it runs on the GPU node.
gpus() { kubectl "$RT" get nodes -o jsonpath='{range .items[*]}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}' \
  | awk '$1 > 0 { n += $1 } END { print n + 0 }'; }
deadline=$((SECONDS + 900))
until (( $(gpus) > 0 )); do
  (( SECONDS < deadline )) || { echo "no node advertises nvidia.com/gpu after 15 min" >&2; kubectl "$RT" get nodes -o wide >&2; exit 1; }
  sleep 15
done

kubectl delete job "$JOB" --ignore-not-found --wait=true --timeout=2m
kubectl "$RT" apply -f "$JOB_YAML"

# Poll rather than wait for condition=complete, which would sit out its whole timeout on a failed Job.
deadline=$((SECONDS + 1800))   # = activeDeadlineSeconds in job.yaml; the image pull dominates
status=""
while :; do
  status=$(kubectl "$RT" get job "$JOB" -o jsonpath='{.status.succeeded}/{.status.failed}' || true)
  [[ $status == 1/* || $status == */1 ]] && break
  if (( SECONDS >= deadline )); then status="timeout"; break; fi
  sleep 15
done
echo "Job $JOB: ${status} (succeeded/failed)"

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
{
  echo "== kubectl get nodes -o wide =="
  kubectl "$RT" get nodes -o wide || true
  echo "== kubectl get pods -l job-name=$JOB -o wide =="
  kubectl "$RT" get pods -l "job-name=$JOB" -o wide || true
  echo "== kubectl logs job/$JOB =="
  kubectl "$RT" logs "job/$JOB" --tail=-1 || true
  if [[ $status != 1/* ]]; then
    echo "== kubectl describe pods -l job-name=$JOB =="
    kubectl "$RT" describe pods -l "job-name=$JOB" || true
  fi
} | tee "$OUT"

DEST="$ROOT/labs/$LAB/results"
mkdir -p "$DEST"
REPORT="$DEST/$(date -u +%Y%m%dT%H%M%SZ).md"
{
  echo "# Lab 03 k8s-gpu-nccl smoke Job, $(date -u +%Y-%m-%dT%H:%MZ)"
  echo
  echo "Cluster $ID, 1 × preemptible gpu-b300-sxm 1gpu-24vcpu-346gb. Job status (succeeded/failed): ${status}."
  echo "Image: $(grep -m1 'image:' "$JOB_YAML" | awk '{print $2}'). Single-rank all_reduce: busbw is meaningless on 1 GPU."
  echo
  echo '```'
  cat "$OUT"
  echo '```'
} > "$REPORT"
echo "report: $REPORT"
[[ $status == 1/* ]]
