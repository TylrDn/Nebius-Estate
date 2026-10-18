#!/usr/bin/env bash
# Render the R1 vLLM workload for a client: an overlay (shape) plus the model and engine args as
# inputs, merged into the overlay's hashed ConfigMap. Prints manifests; apply them yourself:
#   MODEL=<org/name> MODEL_REVISION=<commit> workloads/inference/render.sh | kubectl apply -f -
# Inputs (unset = the overlay's own value, so no inputs renders the overlay unchanged):
#   OVERLAY                 overlays/<name> (default qwen2.5-1.5b; qwen2.5-7b, qwen2.5-7b-prod)
#   MODEL                   Hugging Face repo id; needs MODEL_REVISION (every model is pinned)
#   MODEL_REVISION          the commit the weights are pinned to
#   MAX_MODEL_LEN           context length in tokens (integer)
#   GPU_MEMORY_UTILIZATION  vLLM's fraction of GPU memory, 0 < x <= 1
# What to change per client and what it costs: docs/rescoping.md.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "render.sh: $*" >&2; exit 2; }
overlay="${OVERLAY:-qwen2.5-1.5b}"
[[ "${overlay}" =~ ^[A-Za-z0-9._-]+$ && "${overlay}" != .* ]] || die "OVERLAY must be a directory name under overlays/ (got '${overlay}')"
[[ -f "${here}/overlays/${overlay}/kustomization.yaml" ]] || die "unknown overlay '${overlay}' (have: $(cd "${here}/overlays" && printf '%s ' */ | tr -d /))"
if [[ -n "${MODEL:-}" ]]; then
  [[ "${MODEL}" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "MODEL must be a Hugging Face repo id <org>/<name> (got '${MODEL}')"
  [[ -n "${MODEL_REVISION:-}" ]] || die "MODEL=${MODEL} needs MODEL_REVISION (the commit to pin the weights to)"
fi
[[ -z "${MODEL_REVISION:-}" || "${MODEL_REVISION}" =~ ^[A-Za-z0-9._-]+$ ]] || die "MODEL_REVISION must be a commit or tag (got '${MODEL_REVISION}')"
[[ -z "${MAX_MODEL_LEN:-}" || "${MAX_MODEL_LEN}" =~ ^[1-9][0-9]*$ ]] || die "MAX_MODEL_LEN must be a positive integer (got '${MAX_MODEL_LEN}')"
if [[ -n "${GPU_MEMORY_UTILIZATION:-}" ]]; then
  if ! [[ "${GPU_MEMORY_UTILIZATION}" =~ ^(0?\.[0-9]+|1(\.0+)?)$ ]] || ! awk -v u="${GPU_MEMORY_UTILIZATION}" 'BEGIN{exit !(u > 0 && u <= 1)}'; then
    die "GPU_MEMORY_UTILIZATION must be a fraction, 0 < x <= 1 (got '${GPU_MEMORY_UTILIZATION}')"
  fi
fi

literals=()
for k in MODEL MODEL_REVISION MAX_MODEL_LEN GPU_MEMORY_UTILIZATION; do
  [[ -n "${!k:-}" ]] && literals+=("${k}=${!k}")
done
if [[ ${#literals[@]} -eq 0 ]]; then kubectl kustomize "${here}/overlays/${overlay}"; exit; fi

# A throwaway overlay on top of the chosen one: behavior merge keeps the overlay's other keys and
# re-hashes the ConfigMap, so a model change is a new ReplicaSet and `rollout undo` still works.
# kustomize only takes a relative path to another kustomization.
tmp="$(mktemp -d)"; trap 'rm -rf "${tmp}"' EXIT
rel="$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' \
  "$(cd "${here}/overlays/${overlay}" && pwd -P)" "$(cd "${tmp}" && pwd -P)")"
{
  echo "apiVersion: kustomize.config.k8s.io/v1beta1"
  echo "kind: Kustomization"
  echo "resources:"
  echo "  - ${rel}"
  echo "configMapGenerator:"
  echo "  - name: vllm-config"
  echo "    namespace: inference"
  echo "    behavior: merge"
  echo "    literals:"
  for l in "${literals[@]}"; do echo "      - \"${l}\""; done
} > "${tmp}/kustomization.yaml"
kubectl kustomize "${tmp}"
