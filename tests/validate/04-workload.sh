#!/usr/bin/env bash
# Step 4 — Workload: vLLM Deployment available; /health and one chat completion succeed; startup time recorded.
# shellcheck source=tests/validate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; need kubectl jq curl
avail="$(kubectl -n inference get deploy vllm -o jsonpath='{.status.availableReplicas}' 2>/dev/null || echo 0)"
pod="$(kubectl -n inference get pod -l app.kubernetes.io/name=vllm -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
started="$(kubectl -n inference get pod "$pod" -o jsonpath='{.status.startTime}' 2>/dev/null || true)"
ready_at="$(kubectl -n inference get pod "$pod" -o json 2>/dev/null | jq -r '[.status.conditions[]|select(.type=="Ready")][0].lastTransitionTime // empty')"
startup_s=0
# jq parses the RFC 3339 timestamps, so this works with BSD and GNU date alike.
if [[ -n "$started" && -n "$ready_at" ]]; then startup_s="$(jq -n --arg s "$started" --arg r "$ready_at" '($r|fromdateiso8601)-($s|fromdateiso8601)')"; fi
kubectl -n inference port-forward svc/vllm 18000:8000 >/dev/null 2>&1 & pf=$!
trap 'kill "$pf" 2>/dev/null || true' EXIT
sleep 3
# The ConfigMap name carries a kustomize hash; resolve it from the Deployment.
cm="$(kubectl -n inference get deploy vllm -o jsonpath='{.spec.template.spec.containers[0].envFrom[0].configMapRef.name}')"
model="$(kubectl -n inference get cm "$cm" -o jsonpath='{.data.MODEL}')"
health="$(curl -s -o /dev/null -w '%{http_code}' localhost:18000/health || echo 000)"
# curl times the request itself (time_total, seconds) on its own last line.
out="$(curl -s -w '\n%{time_total}' localhost:18000/v1/chat/completions -H 'content-type: application/json' \
  -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK.\"}],\"max_tokens\":8}" || printf '{}\n0')"
resp="${out%$'\n'*}"
ms="$(jq -n --arg t "${out##*$'\n'}" '$t|tonumber*1000|floor')"
text="$(jq -r '.choices[0].message.content // empty' <<<"$resp")"
details="$(jq -n --argjson a "${avail:-0}" --arg m "$model" --arg h "$health" --argjson ms "$ms" --arg t "$text" --argjson su "$startup_s" --arg img "$(kubectl -n inference get deploy vllm -o jsonpath='{.spec.template.spec.containers[0].image}')" '{available_replicas:$a,model:$m,health_http:$h,first_request_ms:$ms,response:$t,startup_seconds:$su,image:$img}')"
if [[ "${avail:-0}" -ge 1 && "$health" == 200 && -n "$text" ]]; then record 04-workload pass "$details"; else record 04-workload fail "$details"; fi
