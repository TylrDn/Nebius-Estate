#!/usr/bin/env bash
# Run 2 step 7: R5 first run. Scale vLLM to 0 (one GPU; the namespace quota needs it), apply the
# team namespaces, SkyPilot (platform/versions.yaml recipes.skypilot) in a venv (a NEW local tool, under state/r5/venv), config and task
# copies with allowed_contexts = the team context and accelerators L40S:1 (tracked files untouched),
# a team kubeconfig with the skypilot SA token (8 h; written to a 0600 file, never on argv),
# sky check kubernetes, sky launch -c ddp, read /artifacts/metrics.json, sky down ddp, sky api stop.
# The team kubeconfig is removed on every exit once `sky down` ran or `sky launch` never started;
# if the script stops between launch and down, it is kept (sky down needs it) and the RESULT block
# says so. `sky launch` asks for confirmation at its own prompt (no -y): answer it (needs a terminal).
# Any SkyPilot API server already running is stopped before `sky check`, so it restarts with the team
# KUBECONFIG. SkyPilot itself writes outside this folder: ~/.sky (its state and API server logs) and
# an Include line in ~/.ssh/config (for `ssh ddp`); remove them after the session if SkyPilot is not kept (runbooks/live-session.md).
# Executed: bash run2-7-r5.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-7-r5
header "Run 2 step 7 - R5 team platform (SkyPilot on the L40S)" \
  "kubectl scale deploy/vllm --replicas=0; kubectl apply -k recipes/team-platform/namespaces; pip install skypilot[kubernetes] (pinned version, venv); sky launch -c ddp task (L40S:1); metrics; sky down" \
  "\$0 extra (runs on the R1 node); pip download only" "about 15-25 min (venv, image pull, 20 DDP steps)" \
  "the RESULT block (sky check, task status, metrics.json, sky down)"
need kubectl jq python3 ssh
need_tty   # sky launch asks for confirmation at its own prompt
check_repo
load_env
kube_env
R5="${STATE_DIR}/r5"; mkdir -p "${R5}"; chmod 700 "${R5}"

if kubectl -n inference get deploy vllm >/dev/null 2>&1; then
  run kubectl -n inference scale deploy/vllm --replicas=0
  run kubectl -n inference rollout status deploy/vllm --timeout=5m
else
  say "no deploy/vllm (step 3a did not deploy it): the GPU is already free"
fi
run kubectl apply -k recipes/team-platform/namespaces

# SkyPilot venv (the plan's new local tool), at the version platform/versions.yaml pins (recipes.skypilot).
SKY_VERSION="$(PYTHONDONTWRITEBYTECODE=1 python3 -c 'import sys; sys.path.insert(0, "scripts"); from versions import load; print(load()["recipes/skypilot"]["version"])')"
[[ "${SKY_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "no recipes.skypilot version in platform/versions.yaml (got '${SKY_VERSION}')"
if [[ ! -x "${R5}/venv/bin/sky" ]] || ! "${R5}/venv/bin/pip" show skypilot 2>/dev/null | grep -qx "Version: ${SKY_VERSION}"; then
  [[ -x "${R5}/venv/bin/pip" ]] || run python3 -m venv "${R5}/venv"
  run "${R5}/venv/bin/pip" install -q "skypilot[kubernetes]==${SKY_VERSION}"
fi
SKY="${R5}/venv/bin/sky"
"${SKY}" --version
KTEAM="${R5}/kubeconfig-team"
LAUNCHED=0 DOWN_DONE=0
r5_exit() { # remove the 8 h token unless a launched cluster still needs it for sky down; stop the API server
  if [[ "${LAUNCHED}" == 0 || "${DOWN_DONE}" == 1 ]]; then rm -f "${KTEAM}"; fi
  "${SKY}" api stop >/dev/null 2>&1 || true
}
trap 'rc=$?; r5_exit; _on_exit $rc' EXIT

# Team kubeconfig: operator cluster endpoint + CA, the skypilot SA token, namespace team-research.
server="$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}')"
ca="$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
[[ -n "${server}" && -n "${ca}" ]] || die "no server/CA in the operator kubeconfig"
token="$(kubectl -n team-research create token skypilot --duration 8h)"
CTX=nip-sandbox-inference-team-research
( umask 077
  printf 'apiVersion: v1\nkind: Config\nclusters:\n- name: nip-sandbox-inference\n  cluster:\n    server: %s\n    certificate-authority-data: %s\nusers:\n- name: team-research-skypilot\n  user:\n    token: %s\ncontexts:\n- name: %s\n  context:\n    cluster: nip-sandbox-inference\n    user: team-research-skypilot\n    namespace: team-research\ncurrent-context: %s\n' \
    "${server}" "${ca}" "${token}" "${CTX}" "${CTX}" > "${KTEAM}" )
unset token
sed -e "s/REPLACE-WITH-KUBECONFIG-CONTEXT/${CTX}/" recipes/team-platform/skypilot/config.yaml > "${R5}/config.yaml"
sed -e 's/accelerators: H100:1.*/accelerators: L40S:1/' recipes/team-platform/skypilot/task.yaml > "${R5}/task.yaml"
if ! grep -q "${CTX}" "${R5}/config.yaml" || ! grep -q 'accelerators: L40S:1' "${R5}/task.yaml"; then die "config/task copies not rewritten"; fi

export KUBECONFIG="${KTEAM}" SKYPILOT_GLOBAL_CONFIG="${R5}/config.yaml"
say "team context: $(kubectl config current-context) (namespace team-research, skypilot SA token)"
# A SkyPilot API server left from an earlier attempt keeps the environment it started with (another
# KUBECONFIG): stop it, so the server the next command starts reads KUBECONFIG=${KTEAM}.
run "${SKY}" api stop || say "(no SkyPilot API server was running, or api stop failed: continuing)"
run "${SKY}" check kubernetes
FAIL_HINT="sky launch started: the team kubeconfig ${KTEAM} (8 h skypilot token) is KEPT for: KUBECONFIG=${KTEAM} SKYPILOT_GLOBAL_CONFIG=${R5}/config.yaml ${SKY} down -y ddp; then rm -f ${KTEAM}; ${SKY} api stop"
LAUNCHED=1
if [[ "${ASSUME_YES}" == 1 ]]; then run "${SKY}" launch -y -c ddp "${R5}/task.yaml"; else run "${SKY}" launch -c ddp "${R5}/task.yaml"; fi
metrics="$(ssh ddp 'cat /artifacts/metrics.json' 2>/dev/null || true)"
[[ -n "${metrics}" ]] || say "could not read /artifacts/metrics.json over 'ssh ddp'; the launch log above shows the torchrun output"
quota="$(KUBECONFIG="${REPO}/${KCFG_REL}" kubectl -n team-research get resourcequota -o json 2>/dev/null | jq -c '[.items[] | {name: .metadata.name, used: .status.used, hard: .status.hard}]' || true)"
run "${SKY}" down -y ddp
DOWN_DONE=1; FAIL_HINT=""
rm -f "${KTEAM}"   # holds the 8 h skypilot token; not needed after sky down
run "${SKY}" api stop || say "WARNING: sky api stop failed (the local SkyPilot API server may still run: ${SKY} api stop)"
quota_after="$(KUBECONFIG="${REPO}/${KCFG_REL}" kubectl -n team-research get resourcequota -o json 2>/dev/null | jq -c '[.items[] | {used: .status.used}]' || true)"

result_begin
say "sky launch: done (see log); deploy/vllm at 0 replicas (step 8 keeps it there)"
say "metrics.json (last 20 lines):"; printf '%s\n' "${metrics}" | tail -n 20
say "quota while running: ${quota}"
say "quota after sky down: ${quota_after}"
say "evidence: docs/evidence/<date>-sandbox-inference-team-platform.md"
say "next (optional R6): bash ${LIVE_DIR}/run2-8-r6.sh, else bash ${LIVE_DIR}/run2-10-teardown.sh after run2-9-evidence.sh"
