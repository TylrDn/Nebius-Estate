#!/usr/bin/env bash
# Wait until the Network Operator's NicClusterPolicy reports state-OFED ready, which the
# docs require before installing the GPU Operator (https://docs.nebius.com/kubernetes/gpu/set-up).
# Called by terraform_data.ofed_ready in stacks/training when enable_gpu_operator = true.
# Usage: scripts/wait-for-ofed.sh <mk8s-cluster-id> [timeout-seconds]
# The API endpoint is chosen as in get-kubeconfig.sh (public if the cluster has one, else private,
# which needs a runner in the cluster's subnet); NEBIUS_PROFILE selects the CLI profile.
# Credentials: the local-exec inherits Terraform's environment, so TF_VAR_iam_token (a user login
# locally, the stage service account in CI) is there. With no NEBIUS_IAM_TOKEN set, it is passed
# to the CLI as NEBIUS_IAM_TOKEN. The CLI still refuses to run without a config file (observed with
# CLI 0.12.285: "missing configuration" even with NEBIUS_IAM_TOKEN set; with a config it prints
# "token from NEBIUS_IAM_TOKEN env is used"), and CI keeps no CLI profile on either credential path
# (NIP_CI=1 / NIP_CI_FEDERATED=1), so there the script makes a throwaway config whose profile reads
# the token from a 0600 file, and deletes both on exit.
set -euo pipefail
if [[ -z "${NEBIUS_IAM_TOKEN:-}" && -n "${TF_VAR_iam_token:-}" ]]; then
  export NEBIUS_IAM_TOKEN="${TF_VAR_iam_token}"
fi
cluster_id="${1:?usage: wait-for-ofed.sh <mk8s-cluster-id> [timeout-seconds]}"; timeout="${2:-1800}"
for c in nebius kubectl jq; do command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 2; }; done
# shellcheck source=scripts/lib-nebius.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib-nebius.sh"
kubeconfig="$(mktemp)"; cli_dir="$(mktemp -d)"; trap 'rm -rf "$kubeconfig" "$cli_dir"' EXIT
if [[ "${NIP_CI:-}" == 1 || "${NIP_CI_FEDERATED:-}" == 1 ]]; then
  [[ -n "${NEBIUS_IAM_TOKEN:-}" ]] || { echo "CI run (NIP_CI=1) but neither NEBIUS_IAM_TOKEN nor TF_VAR_iam_token is set" >&2; exit 2; }
  (umask 077; printf '%s' "${NEBIUS_IAM_TOKEN}" > "${cli_dir}/token")
  nebius --config "${cli_dir}/config.yaml" profile create nip-ofed --endpoint api.nebius.cloud \
    --token-file "${cli_dir}/token" --skip-auth >/dev/null
  export NIP_NEBIUS_CONFIG="${cli_dir}/config.yaml" NEBIUS_PROFILE=nip-ofed
fi
mode="$(nip_endpoint_flag "${cluster_id}")"
nip_nebius mk8s cluster get-credentials --id "${cluster_id}" "${mode}" --kubeconfig "${kubeconfig}" --force \
  --no-browser --auth-timeout 90s >/dev/null
deadline=$((SECONDS + timeout))
while :; do
  state="$(kubectl --kubeconfig "${kubeconfig}" --request-timeout=30s get nicclusterpolicy -o json 2>/dev/null \
    | jq -r '[.items[].status.appliedStates[]? | select(.name=="state-OFED") | .state] | first // "absent"' || echo unreachable)"
  echo "state-OFED: ${state}"
  [[ "${state}" == "ready" ]] && exit 0
  if (( SECONDS >= deadline )); then
    echo "state-OFED is '${state}' after ${timeout}s. Inspect the OFED driver pods (kubectl -n network-operator get pods) before installing the GPU Operator; 'unreachable' means the API endpoint is not reachable from here" >&2
    exit 1
  fi
  sleep 20
done
