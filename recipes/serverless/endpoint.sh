#!/usr/bin/env bash
# Modified by Taylor Dean: project lifecycle, safety and measurement wrappers.
# Cookbook source/ref/path and Apache-2.0 license: docs/source-provenance.md.
# Serverless endpoint twin of workloads/inference: create | measure | delete.
# Mirrors serverless-ai-cookbook/inference/vllm-endpoint/README.md (commit 6c150ce).
# Usage: CONFIRM=yes recipes/serverless/endpoint.sh create   (a GPU endpoint bills until `delete`)
#        recipes/serverless/endpoint.sh measure|delete   (MEASURE_FROM=cluster: from a Job in the R1 cluster)
# ENDPOINT_POLL_TRIES (default 270) x ENDPOINT_POLL_INTERVAL (default 10 s) bound the /health wait.
set -euo pipefail
cmd="${1:-}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULTS_DIR="${RESULTS_DIR:-${repo_root}/results}"; mkdir -p "$RESULTS_DIR"
NAME="${ENDPOINT_NAME:-nip-vllm-compare}"
# Keep these identical to the lab overlay so the comparison is apples to apples.
# Exact digest the lab Deployment uses (workloads/inference/base/deployment.yaml, platform/versions.yaml).
IMAGE="${VLLM_IMAGE:-vllm/vllm-openai:v0.31.0@sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3}"
MODEL="${MODEL:-Qwen/Qwen2.5-1.5B-Instruct}"
MODEL_REVISION="${MODEL_REVISION:-989aa7980e4cf806f80c7fef2b1adb7bc71aa306}"
PLATFORM="${PLATFORM:-gpu-l40s-a}"; PRESET="${PRESET:-1gpu-8vcpu-32gb}"
# The region the endpoint lands in is the current profile's (its first subnet); NEBIUS_REGION, when
# set, is recorded with the result so compare.py can tell in-region from cross-region comparisons.
REGION="${NEBIUS_REGION:-}"
STATE="${RESULTS_DIR}/serverless-endpoint.state"   # id, token and the effective settings; git-ignored (results/*.state)
need() { for c in "$@"; do command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 2; }; done; }
need nebius jq curl
# shellcheck source=scripts/lib-nebius.sh
source "${repo_root}/scripts/lib-nebius.sh"
# Header from a file descriptor: the token never appears in curl's argv (printf is a builtin).
auth_header() { printf 'Authorization: Bearer %s\n' "$1"; }
load_state() { [[ -f "$STATE" ]] || { echo "no ${STATE}: run '$0 create' first (or the endpoint was already deleted)" >&2; exit 2; }
  # shellcheck source=/dev/null
  source "$STATE"; }

case "$cmd" in
  create)
    [[ "${CONFIRM:-}" == yes ]] || { echo "Refusing: create starts a ${PLATFORM}/${PRESET} GPU endpoint that bills until '$0 delete'; set CONFIRM=yes" >&2; exit 2; }
    # R6-2: the CLI takes the endpoint token only as an argument (--token, or --token-secret naming a
    # MysteryBox secret whose payload is itself passed as an argument), so it is briefly visible to
    # other users of this host via ps. Accepted for a short-lived, random, per-run token on a
    # single-user operator host; `delete` destroys the endpoint and the state file is 0600.
    token="$(openssl rand -hex 32)"
    subnet="$(nip_nebius vpc subnet list --format jsonpath='{.items[0].metadata.id}')"
    id=""
    # From here on the endpoint may exist and bill: on any failure, say how to remove it.
    on_create_exit() {
      local rc=$?
      (( rc == 0 )) && return
      if [[ -n "${id}" ]]; then
        echo "create failed after the endpoint ${id} was created; it bills until deleted: nebius ai endpoint delete ${id} (or '$0 delete')" >&2
      else
        echo "create failed; if the endpoint was created it bills until deleted: nebius ai endpoint get-by-name --name ${NAME}, then nebius ai endpoint delete <id>" >&2
      fi
    }
    trap on_create_exit EXIT
    t0=$(date +%s)
    nip_nebius ai endpoint create \
      --name "$NAME" --image "$IMAGE" \
      --container-command "python3 -m vllm.entrypoints.openai.api_server" \
      --args "--model $MODEL --revision $MODEL_REVISION --host 0.0.0.0 --port 8000 --max-model-len 8192" \
      --platform "$PLATFORM" --preset "$PRESET" \
      --container-port 8000 --auth token --token "$token" \
      --shm-size 16Gi --disk-size 200Gi --subnet-id "$subnet" >/dev/null
    # No --public: each HTTP port gets a managed https:// URL regardless; a public IP only spends
    # public-IP quota (serverless/endpoints/manage).
    id="$(nip_nebius ai endpoint get-by-name --name "$NAME" --format jsonpath='{.metadata.id}')"
    [[ -n "$id" ]] || { echo "get-by-name returned no id for ${NAME}" >&2; exit 1; }
    # Persist the id and settings before polling, so `delete` works even if this run dies here.
    write_state() {
      printf 'ENDPOINT_ID=%s\nENDPOINT_URL=%s\nENDPOINT_TOKEN=%s\nIMAGE=%s\nMODEL=%s\nMODEL_REVISION=%s\nPLATFORM=%s\nPRESET=%s\nENDPOINT_REGION=%s\n' \
        "$id" "$1" "$token" "$IMAGE" "$MODEL" "$MODEL_REVISION" "$PLATFORM" "$PRESET" "$REGION" > "$STATE"; chmod 600 "$STATE"
    }
    (umask 077; write_state "")
    url=""
    # Up to 45 min by default: PROVISIONING may wait 30 min for capacity (serverless/lifecycle).
    # A failed `get` (API blip, endpoint not yet visible) is retried, not fatal.
    for _ in $(seq 1 "${ENDPOINT_POLL_TRIES:-270}"); do
      # The managed https:// URL; endpoints created before managed URLs show IP:port instead.
      url="$( { nip_nebius ai endpoint get "$id" --format json 2>/dev/null || echo '{}'; } | jq -r '[.status.public_endpoints[]?] as $e
        | ([$e[] | select(startswith("https://"))] + [$e[] | select(test("^[a-z]+://") | not) | "http://" + .]) | .[0] // empty' 2>/dev/null || true)"
      [[ -n "$url" ]] && curl -sf -m 5 -H @<(auth_header "$token") "$url/health" >/dev/null && break
      url=""; sleep "${ENDPOINT_POLL_INTERVAL:-10}"
    done
    cold=$(( $(date +%s) - t0 ))
    [[ -n "$url" ]] || echo "endpoint ${id} never answered /health in time; it still exists and bills: inspect 'nebius ai logs ${id}', then '$0 delete'" >&2
    # Persist the effective settings so `measure`/`delete` use exactly what was created.
    write_state "$url"
    trap - EXIT
    jq -n --arg id "$id" --arg url "$url" --arg img "$IMAGE" --arg m "$MODEL" --arg p "$PLATFORM/$PRESET" --argjson cold "$cold" --arg ts "$(date -u +%FT%TZ)" --arg rg "$REGION" \
      '{step:"serverless-endpoint-create",status:(if $url=="" then "fail" else "pass" end),timestamp:$ts,
        details:{endpoint_id:$id,image:$img,model:$m,preset:$p,cold_start_seconds:$cold,region:(if $rg=="" then null else $rg end)}}' \
      | tee "${RESULTS_DIR}/serverless-endpoint-create.json"
    ;;
  measure)
    load_state
    # The sweep shape is checked before the probe, kubectl or Docker: a shape that cannot run sends
    # no request and leaves the earlier serverless-endpoint-measure.json in place.
    # shellcheck source=tests/load/lib-bench.sh
    source "${repo_root}/tests/load/lib-bench.sh"
    bench_check || exit 2
    url="${ENDPOINT_URL}"; ENDPOINT_REGION="${ENDPOINT_REGION:-}"
    # curl times the request itself (time_total, seconds) on its own last line.
    out="$(curl -s -w '\n%{time_total}' "$url/v1/chat/completions" -H @<(auth_header "$ENDPOINT_TOKEN") -H 'content-type: application/json' \
      -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK.\"}],\"max_tokens\":8}")"
    resp="${out%$'\n'*}"
    ms="$(jq -n --arg t "${out##*$'\n'}" '$t|tonumber*1000|floor')"
    text="$(jq -r '.choices[0].message.content // empty' <<<"$resp")"
    cold=()
    c="$(jq -r 'select(.status=="pass") | .details.cold_start_seconds // empty' "${RESULTS_DIR}/serverless-endpoint-create.json" 2>/dev/null || true)"
    [[ -n "$c" ]] && cold=(--server-startup-s "$c")
    # The probe above is the first request this measure sends; the sweep's own first request comes after it.
    [[ -n "$text" ]] && cold+=(--first-request-ms "$ms" --first-request-source "endpoint.sh measure probe")
    gen_region=""
    # The R1 load method (tests/load: same generator, sweep, bars and JSON). MEASURE_FROM picks the
    # generator's vantage: `host` (default) runs it here, over the WAN, through the managed URL;
    # `cluster` runs it as a Job inside the R1 cluster (current kubectl context), in-region like the
    # R1 figures, which is the only like-for-like comparison (compare.py labels it).
    case "${MEASURE_FROM:-host}" in
      host)
        bench="$(BENCH_API_KEY="$ENDPOINT_TOKEN" VLLM_IMAGE="$IMAGE" RESULTS_DIR="$RESULTS_DIR" \
          "${repo_root}/tests/load/bench.sh" --target r6 --base-url "$url" --model "$MODEL" --vantage operator-host ${cold[@]+"${cold[@]}"} || true)"
        details="$(jq -c '.details // empty' <<<"$bench" 2>/dev/null || true)"
        [[ -n "$details" ]] || details='{"status":"fail","error":"bench.sh produced no result (see its stderr above)"}' ;;
      cluster)
        need kubectl python3
        ns=nip-bench   # its own namespace: the inference namespace's NetworkPolicies allow egress to vLLM only
        kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
        # The token reaches the Secret from a file descriptor, never kubectl's argv; deleted after the
        # run, on every exit path (the trap is set before the Secret exists).
        trap 'kubectl -n nip-bench delete secret vllm-bench-key --ignore-not-found >/dev/null 2>&1 || true' EXIT
        kubectl -n "$ns" create secret generic vllm-bench-key --from-env-file=<(printf 'OPENAI_API_KEY=%s\n' "$ENDPOINT_TOKEN") \
          --dry-run=client -o yaml | kubectl apply -f - >/dev/null
        off_gpu=false; (( $(bench_cpu_nodes) > 0 )) && off_gpu=true
        bench_start "$ns" "$url" "$MODEL" "$off_gpu"
        gen_region="$(bench_region)"
        bench_wait "$ns"; st="$BENCH_STATE"
        log="${RESULTS_DIR}/bench-r6-in-region.log"
        kubectl -n "$ns" logs job/vllm-bench > "$log" 2>/dev/null || true
        kubectl -n "$ns" delete secret vllm-bench-key --ignore-not-found >/dev/null
        details="$(python3 "${repo_root}/tests/load/bench.py" parse "$log" --target r6 --vantage in-region-cluster-job \
          --image "$IMAGE" ${cold[@]+"${cold[@]}"} | jq --arg st "$st" '. + {job_status:$st} | if $st != "Complete" then .status="fail" else . end')" ;;
      *) echo "MEASURE_FROM must be host or cluster" >&2; exit 2 ;;
    esac
    jq -n --arg t "$text" --argjson ms "$ms" --arg ts "$(date -u +%FT%TZ)" --arg p "$PLATFORM/$PRESET" --argjson d "$details" \
      --arg er "$ENDPOINT_REGION" --arg gr "$gen_region" \
      '{step:"serverless-endpoint-measure",status:(if $t=="" or $d.status!="pass" then "fail" else "pass" end),timestamp:$ts,
        details:($d + {preset:$p,first_request_ms:$ms,response:$t,
          endpoint_region:(if $er=="" then null else $er end),generator_region:(if $gr=="" then null else $gr end),
          url_limits:"managed URL: 80 Mbps / 300 connections per endpoint (docs.nebius.com/serverless/endpoints/manage#traffic-and-connection-limits)"})}' \
      | tee "${RESULTS_DIR}/serverless-endpoint-measure.json"
    ;;
  delete)
    load_state
    nip_nebius ai endpoint delete "$ENDPOINT_ID" >/dev/null
    jq -n --arg id "$ENDPOINT_ID" --arg ts "$(date -u +%FT%TZ)" '{step:"serverless-endpoint-delete",status:"pass",timestamp:$ts,details:{endpoint_id:$id}}' \
      | tee "${RESULTS_DIR}/serverless-endpoint-delete.json"
    rm -f "$STATE"
    ;;
  *) echo "usage: $0 create|measure|delete" >&2; exit 2 ;;
esac
