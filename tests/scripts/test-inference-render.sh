#!/usr/bin/env bash
# workloads/inference/render.sh: the R1 model and engine args are inputs. With none set it renders
# exactly the default overlay; a client model must come with its revision pin; the overlay (shape)
# is selectable; bad values are refused before anything is rendered. Real `kubectl kustomize`, offline.
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
command -v kubectl >/dev/null || fail "kubectl (kustomize) is needed; run in the toolbox (make ci-docker)"
render="${repo_root}/workloads/inference/render.sh"
ov="${repo_root}/workloads/inference/overlays"
unset MODEL MODEL_REVISION MAX_MODEL_LEN GPU_MEMORY_UTILIZATION OVERLAY
# kustomize output is plain, sorted YAML; the toolbox has no yq, so documents are picked with awk.
doc() { awk -v k="kind: $1" 'BEGIN{RS="\n---\n"} $0 ~ "(^|\n)" k "(\n|$)"' <<<"$2"; }
cm_of() { doc ConfigMap "$2" | awk -v k="$1" '$1==k":"{v=$2; gsub(/"/,"",v); print v}'; }
cm_name() { doc ConfigMap "$1" | grep -oE 'name: vllm-config-[a-z0-9]+' | head -1; }
refused() { # <expected text> <env...>: exit 2, message on stderr, nothing on stdout
  local want="$1" out rc; shift
  set +e; out="$(env "$@" "${render}" 2>"${work}/err")"; rc=$?; set -e
  [[ "${rc}" -eq 2 ]] || fail "$* must exit 2 (got ${rc})"
  [[ -z "${out}" ]] || fail "$* must render nothing"
  grep -q -- "${want}" "${work}/err" || fail "$*: expected '${want}' in: $(cat "${work}/err")"
}

test_name=inference-render-defaults
[[ "$("${render}")" == "$(kubectl kustomize "${ov}/qwen2.5-1.5b")" ]] || fail "no inputs must render the qwen2.5-1.5b overlay unchanged"
ok "no inputs = the default overlay, byte for byte"

test_name=inference-render-client-model
out="$(MODEL=acme/model-8b MODEL_REVISION=0123abcd MAX_MODEL_LEN=16384 "${render}")"
[[ "$(cm_of MODEL "${out}")" == acme/model-8b ]] || fail "MODEL not applied"
[[ "$(cm_of MODEL_REVISION "${out}")" == 0123abcd ]] || fail "MODEL_REVISION not applied"
[[ "$(cm_of MAX_MODEL_LEN "${out}")" == 16384 ]] || fail "MAX_MODEL_LEN not applied"
[[ "$(cm_of GPU_MEMORY_UTILIZATION "${out}")" == 0.85 ]] || fail "an input left unset keeps the overlay's value"
cm="$(cm_name "${out}")"
ref="$(doc Deployment "${out}" | grep -oE 'name: vllm-config-[a-z0-9]+' | head -1)"
[[ -n "${cm}" && "${cm}" == "${ref}" ]] || fail "the Deployment must reference the merged, re-hashed ConfigMap (${cm} vs ${ref})"
[[ "$(cm_name "$("${render}")")" != "${cm}" ]] \
  || fail "a model change must change the ConfigMap hash (new ReplicaSet, rollout undo works)"
ok "model, revision and context length applied; ConfigMap re-hashed and referenced"

test_name=inference-render-overlay
out="$(OVERLAY=qwen2.5-7b-prod GPU_MEMORY_UTILIZATION=0.8 "${render}")"
doc Deployment "${out}" | grep -qx '  replicas: 2' || fail "OVERLAY=qwen2.5-7b-prod keeps its prod shape"
[[ "$(cm_of MODEL "${out}")" == Qwen/Qwen2.5-7B-Instruct ]] || fail "the overlay's model is kept when MODEL is unset"
[[ "$(cm_of GPU_MEMORY_UTILIZATION "${out}")" == 0.8 ]] || fail "GPU_MEMORY_UTILIZATION not applied on a nested overlay"
ok "overlay selectable; inputs merge into nested overlays"

test_name=inference-render-refusals
refused "MODEL_REVISION" MODEL=acme/model-8b
refused "unknown overlay" OVERLAY=nope
refused "OVERLAY" OVERLAY=../base
refused "MAX_MODEL_LEN" MAX_MODEL_LEN=8k
refused "GPU_MEMORY_UTILIZATION" GPU_MEMORY_UTILIZATION=1.5
refused "GPU_MEMORY_UTILIZATION" GPU_MEMORY_UTILIZATION=0
refused "MODEL" 'MODEL=acme/m;rm' MODEL_REVISION=abc
ok "unpinned model, unknown overlay, bad numbers and odd characters refused"
