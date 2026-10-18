#!/usr/bin/env bash
# scripts/live/lib.sh: the helpers the owner-run live-session steps share (runbooks/live-session.md).
# Offline, against stub CLIs and a throwaway copy of the repo layout: no token, no cloud, no cluster.
# What each block guards was reviewed for the 2026-10-12 session: the target never comes from a
# committed id, ttl_cancel only kills a ttl-teardown job, a registry image id is read from .id or
# .metadata.id, Docker over SSH gets an empty client config, preflight must print GO and exit 0,
# a TTL job never inherits a token that dies first, the R12 passwords never reach a child process.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
unset NEBIUS_PROJECT_ID NEBIUS_REGION NEBIUS_PROFILE ASSUME_YES SSH_CONNECTION DOCKER_CONFIG DOCKER_HOST \
  R12_BATCH_MLFLOW_PW R12_BATCH_PG_PW LIVE_ALLOW_TMP

R="${work}/repo"
mkdir -p "${R}/scripts/live" "${R}/.nip-targets"
cp "${repo_root}/scripts/live/lib.sh" "${R}/scripts/live/"
cp "${repo_root}/scripts/lib-time.sh" "${R}/scripts/"
: > "${R}/Makefile"
FAKE_P=project-e00fake0000000000test FAKE_R=eu-north1
# in_lib <commands>: run in a child bash that sourced the copied lib.sh, from the fake repo. lib.sh
# has its own LOG (the step log); the stubs' call log is put back for the commands.
export STUB_LOG="${LOG}"
in_lib() { ( cd "${R}" && bash -c 'set -euo pipefail; source scripts/live/lib.sh; LOG="${STUB_LOG}"; '"$1" ); }

# --- target: never a committed id -------------------------------------------------------------
test_name=live-target-from-stage-binding
printf '%s %s\n' "${FAKE_P}" "${FAKE_R}" > "${R}/.nip-targets/sandbox"
out="$(NEBIUS_PROFILE=p1 in_lib 'live_target; echo "$LIVE_PROJECT $LIVE_REGION $LIVE_PROFILE"')" || fail "binding: ${out}"
[[ "${out}" == "${FAKE_P} ${FAKE_R} p1" ]] || fail "project and region come from .nip-targets/sandbox: ${out}"
out="$(NEBIUS_PROJECT_ID=project-e00other NEBIUS_REGION=eu-west2 NEBIUS_PROFILE=p1 in_lib 'live_target; echo "$LIVE_PROJECT $LIVE_REGION"' 2>&1)" || fail "binding with another env: ${out}"
grep -q "^${FAKE_P} ${FAKE_R}$" <<<"${out}" || fail "the stage binding wins over the caller's NEBIUS_PROJECT_ID: ${out}"
grep -q 'not the sandbox project' <<<"${out}" || fail "a different NEBIUS_PROJECT_ID in the shell is named, not silently used: ${out}"
ok "the stage binding is the sandbox target; another NEBIUS_PROJECT_ID is ignored with a note"

test_name=live-target-from-environment
rm -f "${R}/.nip-targets/sandbox"
out="$(NEBIUS_PROJECT_ID="${FAKE_P}" NEBIUS_REGION="${FAKE_R}" NEBIUS_PROFILE=p1 in_lib 'live_target; echo "$LIVE_PROJECT $LIVE_REGION"')" || fail "env: ${out}"
[[ "${out}" == "${FAKE_P} ${FAKE_R}" ]] || fail "without a binding, the exported NEBIUS_PROJECT_ID / NEBIUS_REGION: ${out}"
ok "without a binding the exported project and region are used"

test_name=live-target-refusals
expect_no_target() { # <grep pattern> <env assignments...> -- refused by live_target
  local pat="$1" out rc; shift
  set +e; out="$(env "$@" bash -c "cd '${R}' && source scripts/live/lib.sh && live_target" 2>&1)"; rc=$?; set -e
  (( rc != 0 )) || fail "must refuse ($*): ${out}"
  grep -q -- "${pat}" <<<"${out}" || fail "refusal ($*) must say '${pat}': ${out}"
}
expect_no_target 'no target' NEBIUS_PROFILE=p1
expect_no_target 'no target' NEBIUS_PROFILE=p1 NEBIUS_PROJECT_ID="${FAKE_P}"
expect_no_target 'does not look like a project id' NEBIUS_PROFILE=p1 NEBIUS_PROJECT_ID=e00fake NEBIUS_REGION="${FAKE_R}"
printf '%s\n' "${FAKE_P}" > "${R}/.nip-targets/sandbox"
expect_no_target 'is not .<project id> <region>.' NEBIUS_PROFILE=p1
printf '%s %s extra\n' "${FAKE_P}" "${FAKE_R}" > "${R}/.nip-targets/sandbox"
expect_no_target 'is not .<project id> <region>.' NEBIUS_PROFILE=p1
printf '%s %s\n' "${FAKE_P}" "${FAKE_R}" > "${R}/.nip-targets/sandbox"
expect_no_target 'no CLI profile' HOME="${HOME}"
grep -rqE 'project-e0[0-9a-z]{6,}' "${repo_root}/scripts/live" && fail "a project id is written in scripts/live"
ok "no binding and no exported target, a malformed binding or no profile: refused; no project id in scripts/live"

# --- .env values by name, without leaking the rest ---------------------------------------------
test_name=live-env-get
cat > "${R}/.env" <<'EOF'
# comment
NEBIUS_PROFILE=fromenv   # trailing comment
R12_MLFLOW_ADMIN_PASSWORD='Pa ss#1word!'
R12_POSTGRESQL_PASSWORD="Pg$(echo)#Pw1!"
EMPTY=
EOF
chmod 600 "${R}/.env"
out="$(in_lib 'env_get NEBIUS_PROFILE')"; [[ "${out}" == fromenv ]] || fail "unquoted value with a trailing comment: '${out}'"
out="$(in_lib 'env_get R12_MLFLOW_ADMIN_PASSWORD')"; [[ "${out}" == 'Pa ss#1word!' ]] || fail "single-quoted value with # and a space: '${out}'"
out="$(in_lib 'env_get R12_POSTGRESQL_PASSWORD')"; [[ "${out}" == 'Pg#Pw1!' ]] || fail "double-quoted value as bash reads it: '${out}'"
out="$(in_lib 'env_get EMPTY; env_get MISSING')"; [[ -z "${out}" ]] || fail "empty and missing names print nothing: '${out}'"
out="$(NEBIUS_PROFILE=shell in_lib 'env_get NEBIUS_PROFILE')"; [[ "${out}" == fromenv ]] || fail "env_get reads .env, not the caller's environment: '${out}'"
in_lib 'env_get "x;y"' >/dev/null 2>&1 && fail "a name that is not a variable name is refused"
out="$(in_lib 'live_target; echo "$LIVE_PROFILE"')"; [[ "${out}" == fromenv ]] || fail "the profile falls back to .env's NEBIUS_PROFILE: ${out}"
ok "env_get returns one .env value as bash parses it; the profile falls back to it"

# --- load_env: target exported, keys and batch passwords never inherited -------------------------
test_name=live-load-env-hygiene
printf 'NEBIUS_TENANT_ID=tenant-fake\nNEBIUS_PROJECT_ID=project-e00wrong\nNEBIUS_API_KEY=k\nGITHUB_TOKEN=g\nTF_VAR_empty=\n' >> "${R}/.env"
out="$(R12_BATCH_MLFLOW_PW=b1 R12_BATCH_PG_PW=b2 in_lib 'load_env
  echo "target=$NEBIUS_PROJECT_ID $NEBIUS_REGION $NEBIUS_PROFILE"
  echo "child=$(bash -c '\''echo "${R12_MLFLOW_ADMIN_PASSWORD:-}${R12_POSTGRESQL_PASSWORD:-}${NEBIUS_API_KEY:-}${GITHUB_TOKEN:-}${R12_BATCH_MLFLOW_PW:-}${R12_BATCH_PG_PW:-}${TF_VAR_empty+set}"'\'')"
  echo "shell=${R12_BATCH_MLFLOW_PW}${R12_BATCH_PG_PW}"' 2>&1)" || fail "load_env: ${out}"
grep -qx "target=${FAKE_P} ${FAKE_R} fromenv" <<<"${out}" || fail ".env's NEBIUS_PROJECT_ID never wins over the stage binding: ${out}"
grep -qx 'child=' <<<"${out}" || fail "no child process inherits .env keys, the R12 passwords or empty TF_VAR_*: ${out}"
grep -qx 'shell=b1b2' <<<"${out}" || fail "steps 2b and 5 still read the batch passwords as shell variables: ${out}"
chmod 644 "${R}/.env"
in_lib 'load_env' >/dev/null 2>&1 && fail "a .env that is not mode 600 is refused"
chmod 600 "${R}/.env"
ok "load_env exports the binding's target; .env keys and R12_BATCH_* never reach a child"

# --- ttl_cancel / ttl_running against fake jobs -------------------------------------------------
test_name=live-ttl-cancel-fake-job
# The toolbox image has no ps: a stand-in answering `ps -p <pid> [-o command=]` from /proc (a zombie
# counts as gone), so ttl_cancel itself runs verbatim. On a Mac the real ps is used.
if ! command -v ps >/dev/null 2>&1; then
  stub ps 'p=""; o=""; while (( $# )); do case "$1" in -p) p="$2"; shift 2 ;; -o) o="$2"; shift 2 ;; *) shift ;; esac; done
[[ -r "/proc/${p}/cmdline" ]] || exit 1
[[ "$(cut -d" " -f3 "/proc/${p}/stat" 2>/dev/null)" != Z ]] || exit 1
if [[ "${o}" == command= ]]; then tr "\0" " " < "/proc/${p}/cmdline"; echo; else echo "${p}"; fi'
fi
pidf="${R}/terraform/live/sandbox/data/.terraform/ttl-teardown.pid"; mkdir -p "$(dirname "${pidf}")"
printf 'while :; do sleep 1; done\n' > "${work}/ttl-teardown-fake"
# Started from a subshell that exits at once, so the job is re-parented and reaped like a nohup job.
( bash "${work}/ttl-teardown-fake" >/dev/null 2>&1 & echo $! > "${pidf}" )
job="$(cat "${pidf}")"
in_lib 'ttl_running data' || fail "a live ttl-teardown job is reported running"
in_lib 'ttl_cancel data' || fail "ttl_cancel must return 0 after stopping the job"
sleep 1; ps -p "${job}" >/dev/null 2>&1 && { kill "${job}" 2>/dev/null; fail "the ttl-teardown job ${job} is still running"; }
in_lib 'ttl_running data' && fail "a stopped job is not running"
( sleep 30 >/dev/null 2>&1 & echo $! > "${pidf}" )
other="$(cat "${pidf}")"
in_lib 'ttl_cancel data' || fail "a reused pid (not ttl-teardown) returns 0"
ps -p "${other}" >/dev/null 2>&1 || fail "a pid that is not a ttl-teardown job is never killed"
kill "${other}" 2>/dev/null || true
rm -f "${pidf}"
in_lib 'ttl_cancel data' || fail "no pid file returns 0"
in_lib 'ttl_running data' && fail "no pid file is not running"
ok "ttl_cancel stops only a ttl-teardown job and returns 0; a reused pid is left alone"

# --- registry image ids --------------------------------------------------------------------------
test_name=live-registry-purge-ids
stub terraform 'echo registry-fake01'
stub nebius 'case "$*" in
  *"image list"*) n="$(cat "$LOG.n" 2>/dev/null || echo 0)"; echo $((n+1)) > "$LOG.n"
    if (( n == 0 )); then echo "{\"items\":[{\"id\":\"img-top\"},{\"metadata\":{\"id\":\"img-meta\"}}]}"; else echo "{\"items\":[]}"; fi ;;
  *"image delete"*) exit 0 ;;
esac'
out="$(NEBIUS_PROFILE=p1 in_lib 'NEBIUS_PROFILE=p1; registry_purge; echo "$REGISTRY_NOTE"' 2>/dev/null)" || fail "purge: ${out}"
grep -q '^nebius --profile p1 registry image delete --id img-top$' "${LOG}" || fail "an image with a top-level .id is deleted (seen live 2026-10-12)"
grep -q '^nebius --profile p1 registry image delete --id img-meta$' "${LOG}" || fail "an image with .metadata.id is deleted"
grep -q 'registry-fake01: 2 image(s) deleted, 0 listed after' <<<"${out}" || fail "the note counts deletes and what is left: ${out}"
: > "${LOG}"; rm -f "${LOG}.n"
stub nebius 'case "$*" in *"image list"*) echo "{\"items\":[{\"id\":\"img-stuck\"}]}" ;; esac'
in_lib 'NEBIUS_PROFILE=p1; registry_purge' >/dev/null 2>&1 && fail "an image still listed after the deletes fails the purge"
stub nebius 'exit 1'
out="$(in_lib 'NEBIUS_PROFILE=p1; registry_purge || echo "rc=$? $REGISTRY_NOTE"' 2>/dev/null)"
grep -q 'rc=1 .*IMAGE LIST FAILED' <<<"${out}" || fail "a failed list is a failure, never 'empty': ${out}"
stub terraform 'exit 1'
out="$(in_lib 'registry_purge; echo "$REGISTRY_NOTE"')" || fail "no registry output: ${out}"
grep -q 'nothing to empty' <<<"${out}" || fail "no registry_id output means nothing to purge: ${out}"
rm -f "${bin}/terraform" "${bin}/nebius"; : > "${LOG}"
ok "registry_purge deletes images by .id or .metadata.id and checks the registry is empty"

# --- Docker over SSH -------------------------------------------------------------------------------
test_name=live-docker-ssh-env
# A short HOME: a Unix socket path must stay under 104 bytes on macOS.
sh_home="$(mktemp -d /tmp/nipl.XXXXXX)"; trap 'rm -rf "${work}" "${sh_home}"' EXIT
mkdir -p "${sh_home}/.docker/run"
python3 -c 'import socket, sys; s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "${sh_home}/.docker/run/docker.sock"
mkdir -p "${R}/.cache/live/state/docker-ssh"; echo '{"credsStore":"desktop","auths":{"x":{}}}' > "${R}/.cache/live/state/docker-ssh/config.json"
out="$(HOME="${sh_home}" SSH_CONNECTION='10.0.0.1 1 10.0.0.2 22' in_lib 'docker_ssh_env; echo "$DOCKER_CONFIG|$DOCKER_HOST"; bash -c '\''echo "child=$DOCKER_CONFIG"'\''')" || fail "ssh env: ${out}"
grep -qx "${R}/.cache/live/state/docker-ssh|unix://${sh_home}/.docker/run/docker.sock" <<<"$(head -1 <<<"${out}")" || fail "over SSH: DOCKER_CONFIG in state/, DOCKER_HOST the Desktop socket: ${out}"
grep -qx "child=${R}/.cache/live/state/docker-ssh" <<<"${out}" || fail "docker run by a child step sees the same config: ${out}"
[[ "$(cat "${R}/.cache/live/state/docker-ssh/config.json")" == '{}' ]] || fail "the client config is empty: no credential helper, no stored auth"
out="$(HOME="${sh_home}" in_lib 'docker_ssh_env; echo "[${DOCKER_CONFIG:-}${DOCKER_HOST:-}]"')"
[[ "${out}" == '[]' ]] || fail "outside SSH nothing changes: ${out}"
out="$(SSH_CONNECTION=x in_lib 'docker_ssh_env; echo "[${DOCKER_CONFIG:-}${DOCKER_HOST:-}]"')"
[[ "${out}" == '[]' ]] || fail "over SSH without a Desktop socket nothing changes: ${out}"
ok "over SSH Docker gets an empty client config and the Desktop socket; nothing changes otherwise"

# --- preflight_go -----------------------------------------------------------------------------------
test_name=live-preflight-go
stub make 'echo "Preflight sandbox/data: GO, 1 warning(s)"'
out="$(in_lib 'preflight_go STAGE=sandbox STACK=data >/dev/null; echo "$PREFLIGHT_LINE"')" || fail "GO with exit 0 passes: ${out}"
[[ "${out}" == "Preflight sandbox/data: GO, 1 warning(s)" ]] || fail "the Preflight line is kept for the RESULT block: ${out}"
grep -q '^make preflight STAGE=sandbox STACK=data$' "${LOG}" || fail "make preflight gets the step's arguments"
stub make 'echo "Preflight sandbox/data: NO-GO"; exit 1'
in_lib 'preflight_go STACK=data' >/dev/null 2>&1 && fail "NO-GO stops the step"
stub make 'echo "Preflight sandbox/data: GO"; exit 1'
in_lib 'preflight_go STACK=data' >/dev/null 2>&1 && fail "GO printed but a non-zero exit stops the step"
stub make 'echo "all good"'
in_lib 'preflight_go STACK=data' >/dev/null 2>&1 && fail "no Preflight GO line stops the step"
rm -f "${bin}/make"; : > "${LOG}"
ok "preflight_go needs both a 'Preflight ...: GO' line and exit 0"

# --- token_guard: a TTL job never inherits a token that expires first -----------------------------
test_name=live-token-guard
mkdir -p "${HOME}/.nebius"
cat > "${HOME}/.nebius/credentials.yaml" <<'EOF'
tokens:
  federation/fed-x/p1:
    token: never-read
    expires_at: 2026-10-12T20:00:00Z
  federation/fed-x/other:
    expires_at: 2026-10-13T20:00:00Z
EOF
exp="$(NEBIUS_PROFILE=p1 in_lib 'live_target >/dev/null 2>&1; iam_token_expiry')" || fail "expires_at not read"
[[ "$(cd "${R}" && bash -c 'source scripts/lib-time.sh; nip_utc "$1"' _ "${exp}")" == 2026-10-12T20:00:00Z ]] || fail "the profile's own entry is read: ${exp}"
out="$(NEBIUS_PROFILE=p1 in_lib 'live_target 2>/dev/null; token_guard "$(nip_epoch 2026-10-12T18:30:00Z)" "the data TTL job"; echo "TOKEN_EXP=$TOKEN_EXP"' 2>&1)" || fail "fire + 60 min before expiry passes: ${out}"
grep -q 'TOKEN_EXP=2026-10-12T20:00:00Z' <<<"${out}" || fail "TOKEN_EXP is kept for the RESULT block: ${out}"
grep -q 'never-read' <<<"${out}" && fail "the token value is never printed"
set +e; out="$(NEBIUS_PROFILE=p1 in_lib 'live_target 2>/dev/null; STEP_ID=run2-2d-rearm; token_guard "$(nip_epoch 2026-10-12T19:30:00Z)" "the data TTL job"' 2>&1)"; rc=$?; set -e
(( rc != 0 )) || fail "a token expiring before fire + 60 min is refused: ${out}"
grep -q 'refresh-login.sh' <<<"${out}" || fail "the refusal names the fix: ${out}"
set +e; out="$(NEBIUS_PROFILE=nobody in_lib 'live_target 2>/dev/null; token_guard 0 x' 2>&1)"; rc=$?; set -e
(( rc != 0 )) || fail "an unknown token lifetime is refused: ${out}"
ok "token_guard refuses a token that expires before the TTL time + 60 min, and never prints it"

# --- prompts and the temporary-directory refusal ----------------------------------------------------
test_name=live-confirm-and-tmp
out="$(ASSUME_YES=1 in_lib 'confirm "Destroy x?"')" || fail "ASSUME_YES=1 answers yes"
grep -q '(ASSUME_YES=1) Destroy x? -> yes' <<<"${out}" || fail "the answered prompt is printed: ${out}"
in_lib 'confirm "Destroy x?"' </dev/null >/dev/null 2>&1 && fail "without ASSUME_YES a prompt needs a terminal"
out="$(ASSUME_YES=1 in_lib 'STEP_ID=x; LOG=/dev/null; header t w c d s' 2>&1)" || fail "header: ${out}"
grep -q 'ASSUME_YES=1 IS SET' <<<"${out}" || fail "ASSUME_YES=1 prints the banner: ${out}"
case "${R}" in
  /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*)
    set +e; out="$(in_lib 'step_init run2-0-preflight' 2>&1)"; rc=$?; set -e
    if (( rc == 0 )) || ! grep -q 'temporary directory' <<<"${out}"; then fail "state under a temporary directory is refused: ${out}"; fi
    out="$(in_lib 'live_dir_check abort' 2>&1)" || fail "abort.sh is never blocked: ${out}"
    grep -q WARNING <<<"${out}" || fail "abort.sh warns instead: ${out}" ;;
  *) echo "skip ${test_name}: the test's temp dir is not under a temporary directory" ;;
esac
ok "ASSUME_YES answers prompts under a banner; state under /tmp is refused except for abort.sh"

# --- the R1-only session (run-r1.sh): no data/ml-services roots, so no step-2d re-arm ------------
test_name=live-session-mode-r1-only
st="${R}/.cache/live/state"; mkdir -p "${st}"
printf 'APPLIED_R1=1\nSTEP_2D_DONE=0\n' > "${st}/run2.env"
out="$(in_lib 'session_mode')"; [[ "${out}" == run2 ]] || fail "no SESSION_MODE is the full run 2: ${out}"
set +e; out="$(in_lib 'require_2d' 2>&1)"; rc=$?; set -e
(( rc != 0 )) || fail "run 2 without step 2d still refuses: ${out}"
grep -q 'run2-2d-rearm.sh first' <<<"${out}" || fail "the refusal names step 2d: ${out}"
printf 'SESSION_MODE=r1-only\nAPPLIED_R1=1\nSTEP_2D_DONE=0\n' > "${st}/run2.env"
out="$(in_lib 'session_mode')"; [[ "${out}" == r1-only ]] || fail "SESSION_MODE=r1-only is read from state: ${out}"
in_lib 'require_2d' >/dev/null 2>&1 || fail "an R1-only session has no data/ml-services TTL jobs to re-arm: require_2d passes once R1 is applied"
printf 'SESSION_MODE=r1-only\n' > "${st}/run2.env"
set +e; out="$(in_lib 'require_2d' 2>&1)"; rc=$?; set -e
(( rc != 0 )) || fail "an R1-only session before the R1 apply refuses: ${out}"
grep -q 'R1 is not applied' <<<"${out}" || fail "the refusal says why: ${out}"
printf 'SESSION_MODE=bogus\n' > "${st}/run2.env"
in_lib 'session_mode' >/dev/null 2>&1 && fail "an unknown SESSION_MODE is refused"
rm -f "${st}/run2.env"
ok "SESSION_MODE=r1-only skips the step-2d guard once R1 is applied; run 2 keeps it; unknown modes refused"
