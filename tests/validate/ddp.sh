#!/usr/bin/env bash
# R3 workload — DDP: run workloads/training/ddp (PyTorchJob ddp-sanity), wait, and record the
# rank-0 summary train.py prints (samples/s, median step time, world size, versions) as
# results/ddp.json. Run after tests/validate/run-training.sh passes; its GPUs are R3's nodes.
#   DDP_MIN_SAMPLES_PER_S  pass bar (default none: the docs give no DDP figure; set it from the
#                          first recorded run on the same platform, node count and BATCH/HIDDEN)
#   DDP_POLL_TRIES x DDP_POLL_INTERVAL  wait (default 90 x 10 s)
# Passes when the job Succeeded, printed its summary, and samples/s meets the bar when one is set.
export STEP=ddp
# shellcheck source=tests/validate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; need kubectl jq
# shellcheck source=tests/validate/lib-ddp.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib-ddp.sh"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIN="${DDP_MIN_SAMPLES_PER_S:-}"

kubectl -n training delete pytorchjob ddp-sanity --ignore-not-found >/dev/null
kubectl apply -k "${here}/../../workloads/training/ddp" >/dev/null
phase=Pending
for _ in $(seq 1 "${DDP_POLL_TRIES:-90}"); do
  phase="$(kubectl -n training get pytorchjob ddp-sanity -o json | jq -r '[.status.conditions[]?|select(.status=="True")|.type]|last // "Pending"')"
  [[ "$phase" == Succeeded || "$phase" == Failed ]] && break
  sleep "${DDP_POLL_INTERVAL:-10}"
done
log="$(mktemp)"; trap 'rm -f "$log"' EXIT
kubectl -n training logs -l training.kubeflow.org/job-name=ddp-sanity,training.kubeflow.org/replica-type=master --tail=-1 > "$log" 2>/dev/null || true
if [[ "$phase" != Succeeded && "$phase" != Failed ]]; then
  echo "PyTorchJob ddp-sanity still ${phase} after the wait; deleting it so the GPUs are released" >&2
  kubectl -n training delete pytorchjob ddp-sanity --ignore-not-found >/dev/null || true
  phase=TimedOut
fi
details="$(ddp_parse "$log" | jq --arg p "$phase" --arg min "$MIN" '. + {phase:$p,min_samples_per_s:(if $min=="" then null else ($min|tonumber) end),
  method:"workloads/training/ddp/train.py: global batch / median step time after 5 warm-up steps"}')"
ok="$(jq -r '.phase=="Succeeded" and .found and (.samples_per_s // 0) > 0 and (.min_samples_per_s == null or .samples_per_s >= .min_samples_per_s)' <<<"$details")"
if [[ "$ok" == true ]]; then record ddp pass "$details"; else record ddp fail "$details"; fi
