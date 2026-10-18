#!/usr/bin/env bash
# Write a kubeconfig for a live root's cluster from Terraform OUTPUTS (never state) into
# .cache/kubeconfig-<stage>-<stack> and print the export line. Never touches ~/.kube/config.
# Usage: scripts/get-kubeconfig.sh [stage] [stack]   (default: sandbox inference; ADR-0009)
# Needs: terraform initialised for that live root, nebius CLI logged in (NEBIUS_PROFILE honoured), kubectl, jq.
set -euo pipefail
case "${1:-}" in -h|--help) sed -n '2,5p' "$0"; exit 0 ;; esac
stage="${1:-sandbox}"; stack="${2:-inference}"
for c in terraform nebius kubectl jq; do command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 2; }; done
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib-nebius.sh
source "${repo_root}/scripts/lib-nebius.sh"
tf_dir="${repo_root}/terraform/live/${stage}/${stack}"
[[ -f "${tf_dir}/main.tf" ]] || { echo "no live root terraform/live/${stage}/${stack} (stages: sandbox|staging|prod; stacks with a cluster: inference|training)" >&2; exit 2; }
cluster_id="$(terraform -chdir="${tf_dir}" output -raw cluster_id 2>/dev/null)" || {
  echo "no cluster_id output in terraform/live/${stage}/${stack}: run 'make init STAGE=${stage} STACK=${stack}' (and apply) first; network and data stacks have no cluster" >&2
  exit 2
}
mkdir -p "${repo_root}/.cache"; out="${repo_root}/.cache/kubeconfig-${stage}-${stack}"

# https://docs.nebius.com/kubernetes/connect — --external needs a public endpoint;
# --internal writes the private one and kubectl must then run on a VM in the cluster's subnet.
mode="$(nip_endpoint_flag "${cluster_id}")"
# get-credentials merges into an existing file, so a rebuilt cluster would leave the old one's entry
# behind; start from an empty file so the kubeconfig names only the current cluster.
rm -f "${out}"
nip_nebius mk8s cluster get-credentials --id "${cluster_id}" "${mode}" --kubeconfig "${out}" --force \
  --no-browser --auth-timeout 90s >/dev/null

# kubectl runs the exec plugin (`nebius mk8s cluster get-token`) with no timeout of its own: an
# expired login would wait for a browser forever. Add the same flags (and the profile) to the exec args.
tmp="$(mktemp)"
KUBECONFIG="${out}" kubectl config view --raw -o json \
  | jq --arg p "${NEBIUS_PROFILE:-}" '(.users[].user.exec.args // []) |= ((if index("--no-browser") then . else . + ["--no-browser","--auth-timeout","90s"] end)
      | if $p != "" and (index("--profile") | not) then . + ["--profile",$p] else . end)' > "${tmp}"
mv "${tmp}" "${out}"; chmod 600 "${out}"
echo "export KUBECONFIG=${out}"
KUBECONFIG="${out}" kubectl --request-timeout=30s get nodes -o wide
