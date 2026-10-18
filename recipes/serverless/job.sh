#!/usr/bin/env bash
# Modified by Taylor Dean: project lifecycle, safety and measurement wrappers.
# Cookbook source/ref/path and Apache-2.0 license: docs/source-provenance.md.
# Serverless batch twin: run vLLM's offline throughput benchmark on the same model as a
# Serverless AI job that auto-terminates (cookbook quickstarts/first-job pattern).
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULTS_DIR="${RESULTS_DIR:-${repo_root}/results}"; mkdir -p "$RESULTS_DIR"
NAME="${JOB_NAME:-nip-vllm-batch-$(date +%s)}"
# Exact digest the lab Deployment uses (workloads/inference/base/deployment.yaml, platform/versions.yaml).
IMAGE="${VLLM_IMAGE:-vllm/vllm-openai:v0.31.0@sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3}"
MODEL="${MODEL:-Qwen/Qwen2.5-1.5B-Instruct}"
MODEL_REVISION="${MODEL_REVISION:-989aa7980e4cf806f80c7fef2b1adb7bc71aa306}"
PLATFORM="${PLATFORM:-gpu-l40s-a}"; PRESET="${PRESET:-1gpu-8vcpu-32gb}"
for c in nebius jq; do command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 2; }; done
# shellcheck source=scripts/lib-nebius.sh
source "${repo_root}/scripts/lib-nebius.sh"

t0=$(date +%s)
# `vllm` is the entrypoint itself: `bash -c` with an unquoted multi-word payload would run `vllm` alone.
# --timeout 1h is the documented minimum (serverless/jobs/manage).
nip_nebius ai job create --name "$NAME" --image "$IMAGE" \
  --container-command vllm \
  --args "bench throughput --model $MODEL --revision $MODEL_REVISION --dataset-name random --input-len 256 --output-len 128 --num-prompts 200" \
  --platform "$PLATFORM" --preset "$PRESET" --timeout 1h >/dev/null
id="$(nip_nebius ai job get-by-name --name "$NAME" --format jsonpath='{.metadata.id}')"
status=""; code=""
# Up to 90 min: PROVISIONING alone may wait 30 min for capacity before ERROR (serverless/lifecycle).
# Terminal states: COMPLETED (success), FAILED (workload), CANCELLED, ERROR (service or capacity).
for _ in $(seq 1 540); do
  job="$(nip_nebius ai job get "$id" --format json)"
  status="$(jq -r '.status.state // "UNKNOWN"' <<<"$job")"
  code="$(jq -r '.status.state_details.code // empty' <<<"$job")"
  case "$status" in COMPLETED|FAILED|CANCELLED|ERROR) break ;; esac
  sleep 10
done
wall=$(( $(date +%s) - t0 ))
log="$(nip_nebius ai logs "$id" 2>/dev/null || true)"
# `vllm bench throughput` prints: "Throughput: R requests/s, T total tokens/s, O output tokens/s"
tline="$(grep -E '^Throughput:' <<<"$log" | tail -1 || true)"
req_s="$(grep -oE '[0-9]+(\.[0-9]+)? requests/s' <<<"$tline" | grep -oE '^[0-9.]+' || true)"
out_tps="$(grep -oE '[0-9]+(\.[0-9]+)? output tokens/s' <<<"$tline" | grep -oE '^[0-9.]+' || true)"
jq -n --arg id "$id" --arg st "$status" --arg code "$code" --argjson wall "$wall" --arg line "$tline" --arg rs "$req_s" --arg ot "$out_tps" \
  --arg img "$IMAGE" --arg m "$MODEL" --arg p "$PLATFORM/$PRESET" --arg ts "$(date -u +%FT%TZ)" \
  '{step:"serverless-job",status:(if $st=="COMPLETED" and $ot!="" then "pass" else "fail" end),timestamp:$ts,details:{job_id:$id,state:$st,state_code:$code,wall_seconds_create_to_end:$wall,requests_per_s:$rs,output_tokens_per_s:$ot,throughput_line:$line,image:$img,model:$m,preset:$p}}' \
  | tee "${RESULTS_DIR}/serverless-job.json"
nip_nebius ai job delete "$id" >/dev/null || true
