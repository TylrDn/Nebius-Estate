#!/usr/bin/env bash
# Second-terminal watch of the bench Job (run 2 steps 3d, 8 and 8b). Read-only.
# Executed: bash run2-watch-bench.sh [inference|nip-bench]   Ctrl-C to stop watching.
# It exports the R1 KUBECONFIG and checks the context first: a fresh shell would otherwise read
# another cluster and report "No resources found".
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
NS="${1:-inference}"
[[ "${NS}" == inference || "${NS}" == nip-bench ]] || die "namespace must be inference or nip-bench"
cd "${REPO}"
live_target || die "no sandbox target (reason above)"
export NEBIUS_PROFILE="${LIVE_PROFILE}"
kube_env readonly
say "context: $(kubectl config current-context); watching ${NS}/job-name=vllm-bench every 15 s"
say "Pending ~2 min with Insufficient cpu/memory: the step script stops it itself (or: kubectl -n ${NS} delete job vllm-bench)"
while true; do
  date -u +%FT%TZ
  kubectl -n "${NS}" get pod -l job-name=vllm-bench -o wide 2>&1 || true
  if [[ "$(kubectl -n "${NS}" get pod -l job-name=vllm-bench -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)" == Pending ]]; then
    kubectl -n "${NS}" describe pod -l job-name=vllm-bench 2>/dev/null | grep -E 'Insufficient|FailedScheduling' | head -3 || true
  fi
  sleep 15
done
