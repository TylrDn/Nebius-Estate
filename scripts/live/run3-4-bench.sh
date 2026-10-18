#!/usr/bin/env bash
# Run 3 step 4: wait for vLLM, read the API key over SSH with the recipe's own command (never
# printed), then the bench. BENCH_PATH=tunnel (default, the plan's path: SSH tunnel from
# how_to_reach.tunnel + --base-url http://127.0.0.1:8000; needs Docker host networking, checked
# first) or BENCH_PATH=public (--base-url http://<public_ip>:8000 from this allowlisted host).
# Executed: bash run3-4-bench.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run3-4-bench
header "Run 3 step 4 - R10 bench" \
  "wait for /health, BENCH_API_KEY over SSH, tunnel, tests/load/bench.sh --target r10 --model Qwen/Qwen2.5-1.5B-Instruct" \
  "VM time only (\$0.77/h)" "about 10-20 min (vLLM image pull on this host, sweep)" "the RESULT block (bench-r10 points)"
need terraform jq ssh docker curl
check_repo
load_env
state_load run3
docker info >/dev/null 2>&1 || die "Docker is not running (open -a Docker)"
P="${BENCH_PATH:-tunnel}"
[[ "${P}" == tunnel || "${P}" == public ]] || die "BENCH_PATH must be tunnel or public"
USD="${BENCH_USD_PER_HOUR:-${R3_USD_PER_HOUR:-}}"
[[ -n "${USD}" ]] || die "no per-hour price: run run3-3-apply.sh (price.py) or pass BENCH_USD_PER_HOUR"

boot gpu-vm
R=terraform/live/sandbox/gpu-vm
reach="$(terraform -chdir="${R}" output -json how_to_reach)"
ip="$(terraform -chdir="${R}" output -raw public_ip)"
tunnel="$(jq -r .tunnel <<<"${reach}")"
dest="${tunnel##* }"   # <admin_user>@<host>, the last word of the tunnel command
[[ -n "${ip}" && "${dest}" == *@* ]] || die "no public_ip or tunnel in the outputs"

say "waiting for vLLM on http://${ip}:8000/health (up to 20 min; about 8 min on 2026-10-11)"
ok=0; for _ in $(seq 1 80); do curl -sf -m 5 "http://${ip}:8000/health" >/dev/null && { ok=1; break; }; sleep 15; done
(( ok == 1 )) || die "vLLM did not answer /health in 20 min: check logs with: $(jq -r .logs <<<"${reach}")"
run ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "${dest}" true   # first contact with the new VM

say ">>> export BENCH_API_KEY=\"\$(eval \"\$(terraform -chdir=${R} output -json how_to_reach | jq -r .api_key)\")\"   (SSH; value not printed)"
BENCH_API_KEY="$(eval "$(terraform -chdir="${R}" output -json how_to_reach | jq -r .api_key)")"
[[ -n "${BENCH_API_KEY}" ]] || die "the API key command returned nothing"
export BENCH_API_KEY

base="http://${ip}:8000"
if [[ "${P}" == tunnel ]]; then
  read -ra tun <<<"${tunnel}"
  say ">>> ${tunnel} &"
  "${tun[0]}" -o ExitOnForwardFailure=yes "${tun[@]:1}" >"${STATE_DIR}/run3-tunnel.log" 2>&1 &
  tpid=$!
  trap 'rc=$?; kill ${tpid} 2>/dev/null || true; _on_exit $rc' EXIT
  ok=0; for _ in $(seq 1 20); do curl -sf -m 3 http://127.0.0.1:8000/health >/dev/null && { ok=1; break; }; sleep 1; done
  (( ok == 1 )) || die "tunnel not answering on 127.0.0.1:8000 (see ${STATE_DIR}/run3-tunnel.log); or rerun with BENCH_PATH=public"
  img="$(grep -oE 'vllm/vllm-openai:[^}"]+' tests/load/bench.sh | head -1)"
  say "checking Docker host networking (the bench container must reach the tunnel on 127.0.0.1)"
  docker run --rm --network host --entrypoint /bin/sh "${img}" -c \
    'python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen(\"http://127.0.0.1:8000/health\", timeout=5).status == 200 else 1)"' \
    || die "a container with --network host cannot reach 127.0.0.1:8000: enable host networking in Docker Desktop settings, or rerun with BENCH_PATH=public"
  base="http://127.0.0.1:8000"
fi
say ">>> BENCH_USD_PER_HOUR=${USD} tests/load/bench.sh --target r10 --base-url ${base} --model Qwen/Qwen2.5-1.5B-Instruct"
rc=0; BENCH_USD_PER_HOUR="${USD}" tests/load/bench.sh --target r10 --base-url "${base}" --model Qwen/Qwen2.5-1.5B-Instruct || rc=$?
unset BENCH_API_KEY

result_begin
say "bench.sh exit ${rc}; path ${P}; BENCH_USD_PER_HOUR=${USD}"
if [[ -f results/bench-r10.json ]]; then bench_summary results/bench-r10.json; else say "results/bench-r10.json missing"; fi
say "evidence: docs/evidence/<date>-sandbox-gpu-vm-bench.md (also the first completion with the key)"
say "next: bash ${LIVE_DIR}/run3-5-teardown.sh  (now: the VM bills until destroyed)"
