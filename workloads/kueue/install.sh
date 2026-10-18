#!/usr/bin/env bash
# R16: install Kueue at the version pinned in platform/versions.yaml (workloads.kueue), the way the
# Kueue docs install a released version: `kubectl apply --server-side` of the release's
# manifests.yaml, then wait for the controller (Nebius links that guide from
# https://docs.nebius.com/kubernetes/gpu/topology-aware-scheduling#steps). The manifest is
# downloaded first and its sha256 checked against the pin, so a re-published asset is refused.
#
# TopologyAwareScheduling is beta and on by default since Kueue v0.14, so the feature-gate patch
# in the Nebius steps is not needed at the pinned version (README.md).
#
# Usage: workloads/kueue/install.sh [--dry-run]
#   --dry-run   print the pinned version, the URL, the expected sha256 and the commands; no network,
#               no cluster access (part of `make recipes-check`)
# Needs: python3, curl, kubectl with a kubeconfig for the target cluster (`make kubeconfig`), and
#        cluster-admin: Kueue installs CRDs, webhooks and cluster roles.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dry_run=0
for arg in "$@"; do
  case "${arg}" in
    --dry-run) dry_run=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: ${arg} (see --help)" >&2; exit 2 ;;
  esac
done

# version and sha256 from the single source of truth; the reader is stdlib-only (scripts/versions.py).
read -r version sha256 < <(python3 -I - "${repo_root}/scripts" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from versions import load
k = load()["workloads/kueue"]
print(k["version"], k["sha256"])
PY
)
[[ "${version}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "workloads.kueue.version '${version}' is not a release tag" >&2; exit 2; }
[[ "${sha256}" =~ ^[0-9a-f]{64}$ ]] || { echo "workloads.kueue.sha256 is not a sha256" >&2; exit 2; }
url="https://github.com/kubernetes-sigs/kueue/releases/download/${version}/manifests.yaml"

if (( dry_run )); then
  printf 'kueue %s\nmanifest %s\nsha256 %s\n' "${version}" "${url}" "${sha256}"
  printf 'would run: kubectl apply --server-side -f <verified manifest>\n'
  printf 'would run: kubectl -n kueue-system wait deploy/kueue-controller-manager --for=condition=available --timeout=5m\n'
  exit 0
fi

for c in curl kubectl; do command -v "${c}" >/dev/null || { echo "missing: ${c}" >&2; exit 2; }; done
tmp="$(mktemp -d)"; trap 'rm -rf "${tmp}"' EXIT
curl -fsSL --max-time 120 -o "${tmp}/manifests.yaml" "${url}"
got="$( { sha256sum "${tmp}/manifests.yaml" 2>/dev/null || shasum -a 256 "${tmp}/manifests.yaml"; } | cut -d' ' -f1)"
[[ "${got}" == "${sha256}" ]] || { echo "sha256 mismatch for ${url}: got ${got}, pinned ${sha256}" >&2; exit 1; }

echo "context: $(kubectl config current-context)"
kubectl apply --server-side -f "${tmp}/manifests.yaml"
kubectl -n kueue-system wait deploy/kueue-controller-manager --for=condition=available --timeout=5m
kubectl get crd topologies.kueue.x-k8s.io resourceflavors.kueue.x-k8s.io clusterqueues.kueue.x-k8s.io localqueues.kueue.x-k8s.io
