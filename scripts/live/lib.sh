# shellcheck shell=bash
# Shared helpers for the owner-run live-session scripts in scripts/live/ (run1, run2-*, run3-*,
# abort.sh, refresh-login.sh). Sourced by each step script; never source it into an interactive shell.
# How to run a session, what each step proves, abort and teardown: runbooks/live-session.md.
# The reviewed plan they implement: docs/plans/2026-10-12-live-runs.md (runs 1-3).
#
# No real id is written in this folder. The sandbox project and region come from the stage binding
# that the stage's first bootstrap wrote (.nip-targets/sandbox, git-ignored; scripts/bootstrap-backend.sh),
# else from NEBIUS_PROJECT_ID and NEBIUS_REGION exported by the caller before the script starts (a
# NEBIUS_PROJECT_ID in .env is not used: it may name another project, as it did on 2026-10-11). The CLI
# profile comes from NEBIUS_PROFILE (the caller's, else .env's). live_target refuses when one is missing.
#
# Session state (labels, APPLIED_*, secret ids, prices) and logs live outside git in the checkout's
# .cache/live/{state,logs} (git-ignored via .cache/); live_dir_check refuses a temporary directory.

LIVE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${LIVE_DIR}/../.." && pwd)"
LIVE_STAGE=sandbox
LIVE_HOME="${REPO}/.cache/live"
STATE_DIR="${LIVE_HOME}/state"
LOG_DIR="${LIVE_HOME}/logs"
KCFG_REL=.cache/kubeconfig-sandbox-inference
export REPO LIVE_DIR STATE_DIR LOG_DIR

# The caller's target, read before anything below clears or overwrites it (live_target).
_LIVE_CALLER_PROJECT="${NEBIUS_PROJECT_ID:-}" _LIVE_CALLER_REGION="${NEBIUS_REGION:-}" _LIVE_CALLER_PROFILE="${NEBIUS_PROFILE:-}"

# Owner toggles are read once here. Names the Makefile or the repo scripts read from the
# environment are cleared, so a stray `export CONFIRM=yes` or `RUN=...` in the owner's shell
# can never reach a make target this script did not mean to confirm. The NIP_* test and bootstrap
# knobs go too: NIP_NOW (a fake clock for labels, LATE and the TTL delay), NIP_TTL_POLL,
# NIP_NEBIUS_CONFIG (another CLI config), NIP_BOOTSTRAP_NEW_STAGE (would create a second state
# bucket instead of refusing), NIP_TARGETS_DIR and the state-identity overrides. (A step that needs
# one sets it itself after this line, e.g. run2-8's throwaway NIP_NEBIUS_CONFIG.)
# ASSUME_YES is still read from the environment; header() prints a banner when it is on.
ASSUME_YES="${ASSUME_YES:-0}"
unset STAGE STACK PROFILE RUN TTL TTL_HOURS DRY CONFIRM RUN_PROFILE PLAN_LOCK PLAN_LOG OFFLINE FIXTURES \
  NIP_NOW NIP_TTL_POLL NIP_NEBIUS_CONFIG NIP_BOOTSTRAP_NEW_STAGE NIP_TARGETS_DIR NIP_STATE_SA_ID \
  NIP_STATE_GROUP_ID NIP_STATE_PERMIT_SCOPE NIP_NAME_PREFIX
# run2-all.sh hands the R12 passwords to its steps in R12_BATCH_*; only steps 2b and 5 read them, as
# shell variables. Not exported from here on, so no child (a make target, a nohup TTL job that lives
# for hours and shows its environment in `ps eww`) inherits them.
if [[ -n "${R12_BATCH_MLFLOW_PW+x}" ]]; then export -n R12_BATCH_MLFLOW_PW; fi
if [[ -n "${R12_BATCH_PG_PW+x}" ]]; then export -n R12_BATCH_PG_PW; fi

say() { printf '%s\n' "$*"; }
hr() { say "------------------------------------------------------------------------------"; }
die() { say "STOP (precondition): $*" >&2; exit 1; }
need() { local c; for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die "'$c' is not on PATH"; done; }
need_tty() { [[ -t 0 ]] || die "this step reads secrets or confirmations at a prompt: run it in a real terminal (not through a tool's non-interactive shell)"; }

# env_get <NAME>: the value .env gives NAME, read by sourcing .env in a clean child shell (the same
# parse load_env uses: quotes, escapes and comments as bash reads them). Only that one value comes
# back, on stdout; the file path and the name are the only arguments, never a value. Prints nothing
# when .env or the name is missing.
env_get() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
  [[ -f "${REPO}/.env" ]] || return 0
  # shellcheck disable=SC2016  # $1/$2 expand in the child shell, by design
  env -i HOME="${HOME}" PATH="${PATH}" bash -c 'set -a; source "$1" >/dev/null 2>&1; printf "%s" "${!2:-}"' _ "${REPO}/.env" "$1"
}

# live_target: sets LIVE_PROJECT, LIVE_REGION and LIVE_PROFILE (rules in the header). Returns 1 with
# the reason on stderr; load_env and refresh-login.sh stop on it.
LIVE_PROJECT="" LIVE_REGION="" LIVE_PROFILE=""
live_target() {
  local f="${REPO}/.nip-targets/${LIVE_STAGE}" p="" r="" rest=""
  if [[ -f "${f}" ]]; then
    read -r p r rest < "${f}" || true
    if [[ ! "${p}" =~ ^project-[a-z0-9]+$ || ! "${r}" =~ ^[a-z]+-[a-z]+[0-9]+$ || -n "${rest}" ]]; then
      say "the stage binding ${f} is not '<project id> <region>' on one line (scripts/bootstrap-backend.sh writes it)" >&2; return 1
    fi
    if [[ -n "${_LIVE_CALLER_PROJECT}" && "${_LIVE_CALLER_PROJECT}" != "${p}" ]]; then
      say "note: NEBIUS_PROJECT_ID in your shell is not the ${LIVE_STAGE} project; using the stage binding .nip-targets/${LIVE_STAGE}" >&2
    fi
  else
    p="${_LIVE_CALLER_PROJECT}" r="${_LIVE_CALLER_REGION}"
    if [[ -z "${p}" || -z "${r}" ]]; then
      say "no target: ${f} does not exist (the first bootstrap of the ${LIVE_STAGE} stage writes it) and NEBIUS_PROJECT_ID / NEBIUS_REGION are not exported. Export the ${LIVE_STAGE} project and region, then rerun" >&2
      return 1
    fi
    [[ "${p}" =~ ^project-[a-z0-9]+$ ]] || { say "NEBIUS_PROJECT_ID '${p}' does not look like a project id (project-...)" >&2; return 1; }
  fi
  LIVE_PROFILE="${_LIVE_CALLER_PROFILE:-$(env_get NEBIUS_PROFILE)}"
  [[ -n "${LIVE_PROFILE}" ]] || { say "no CLI profile: set NEBIUS_PROFILE in .env (or export it): the TTL jobs' token is that profile's cached token" >&2; return 1; }
  LIVE_PROJECT="${p}" LIVE_REGION="${r}"
}

# step_init <id>: cd to the repo, log everything to logs/<id>-<UTC>.log, report failures on exit.
STEP_ID="" LOG="" FAIL_HINT=""
# State and logs must live somewhere persistent: macOS clears /private/tmp on reboot and prunes old
# files there, and abort.sh's inputs, state/ (labels, APPLIED_*, secret ids) and logs/ must survive a
# 4-6 h session. A checkout under a temporary directory (a scratch worktree) is refused.
live_dir_check() {
  case "${LIVE_HOME}/" in
    /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*)
      local msg="the session state folder ${LIVE_HOME} is under a temporary directory that macOS clears: run the session from a checkout outside /tmp"
      if [[ "${1}" == abort || "${LIVE_ALLOW_TMP:-0}" == 1 ]]; then say "WARNING: ${msg}" >&2; else die "${msg} (LIVE_ALLOW_TMP=1 overrides)"; fi ;;
  esac
}
step_init() {
  STEP_ID="$1"
  live_dir_check "${STEP_ID}"
  [[ -f "${REPO}/Makefile" ]] || die "no repository at ${REPO}"
  mkdir -p "${STATE_DIR}" "${LOG_DIR}"; chmod 700 "${LIVE_HOME}" "${STATE_DIR}" "${LOG_DIR}"
  LOG="${LOG_DIR}/${STEP_ID}-$(date -u +%Y%m%dT%H%M%SZ).log"
  cd "${REPO}"
  docker_ssh_env
  exec > >(tee -a "${LOG}") 2>&1
  TEE_PID=$!
  trap '_on_exit $?' EXIT
}
_on_exit() {
  local rc="$1"
  (( rc == 0 )) || _fail_report "${rc}"
  _flush_tee
}
# _flush_tee: close this step's output and wait (5 s at most) for tee to write it. Without it, a
# session leader that exits under a terminal (Termius, a pty) can hang the tty up before tee has
# printed the last lines, and the RESULT block loses its VERDICT.
TEE_PID=""
_flush_tee() {
  [[ -n "${TEE_PID}" ]] || return 0
  exec >&- 2>&-
  local i
  for (( i = 0; i < 100; i++ )); do kill -0 "${TEE_PID}" 2>/dev/null || return 0; sleep 0.05; done
}
_fail_report() {
  local rc="$1" ctx
  sleep 1   # let tee catch up, then take the context BEFORE this block is printed
  ctx="$(tail -n 40 "${LOG}" 2>/dev/null | grep -v '^=== RESULT' || true)"
  hr
  say "=== RESULT (paste back everything from here down)"
  say "step ${STEP_ID}: FAILED (exit ${rc}) at $(date -u +%FT%TZ)"
  say "VERDICT: FAIL"
  [[ -n "${FAIL_HINT}" ]] && say "state: ${FAIL_HINT}"
  _roots_report
  say "log: ${LOG}"
  say "--- last 40 log lines before the failure"
  printf '%s\n' "${ctx}"
}
# _roots_report: on every failed step, what bills and what guards it, from the pid files and
# state/*.env (read in a subshell; nothing here may stop the report).
_roots_report() {
  ( set +e +u +o pipefail
    state_load run2; state_load run3
    say "--- roots and TTL jobs at the failure"
    say "  applied by this session: data=${APPLIED_DATA:-no} ml-services=${APPLIED_ML:-no} inference=${APPLIED_R1:-no} gpu-vm=$([[ -n "${R3_APPLY_AT:-}" ]] && echo yes || echo no)"
    for s in inference ml-services data gpu-vm; do say "  ${s}: TTL job $(ttl_status "${s}" 2>/dev/null || echo 'unknown')"; done
    say "  R1_EXP=${R1_EXP:-unset}  LATE=${LATE:-unset} (STEP_2D_DONE=${STEP_2D_DONE:-0})  R3_EXP=${R3_EXP:-unset}"
    say "  Applied roots bill until bash ${LIVE_DIR}/run2-10-teardown.sh (run 2), bash ${LIVE_DIR}/run3-5-teardown.sh (run 3) or bash ${LIVE_DIR}/abort.sh" ) || true
}

# header <title> <what> <cost> <duration> <paste-back>
header() {
  hr
  say "STEP     $1"
  say "WHAT     $2"
  say "COST     $3"
  say "TIME     $4"
  say "RUN AS   executed: bash ${LIVE_DIR}/${STEP_ID}.sh  (self-contained; re-sources .env and the bootstrap itself)"
  say "TARGET   ${LIVE_STAGE}: project and region from $([[ -f "${REPO}/.nip-targets/${LIVE_STAGE}" ]] && echo ".nip-targets/${LIVE_STAGE}" || echo 'NEBIUS_PROJECT_ID / NEBIUS_REGION')"
  say "SEND     $5"
  say "LOG      ${LOG}"
  if [[ "${ASSUME_YES}" == 1 ]]; then
    hr
    say "!!! ASSUME_YES=1 IS SET: every 'yes' prompt of this step (destroy and apply confirmations, and"
    say "!!! abort.sh's ABORT prompt) is answered for you. If you did not mean that, press Ctrl-C now"
    say "!!! (5 s) and run: unset ASSUME_YES"
    hr
    sleep 5
  fi
  hr
}

# docker_ssh_env: over SSH (e.g. from a phone), Docker Desktop's credential helper ("credsStore":
# "desktop") needs the login keychain, which macOS will not unlock for a session without a screen
# ("keychain cannot be accessed ... does not allow user interaction"; seen live 2026-10-12). Every
# image these steps pull is public, so the client gets an EMPTY config (no credential helper, no
# stored auth) in state/docker-ssh and the Desktop socket explicitly. No-op outside SSH, or when
# the Desktop socket does not exist (e.g. a Linux host).
docker_ssh_env() {
  local sock="${HOME}/.docker/run/docker.sock"
  [[ -n "${SSH_CONNECTION:-}" && -S "${sock}" ]] || return 0
  export DOCKER_CONFIG="${STATE_DIR}/docker-ssh" DOCKER_HOST="unix://${sock}"
  { mkdir -p "${DOCKER_CONFIG}" && chmod 700 "${DOCKER_CONFIG}"; } || die "cannot create ${DOCKER_CONFIG}"
  printf '{}\n' > "${DOCKER_CONFIG}/config.json"
}
# result_begin: the paste-back block of a step that ran to its end; its status lines (and, where a
# step has one, its VERDICT line) say whether what it checked passed.
result_begin() { hr; say "=== RESULT (paste back everything from here down)"; say "step ${STEP_ID}: finished at $(date -u +%FT%TZ) (the verdict is the status lines below)"; }

# check_repo: the make targets and scripts these steps drive must exist in this checkout.
check_repo() {
  local t
  for t in preflight init plan plan-summary apply destroy-plan destroy ttl-teardown kubeconfig leftovers leftovers-stage; do
    grep -qE "^${t}:" "${REPO}/Makefile" || die "Makefile has no '${t}' target"
  done
  [[ -x "${REPO}/scripts/ttl-teardown.sh" && -f "${REPO}/scripts/bootstrap-backend.sh" ]] || die "scripts/ttl-teardown.sh or scripts/bootstrap-backend.sh missing"
}

# load_env: .env (mode 600, sourced, never piped), then the sandbox target (live_target).
load_env() {
  [[ -f "${REPO}/.env" ]] || die "${REPO}/.env missing"
  [[ "$(stat -c %a "${REPO}/.env" 2>/dev/null || stat -f %Lp "${REPO}/.env")" == 600 ]] || die ".env is not mode 600"
  live_target || die "no ${LIVE_STAGE} target (reason above)"
  set -a; set +u
  # shellcheck source=/dev/null
  source "${REPO}/.env"
  set -u; set +a
  local v
  for v in $(compgen -v TF_VAR_); do [[ -z "${!v}" ]] && unset "${v}"; done
  export NEBIUS_PROJECT_ID="${LIVE_PROJECT}" NEBIUS_REGION="${LIVE_REGION}" NEBIUS_PROFILE="${LIVE_PROFILE}"
  # Keys these steps read at silent prompts or from .env by name (env_get), never from the environment.
  unset NEBIUS_API_KEY BENCH_API_KEY R12_MLFLOW_ADMIN_PASSWORD R12_POSTGRESQL_PASSWORD
  # Credentials no step of runs 1-3 reads. Unset so they never reach a child process: the nohup TTL
  # jobs live for hours and `ps eww <pid>` shows their environment. .env's AWS_* go too: boot puts
  # the 1-day state key there. (recipes/observability reads PROMETHEUS_TOKEN from .env itself.)
  unset GITHUB_TOKEN HF_TOKEN AUTH_GITHUB_CLIENT_ID AUTH_GITHUB_CLIENT_SECRET PROMETHEUS_TOKEN \
    K8S_SANDBOX_INFERENCE_TOKEN TF_VAR_backups_password TF_VAR_transfer_source_secret_key \
    TF_VAR_transfer_destination_secret_key AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  for v in $(compgen -v NEBIUS_BILLING_EXPORT_); do unset "${v}"; done
  [[ -n "${NEBIUS_TENANT_ID:-}" ]] || die "NEBIUS_TENANT_ID is empty in .env"
}

# boot_try <stack>: source scripts/bootstrap-backend.sh sandbox <stack> (written for interactive
# shells, so errexit/nounset/pipefail are off while it runs), then check it targeted the sandbox
# project. Returns 1 with a message instead of exiting (abort.sh goes on with the next root).
boot_try() {
  local stack="$1" rc=0
  say ">>> source scripts/bootstrap-backend.sh ${LIVE_STAGE} ${stack}"
  set +e +u +o pipefail
  # shellcheck source=/dev/null
  source "${REPO}/scripts/bootstrap-backend.sh" "${LIVE_STAGE}" "${stack}"
  rc=$?
  set -euo pipefail
  (( rc == 0 )) || { say "bootstrap of ${LIVE_STAGE}/${stack} failed (rc ${rc}); read its message above" >&2; return 1; }
  [[ "${TF_VAR_parent_id:-}" == "${LIVE_PROJECT}" && "${TF_VAR_region:-}" == "${LIVE_REGION}" ]] \
    || { say "bootstrap did not target the ${LIVE_STAGE} project in ${LIVE_REGION}" >&2; return 1; }
  [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" && -n "${TF_VAR_iam_token:-}" ]] \
    || { say "bootstrap left no state key or IAM token" >&2; return 1; }
}
# boot <stack>: boot_try, and stop the step when it fails.
boot() { boot_try "$1" || die "bootstrap of ${LIVE_STAGE}/$1 did not complete (message above)"; }

# run <cmd...>: echo (to stderr, so `run cmd > file` keeps the echo out of the file), then run.
run() { say ">>> $*" >&2; "$@"; }

# confirm <question>: the owner types yes (ASSUME_YES=1 skips; only for re-runs already reviewed).
confirm() {
  [[ "${ASSUME_YES}" == 1 ]] && { say "(ASSUME_YES=1) $1 -> yes"; return 0; }
  need_tty
  local a; read -r -p "$1 Type yes to continue: " a
  [[ "${a}" == yes ]] || die "not confirmed: nothing was started by this prompt"
}

# r12_pw_problem <mlflow> <postgresql>: the ml-services stack's variable validations, checked before
# anything is created (step 2b, run2-all.sh). Prints which rule fails (never the value), returns 1.
r12_pw_problem() {
  local m="$1" p="$2"
  [[ ${#m} -ge 8 && ${#m} -le 64 && "$m" =~ [A-Z] && "$m" =~ [a-z] && "$m" =~ [0-9] && "$m" =~ [^A-Za-z0-9] ]] \
    || { say "MLflow password: 8-64 chars with upper, lower, digit and special character"; return 1; }
  [[ ${#p} -ge 8 && "$p" =~ [A-Z] && "$p" =~ [a-z] && "$p" =~ [^A-Za-z0-9] ]] \
    || { say "PostgreSQL password: 8+ chars with upper, lower and special character"; return 1; }
}

# ttl_cancel <stack>: verbatim from the plan ("Cancelling a TTL job"), the stage being ${LIVE_STAGE} (sandbox;
# the lab scripts set lab after sourcing this file). Must return 0.
ttl_cancel() { local f="terraform/live/${LIVE_STAGE}/$1/.terraform/ttl-teardown.pid" p; [[ -f "$f" ]] || return 0; p="$(cat "$f")"; ps -p "$p" -o command= | grep -q ttl-teardown || return 0; kill "$p"; sleep 1; ! ps -p "$p" >/dev/null || { echo "TTL job $p for $1 still running" >&2; return 1; }; }

# ttl_running <stack>: 0 when the root's recorded TTL job is alive.
ttl_running() { local f="terraform/live/${LIVE_STAGE}/$1/.terraform/ttl-teardown.pid" p; [[ -f "$f" ]] || return 1; p="$(cat "$f")"; ps -p "$p" -o command= 2>/dev/null | grep -q ttl-teardown; }

# --- IAM token lifetime of the TTL jobs ---------------------------------------------------------
# A TTL job inherits TF_VAR_iam_token from scripts/bootstrap-backend.sh, which takes the CLI's
# CACHED token (`nebius iam get-access-token`; ~/.nebius/credentials.yaml keeps one expires_at per
# entry), so it can already be hours old. Neither the job nor terraform/tf-run.sh ever refreshes it:
# a job firing after it expires fails at destroy-plan and exits quietly. An access token is valid for
# 12 hours (https://docs.nebius.com/iam/authorization/access-tokens; mirror:
# .cache/nebius-docs/iam/authorization/access-tokens.md); how the CLI's cache refreshes it is unknown.
# iam_token_expiry: prints the epoch at which the cached federation token of LIVE_PROFILE expires
# (the earliest, if several entries name the profile). Reads that entry's expires_at field only,
# line by line: the token value is never parsed into a variable or printed. Returns 1 when the file,
# the entry or the field is missing.
NEBIUS_CREDS="${HOME}/.nebius/credentials.yaml"
iam_token_expiry() {
  [[ -f "${NEBIUS_CREDS}" && -n "${LIVE_PROFILE}" ]] || return 1
  python3 -I - "${NEBIUS_CREDS}" "${LIVE_PROFILE}" <<'PY'
import datetime, re, sys
path, prof = sys.argv[1], sys.argv[2]
ind, found = None, []
for raw in open(path, encoding="utf-8"):
    line = raw.rstrip("\n")
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    lead = len(line) - len(line.lstrip())
    m = re.match(r"^\s*(\S.*?):(?:\s+(.*))?$", line)
    if not m:
        continue
    key = m.group(1).strip().strip("\"'")
    if ind is not None and lead <= ind:
        ind = None
    if ind is None:
        if key.startswith("federation/") and key.endswith("/" + prof) and not (m.group(2) or "").strip():
            ind = lead
        continue
    if key == "expires_at":
        v = (m.group(2) or "").strip().strip("\"'")
        try:
            found.append(int(v) if v.isdigit() else int(datetime.datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()))
        except ValueError:
            pass
if not found:
    sys.exit(1)
print(min(found))
PY
}
# token_guard <fire epoch> <what>: refuse (die) unless the cached token lives until the TTL time
# + 60 min (the destroy's own runtime). Sets TOKEN_EXP (UTC) for the RESULT lines.
TOKEN_EXP=""
token_guard() {
  local fire="$1" what="$2" exp need
  exp="$(iam_token_expiry)" || die "cannot read the expires_at of the ${LIVE_PROFILE} federation token in ${NEBIUS_CREDS}: ${what} would inherit a token of unknown lifetime. Refresh the login (bash ${LIVE_DIR}/refresh-login.sh), then rerun bash ${LIVE_DIR}/${STEP_ID}.sh"
  TOKEN_EXP="$(nip_utc "${exp}")"
  need=$(( fire + 3600 ))
  say "IAM token (CLI cache, profile ${LIVE_PROFILE}) expires ${TOKEN_EXP}; ${what} fires at $(nip_utc "${fire}") and needs it until $(nip_utc "${need}")"
  (( exp >= need )) || die "the IAM token ${what} would inherit expires at ${TOKEN_EXP}, before $(nip_utc "${need}") (TTL time + 60 min for the destroy): the job would fail at destroy-plan and leave the root billing. No TTL job was cancelled. Refresh the CLI login: bash ${LIVE_DIR}/refresh-login.sh (this CLI has no logout verb; it drops only the cached ${LIVE_PROFILE} token and logs in again), then rerun bash ${LIVE_DIR}/${STEP_ID}.sh (the re-sourced bootstrap hands the new job the fresh token)"
}
# ttl_fire_at <stack> [make args...]: the time scripts/ttl-teardown.sh will fire at: TTL=, else the
# root's .run-profile.tfvars.json label, else TF_VAR_labels' nip-ttl-expires.
ttl_fire_at() {
  local stack="$1" a t=""; shift
  for a in "$@"; do case "${a}" in TTL=*) t="${a#TTL=}" ;; esac; done
  [[ -n "${t}" ]] || t="$(jq -r '.labels["nip-ttl-expires"] // empty' "terraform/live/${LIVE_STAGE}/${stack}/.run-profile.tfvars.json" 2>/dev/null || true)"
  [[ -n "${t}" ]] || t="$(jq -r '.["nip-ttl-expires"] // empty' <<<"${TF_VAR_labels:-null}" 2>/dev/null || true)"
  printf '%s' "${t}"
}
# ttl_record <stack> <fire time>: state/ttl.env keeps, per stack, the pid armed by these scripts, its
# fire time and its token's expiry, for ttl_status.
ttl_record() {
  local k="${1//-/_}"
  state_set ttl "TTL_PID_${k}" "$(cat "terraform/live/${LIVE_STAGE}/$1/.terraform/ttl-teardown.pid")"
  state_set ttl "TTL_AT_${k}" "$2"
  state_set ttl "TTL_TOKEN_${k}" "${TOKEN_EXP}"
}
# ttl_status <stack>: one line for RESULT blocks: "running pid X, fires T, IAM token expires E" or
# "NOT RUNNING". Fire/token are shown only when state/ttl.env recorded that same pid.
ttl_status() {
  ( local s="$1" k="${1//-/_}" f p pv av tv
    f="${REPO}/terraform/live/${LIVE_STAGE}/$1/.terraform/ttl-teardown.pid"
    p="$(cat "${f}" 2>/dev/null || true)"
    if [[ -z "${p}" ]] || ! ps -p "${p}" -o command= 2>/dev/null | grep -q ttl-teardown; then printf 'NOT RUNNING'; exit 0; fi
    state_load ttl
    pv="TTL_PID_${k}"; av="TTL_AT_${k}"; tv="TTL_TOKEN_${k}"
    printf 'running pid %s' "${p}"
    if [[ "${!pv:-}" == "${p}" ]]; then
      printf ', fires %s, IAM token expires %s' "${!av:-?}" "${!tv:-?}"
      if [[ -n "${!av:-}" && -n "${!tv:-}" ]] && (( $(nip_epoch "${!tv}") < $(nip_epoch "${!av}") + 3600 )); then
        printf ' (TOKEN EXPIRES BEFORE THE TEARDOWN ENDS: re-arm %s after bash %s/refresh-login.sh)' "${s}" "${LIVE_DIR}"
      fi
    else
      printf ' (fire time and token not recorded by these scripts)'
    fi )
}

# ttl_arm <stack> [make args...]: the plan's order: DRY=1, token check, ttl_cancel, CONFIRM=yes.
# Between the cancel and a running new job, FAIL_HINT names the stack left without a TTL job.
ttl_arm() {
  local stack="$1" at; shift
  at="$(ttl_fire_at "${stack}" "$@")"
  [[ "${at}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || die "cannot tell when the ${stack} TTL job would fire (got '${at}')"
  run make ttl-teardown STAGE="${LIVE_STAGE}" STACK="${stack}" "$@" DRY=1
  token_guard "$(nip_epoch "${at}")" "the ${stack} TTL job"
  FAIL_HINT="${stack} TTL job CANCELLED, not re-armed: rerun this step now (bash ${LIVE_DIR}/${STEP_ID}.sh), or bash ${LIVE_DIR}/abort.sh"
  ttl_cancel "${stack}" || die "ttl_cancel ${stack} did not return 0"
  run make ttl-teardown STAGE="${LIVE_STAGE}" STACK="${stack}" "$@" CONFIRM=yes
  ttl_running "${stack}" || die "TTL job for ${stack} is not running after arming"
  FAIL_HINT=""
  ttl_record "${stack}" "${at}"
  say "TTL job for ${stack}: $(ttl_status "${stack}")"
}

# Session state (non-secret: run ticket, labels, prices, secret ids) in state/<name>.env.
state_set() {
  local f="${STATE_DIR}/$1.env" k="$2" v="$3" tmp
  touch "${f}"; chmod 600 "${f}"
  tmp="$(mktemp "${STATE_DIR}/.tmp.XXXXXX")"
  grep -v "^${k}=" "${f}" > "${tmp}" || true
  printf '%s=%q\n' "${k}" "${v}" >> "${tmp}"
  mv "${tmp}" "${f}"; chmod 600 "${f}"
}
state_load() {
  local f="${STATE_DIR}/$1.env"
  # shellcheck source=/dev/null
  [[ -f "${f}" ]] && source "${f}"
  return 0
}

# UTC helpers (macOS date reads -f times as local unless TZ=UTC: the repo's lib-time.sh).
[[ -f "${REPO}/scripts/lib-time.sh" ]] || { echo "STOP (precondition): no repository at ${REPO} (scripts/lib-time.sh missing)" >&2; exit 1; }
# shellcheck source=/dev/null
source "${REPO}/scripts/lib-time.sh"
utc_plus_min() { nip_utc $(( $(nip_now) + $1 * 60 )); }
add_30min() { # the plan's step 2d expression, macOS first, GNU fallback
  if date -u -d @0 >/dev/null 2>&1; then date -u -d "$1 30 min" +%Y-%m-%dT%H:%M:%SZ
  else TZ=UTC date -j -v+30M -f %Y-%m-%dT%H:%M:%SZ "$1" +%Y-%m-%dT%H:%M:%SZ; fi
}

run_ticket_ok() { [[ "$1" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; }

# root_state <stack>: prints "has" (the initialised root lists at least one resource) or "empty".
# Returns 1 and prints nothing when the state cannot be read (backend, network or credential
# error): that is NOT an empty state, so no caller may skip a destroy or cancel a TTL job on it.
root_state() {
  local out
  out="$(terraform -chdir="terraform/live/${LIVE_STAGE}/$1" state list)" \
    || { say "cannot read the state of sandbox/$1 (terraform state list failed; message above)" >&2; return 1; }
  if [[ -n "${out}" ]]; then echo has; else echo empty; fi
}
# root_has_state <stack>: 0 = has resources, 1 = verified empty; stops the step when unreadable.
root_has_state() {
  local st
  st="$(root_state "$1")" || die "cannot read the state of sandbox/$1: not treating it as empty (no destroy skipped, its TTL job left as it is)"
  [[ "${st}" == has ]]
}

# preflight_go <make args...>: make preflight must exit 0 and print GO.
preflight_go() {
  local out rc=0
  out="$(mktemp)"
  say ">>> make preflight $*"
  make preflight "$@" 2>&1 | tee "${out}" || rc=$?
  if ! grep -qE '^Preflight .*: GO' "${out}" || (( rc != 0 )); then rm -f "${out}"; die "preflight $* is not GO"; fi
  # shellcheck disable=SC2034  # read by the step scripts
  PREFLIGHT_LINE="$(grep -E '^Preflight ' "${out}" | tail -1)"; rm -f "${out}"
}

# session_mode: the session's mode from state/run2.env, set by step 0: "run2" (R8 + R12 + R1, the
# default) or "r1-only" (run-r1.sh / R1_ONLY=1: R1 alone with its own filestore). Read in a subshell;
# an unknown value stops the step.
session_mode() {
  ( state_load run2
    case "${SESSION_MODE:-run2}" in
      run2|r1-only) printf '%s\n' "${SESSION_MODE:-run2}" ;;
      *) die "unknown SESSION_MODE '${SESSION_MODE}' in ${STATE_DIR}/run2.env (run2 or r1-only)" ;;
    esac ) || exit 1
}
# The R14 data-source token Secret in the o11y namespace (key PROMETHEUS_TOKEN): step 2c names it in
# TF_VAR_grafana_datasource_token_secret before the plan, step 6 creates it from .env's PROMETHEUS_TOKEN
# (runbooks/observability.md "In-cluster Grafana").
# shellcheck disable=SC2034  # read by the step scripts
R14_TOKEN_SECRET=grafana-nebius-token

# require_2d: every run-2 step after 2d. Step 2d must have re-armed data/ml-services at LATE for
# R1's CURRENT plan (a rerun of 2c moves R1's TTL and sets STEP_2D_DONE=0), and LATE must be at
# least R1_EXP + 30 min; else those jobs can fire before R1's and delete the filesystem or node SA
# under the live cluster. Reads state/run2.env in a subshell (the caller's variables are untouched).
require_2d() {
  ( state_load run2
    local r1now
    # An R1-only session (run-r1.sh) applies no data or ml-services root: nothing can be deleted
    # under the cluster, so there is no step 2d; R1 itself must be applied.
    if [[ "${SESSION_MODE:-}" == r1-only ]]; then
      [[ -n "${APPLIED_R1:-}" ]] || die "R1 is not applied in this R1-only session: run bash ${LIVE_DIR}/run2-2c-inference.sh first"
      exit 0
    fi
    [[ "${STEP_2D_DONE:-0}" == 1 && -n "${LATE:-}" && -n "${R1_EXP:-}" ]] \
      || die "step 2d has not re-armed data/ml-services for R1's current plan (STEP_2D_DONE=${STEP_2D_DONE:-0}): run bash ${LIVE_DIR}/run2-2d-rearm.sh first; until then their TTL jobs can fire before R1's and delete the filesystem or node SA under the live cluster"
    r1now="$(jq -r '.labels["nip-ttl-expires"] // empty' "${REPO}/terraform/live/sandbox/inference/.run-profile.tfvars.json" 2>/dev/null || true)"
    [[ -z "${r1now}" || "${r1now}" == "${R1_EXP}" ]] || die "R1 was re-planned (expiry ${r1now}; step 2d used ${R1_EXP}): run bash ${LIVE_DIR}/run2-2d-rearm.sh again"
    (( $(nip_epoch "${LATE}") >= $(nip_epoch "${R1_EXP}") + 1800 )) || die "LATE ${LATE} is earlier than R1_EXP ${R1_EXP} + 30 min: run bash ${LIVE_DIR}/run2-2d-rearm.sh again"
  ) || exit 1
}

# kube_env [readonly]: the R1 kubeconfig written by `make kubeconfig` (never ~/.kube/config),
# checked. Every caller but a read-only watcher (arg readonly) also passes require_2d.
kube_env() {
  [[ "${1:-}" == readonly ]] || require_2d
  export KUBECONFIG="${REPO}/${KCFG_REL}"
  [[ -f "${KUBECONFIG}" ]] || die "${KCFG_REL} missing: run run2-3a-validate-gpu.sh (make kubeconfig) first"
  local ctx
  ctx="$(kubectl config view --minify -o jsonpath='{.contexts[0].name} {.contexts[0].context.cluster}')"
  [[ "${ctx}" == *nip-sandbox-inference* ]] || die "kubeconfig context '${ctx}' does not name the nip-sandbox-inference cluster"
  kubectl --request-timeout=30s get nodes >/dev/null || die "cannot reach the nip-sandbox-inference API with ${KCFG_REL}"
}

# headroom: the GPU node's Allocatable minus the requests of its non-terminated pods must leave
# the bench Job's requests (cpu 2, memory 4Gi; tests/load/bench-job.yaml). Prints the plan's
# describe excerpt for the evidence. Exit 0 when it fits.
headroom() {
  say ">>> kubectl describe node -l nip.nebius.io/gpu=true | sed -n '/Allocatable/,/Events/p'"
  kubectl describe node -l nip.nebius.io/gpu=true | sed -n '/Allocatable/,/Events/p'
  local node nj pj hr_rc=0
  node="$(kubectl get node -l nip.nebius.io/gpu=true -o jsonpath='{.items[0].metadata.name}')"
  [[ -n "${node}" ]] || die "no node labelled nip.nebius.io/gpu=true"
  nj="$(mktemp)"; pj="$(mktemp)"
  kubectl get node "${node}" -o json > "${nj}"
  kubectl get pods -A --field-selector "spec.nodeName=${node}" -o json > "${pj}"
  python3 - "${nj}" "${pj}" <<'PY' || hr_rc=$?
import json, sys
def cpu(q):
    q = str(q)
    return float(q[:-1]) / 1000 if q.endswith("m") else float(q)
U = {"Ki": 2**10, "Mi": 2**20, "Gi": 2**30, "Ti": 2**40, "K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12, "k": 1e3}
def mem(q):
    q = str(q)
    for s in ("Ki", "Mi", "Gi", "Ti", "K", "M", "G", "T", "k"):
        if q.endswith(s):
            return float(q[: -len(s)]) * U[s]
    return float(q)
node, pods = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
alloc = node["status"]["allocatable"]
ac, am = cpu(alloc["cpu"]), mem(alloc["memory"])
rc = rm = 0.0
for p in pods["items"]:
    if p["status"].get("phase") in ("Succeeded", "Failed"):
        continue
    s = p["spec"]
    def tot(cs, f, k):
        return sum(f(c.get("resources", {}).get("requests", {}).get(k, 0)) for c in cs)
    c = max(tot(s.get("containers", []), cpu, "cpu"), max([cpu(i.get("resources", {}).get("requests", {}).get("cpu", 0)) for i in s.get("initContainers", [])] or [0]))
    m = max(tot(s.get("containers", []), mem, "memory"), max([mem(i.get("resources", {}).get("requests", {}).get("memory", 0)) for i in s.get("initContainers", [])] or [0]))
    o = s.get("overhead") or {}
    rc += c + cpu(o.get("cpu", 0)); rm += m + mem(o.get("memory", 0))
fc, fm = ac - rc, am - rm
ok = fc >= 2 and fm >= 4 * 2**30
print(f"HEADROOM node={node['metadata']['name']} allocatable cpu={ac:.2f} mem={am/2**30:.2f}Gi requested cpu={rc:.2f} mem={rm/2**30:.2f}Gi free cpu={fc:.2f} mem={fm/2**30:.2f}Gi need cpu>=2 mem>=4Gi -> {'OK' if ok else 'SHORT'}")
sys.exit(0 if ok else 1)
PY
  rm -f "${nj}" "${pj}"
  return "${hr_rc}"
}

# watch_bench <namespace> <pid>: the plan's Pending rule for the bench Job. While <pid> runs, a pod
# Pending for about 2 min with Insufficient cpu/memory stops it (the plan's Ctrl-C) and deletes the
# Job. Returns 0 when <pid> ended by itself, 3 when it was stopped for capacity. (SIGTERM, not
# SIGINT: a non-interactive bash starts background jobs with SIGINT ignored.)
watch_bench() {
  local ns="$1" pid="$2" pending=0 phase why
  while kill -0 "${pid}" 2>/dev/null; do
    sleep 15
    phase="$(kubectl -n "${ns}" get pod -l job-name=vllm-bench -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)"
    if [[ "${phase}" == Pending ]]; then
      pending=$(( pending + 15 ))
      if (( pending >= 120 )); then
        why="$(kubectl -n "${ns}" describe pod -l job-name=vllm-bench 2>/dev/null | grep -E 'Insufficient (cpu|memory)' | head -3 || true)"
        if [[ -n "${why}" ]]; then
          say "bench pod Pending for ${pending}s: ${why}"
          kill "${pid}" 2>/dev/null || true; sleep 5
          run kubectl -n "${ns}" delete job vllm-bench --ignore-not-found
          return 3
        fi
      fi
    else
      pending=0
    fi
  done
  return 0
}

bench_summary() { # <results json>
  jq -r '"status=\(.status)",
    (.details.points[]? | "c=\(.concurrency) tok/s=\(.output_tokens_per_s) ttft_ms p50/p99=\(.ttft_ms.p50)/\(.ttft_ms.p99) tpot_ms=\(.tpot_ms.p50)/\(.tpot_ms.p99) e2e_ms=\(.e2e_ms.p50)/\(.e2e_ms.p99) usd_per_1m_out=\(.cost_per_1m_output_tokens_usd) pass=\(.pass)")' "$1"
}

# bench_guard <namespace> <pid> [extra trap command]: while a background bench runs (05-load.sh or
# endpoint.sh measure), make the EXIT path stop it. A non-interactive bash starts background jobs
# with SIGINT ignored, so a Ctrl-C would end this script but leave the bench polling and its
# vllm-bench Job running. <extra> (a step's own exit work) runs after the bench is stopped, so it
# cannot race the bench's result files. bench_unguard puts the
# step's plain EXIT trap (or <extra> + _on_exit) back once the bench has ended.
bench_guard() {
  local ns="$1" pid="$2" extra="${3:-}" ns_secret=""
  # endpoint.sh measure keeps the endpoint token in nip-bench/vllm-bench-key while it runs.
  [[ "${ns}" == nip-bench ]] && ns_secret="kubectl -n nip-bench delete secret vllm-bench-key --ignore-not-found >/dev/null 2>&1 || true; "
  # shellcheck disable=SC2064  # ns/pid/extra are fixed now, by design
  # Every command is `|| true`: errexit still applies inside an EXIT trap.
  trap "rc=\$?; pkill -TERM -P ${pid} 2>/dev/null || true; kill ${pid} 2>/dev/null || true; kubectl -n ${ns} delete job vllm-bench --ignore-not-found --wait=false >/dev/null 2>&1 || true; ${ns_secret}${extra:+${extra}; }_on_exit \$rc" EXIT
}
bench_unguard() {
  local extra="${1:-}"
  # shellcheck disable=SC2064
  trap "rc=\$?; ${extra:+${extra}; }_on_exit \$rc" EXIT
}

# registry_purge: delete every image in R12's Container Registry. A registry with images cannot be
# deleted ("If the registry contains images, the deletion fails": https://docs.nebius.com/container-registry/registries/manage,
# mirror .cache/nebius-docs/container-registry/registries/manage.md; runbooks/ml-services.md
# "Teardown" step 2), and step 5's ml-services.sh pushes
# REGISTRY_URL/nip-check@<digest>. Verbs from `nebius registry image --help` / `list --help` /
# `delete --help`: `list --parent-id <registry id> --all`, `delete --id <image id>`. Needs the
# ml-services root bootstrapped and initialised. Sets REGISTRY_NOTE; returns 1 if an image is left.
# The list's JSON shape is not in the docs mirror: on 2026-10-12 images carried a top-level .id (no
# .metadata), so both are read.
REGISTRY_NOTE=""
# shellcheck disable=SC2034  # REGISTRY_NOTE is read by the step scripts
registry_purge() {
  local rid out ids i n=0 left
  rid="$(terraform -chdir=terraform/live/sandbox/ml-services output -raw registry_id 2>/dev/null || true)"
  if [[ -z "${rid}" || "${rid}" == *[[:space:]]* ]]; then REGISTRY_NOTE="registry: no registry_id output, nothing to empty"; return 0; fi
  out="$(nebius --profile "${NEBIUS_PROFILE}" registry image list --parent-id "${rid}" --all --format json)" \
    || { REGISTRY_NOTE="registry ${rid}: IMAGE LIST FAILED (the ml-services destroy will fail on a non-empty registry)"; return 1; }
  [[ -n "${out}" ]] || out='{}'   # (not ${out:-{\}}: bash expands that to the literal {\})
  ids="$(jq -r '(.items // .images // [])[] | (.metadata.id // .id) // empty' <<<"${out}")"
  for i in ${ids}; do
    run nebius --profile "${NEBIUS_PROFILE}" registry image delete --id "${i}" \
      || { REGISTRY_NOTE="registry ${rid}: IMAGE DELETE FAILED (${i})"; return 1; }
    n=$(( n + 1 ))
  done
  out="$(nebius --profile "${NEBIUS_PROFILE}" registry image list --parent-id "${rid}" --all --format json)" \
    || { REGISTRY_NOTE="registry ${rid}: ${n} image(s) deleted, re-list FAILED"; return 1; }
  [[ -n "${out}" ]] || out='{}'
  left="$(jq -r '(.items // .images // []) | length' <<<"${out}")"
  REGISTRY_NOTE="registry ${rid}: ${n} image(s) deleted, ${left} listed after"
  [[ "${left}" == 0 ]]
}

# release_pvcs: with KUBECONFIG on a reachable R1 cluster, stop the workloads that hold block PVCs
# (scale every Deployment/StatefulSet of the namespace to 0) and delete the PVCs of every namespace
# but kube-system: inference (vLLM's model cache), o11y (Prometheus's compute-csi volume and, with
# TF_VAR_alertmanager_enabled=true, the Alertmanager StatefulSet's PVC that a Helm uninstall leaves
# behind), team namespaces. These are unlabelled and outlive `terraform destroy`
# (runbooks/teardown.md; terraform/modules/o11y/main.tf). Then waits up to 5 min for their PVs to go
# and lists what is left. Sets PVC_NOTE; returns 1 while a PV of those namespaces remains.
PVC_NOTE=""
# shellcheck disable=SC2034  # PVC_NOTE is read by the step scripts
release_pvcs() {
  local all nss ns left deadline
  all="$(kubectl get pvc -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"\n"}{end}')" \
    || { PVC_NOTE="PVCs: COULD NOT LIST (kubectl get pvc -A failed); none deleted"; return 1; }
  nss="$(printf '%s\n' "${all}" | sed '/^$/d' | sort -u | grep -vx kube-system || true)"
  if [[ -z "${nss}" ]]; then PVC_NOTE="PVCs: none in the cluster"; return 0; fi
  for ns in ${nss}; do
    run kubectl -n "${ns}" scale deployment,statefulset --all --replicas=0 || say "WARNING: could not scale the workloads of ${ns} to 0"
    run kubectl delete pvc --all -n "${ns}" --timeout=5m || say "WARNING: PVC delete in ${ns} did not finish"
  done
  deadline=$(( SECONDS + 300 ))
  while :; do
    left="$(kubectl get pv -o json | jq -r --arg nss "${nss}" '($nss | split("\n")) as $n
      | .items[] | select((.spec.claimRef.namespace // "") as $c | $n | index($c))
      | "\(.metadata.name) (\(.spec.claimRef.namespace)/\(.spec.claimRef.name), \(.status.phase), reclaim \(.spec.persistentVolumeReclaimPolicy))"')" || left="(kubectl get pv failed)"
    [[ -z "${left}" ]] && break
    (( SECONDS < deadline )) || break
    sleep 10
  done
  say ">>> kubectl get pv (check: no PV of ${nss//$'\n'/, } may remain)" >&2
  kubectl get pv || true
  if [[ -n "${left}" ]]; then
    PVC_NOTE="PVCs deleted in ${nss//$'\n'/ }; PVs STILL PRESENT after 5 min: ${left//$'\n'/; }"
    return 1
  fi
  PVC_NOTE="PVCs deleted in ${nss//$'\n'/ }; their PVs are gone"
}

# wait_mlflow_released [max s]: after an ml-services destroy, re-list until no artifact bucket shows
# "in use" (its MLflow cluster still being deleted), so the orphan check that follows sees it.
# Bounded (default 15 min); returns 1 when a bucket is still in use at the deadline.
wait_mlflow_released() {
  local deadline=$(( SECONDS + ${1:-900} )) inuse out
  while :; do
    if out="$(scripts/mlflow-artifacts.sh list)"; then inuse="$(grep -c 'in use' <<<"${out}" || true)"; else inuse="?"; fi
    [[ "${inuse}" == 0 ]] && return 0
    (( SECONDS < deadline )) || { say "WARNING: ${inuse} MLflow artifact bucket(s) still 'in use' (cluster still deleting?) after the wait" >&2; return 1; }
    say "an MLflow cluster still exists (${inuse} bucket(s) in use); re-checking in 30 s" >&2
    sleep 30
  done
}

# ttl_window <need-min> <what>: the provisional data/ml-services TTL jobs fire at the session label's
# nip-ttl-expires (EXP; Z5's own expiry when step 2a reused its data root, DATA_TTL_AT). Only step
# 2d moves them past R1. Refuse when fewer than <need-min> minutes are left before the earliest of
# them, so a job cannot fire during the remaining applies and delete the filesystem or node SA under
# a cluster being created. Needs LABELS (state_load run2). After step 2d (STEP_2D_DONE=1) the jobs
# fire at LATE instead.
ttl_window() {
  local need="$1" what="$2" at left
  if [[ "${STEP_2D_DONE:-0}" == 1 && -n "${LATE:-}" ]]; then at="${LATE}"
  else
    at="$(jq -r '.["nip-ttl-expires"]' <<<"${LABELS}")"
    if [[ -n "${DATA_TTL_AT:-}" ]] && (( $(nip_epoch "${DATA_TTL_AT}") < $(nip_epoch "${at}") )); then at="${DATA_TTL_AT}"; fi
  fi
  left=$(( ( $(nip_epoch "${at}") - $(nip_now) ) / 60 ))
  say "provisional data/ml-services TTL jobs fire at ${at}: ${left} min from now (${what} needs >= ${need} min)"
  (( left >= need )) && return 0
  if [[ -z "${APPLIED_DATA:-}${APPLIED_ML:-}${APPLIED_R1:-}" ]]; then
    die "only ${left} min before the data/ml-services TTL time ${at}; ${what} needs ${need}. Nothing is applied yet: rerun RESET_LABELS=1 bash ${LIVE_DIR}/run2-0-preflight.sh, then this step"
  elif [[ -n "${APPLIED_R1:-}" ]]; then
    die "only ${left} min before the data/ml-services TTL time ${at}; ${what} needs ${need}. R1 is applied: run bash ${LIVE_DIR}/run2-2d-rearm.sh NOW (it moves them to R1 + 30 min), then decide"
  else
    die "only ${left} min before the data/ml-services TTL time ${at}; ${what} needs ${need}, so a TTL job would fire before step 2d. Tear down (bash ${LIVE_DIR}/run2-10-teardown.sh or abort.sh), then RESET_SESSION=1 bash ${LIVE_DIR}/run2-0-preflight.sh"
  fi
}

# root_busy <stack>: prints why and returns 0 while something else may be writing the root right
# now: a terraform process on it (another terminal's apply, or its TTL job's destroy), or a live
# step script that applies or re-arms it. Its state can read empty in the first moments of an
# apply, so abort.sh must neither cancel its TTL job nor delete what that apply needs.
root_busy() {
  local s="$1" p scripts=""
  p="$(pgrep -f "terraform -chdir=terraform/live/sandbox/${s}( |/|$)" 2>/dev/null | tr '\n' ' ' || true)"
  [[ -n "${p// /}" ]] && { echo "terraform running on it (pid ${p% })"; return 0; }
  case "${s}" in
    data) scripts="run2-2a-data.sh run2-2d-rearm.sh" ;;
    ml-services) scripts="run2-2b-ml-services.sh run2-2d-rearm.sh" ;;
    inference) scripts="run2-2c-inference.sh" ;;
    gpu-vm) scripts="run3-3-apply.sh" ;;
  esac
  for p in ${scripts}; do
    pgrep -f "bash .*${p}" >/dev/null 2>&1 && { echo "${p} is running in another terminal"; return 0; }
  done
  return 1
}

# state_lock <stack>: after its bootstrap (state key in AWS_*), HEADs the root's S3 lock object
# (<key>.tflock, use_lockfile = true) with curl's SigV4; the key goes to curl through a config file
# descriptor, never argv. Prints held | free | unknown(<http code>).
state_lock() {
  local hcl="terraform/live/${LIVE_STAGE}/$1/backend.hcl" bucket key region ep code
  [[ -f "${hcl}" ]] || { echo "unknown(no backend.hcl)"; return 0; }
  bucket="$(sed -n 's/^bucket *= *"\(.*\)"/\1/p' "${hcl}")"; key="$(sed -n 's/^key *= *"\(.*\)"/\1/p' "${hcl}")"
  region="$(sed -n 's/^region *= *"\(.*\)"/\1/p' "${hcl}")"; ep="$(sed -n 's/^ *s3 *= *"\(.*\)"/\1/p' "${hcl}")"
  [[ -n "${bucket}" && -n "${key}" && -n "${region}" && -n "${ep}" && -n "${AWS_ACCESS_KEY_ID:-}" ]] || { echo "unknown(no backend or key)"; return 0; }
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 -I --aws-sigv4 "aws:amz:${region}:s3" \
    -K <(printf 'user = "%s:%s"\n' "${AWS_ACCESS_KEY_ID}" "${AWS_SECRET_ACCESS_KEY}") \
    "${ep%/}/${bucket}/${key}.tflock" 2>/dev/null || true)"
  case "${code}" in 200) echo held ;; 404) echo free ;; *) echo "unknown(${code:-none})" ;; esac
}

# r6_endpoint_left: R6 (run2-8) has no TTL job and make leftovers does not list AI endpoints. Prints
# what is left (the endpoint of results/serverless-endpoint.state unless get says NotFound, and/or
# the id found by name in the sandbox) and returns 0 when something is; 1 when nothing; 2 (printing
# why) when the by-name check failed. A stale state file is archived (r6_state_probe) and reported on stderr.
# r6_state_probe: is the endpoint named in results/serverless-endpoint.state still there? That file
# can go stale: endpoint.sh delete removes the endpoint and only then the file, so a Ctrl-C or a
# timeout in between leaves it. `nebius ai endpoint get --id <ENDPOINT_ID>`:
#   NotFound      -> the file is stale: moved to state/archive/, prints why, returns 3;
#   success       -> prints "endpoint <id> exists", returns 0;
#   other error   -> prints the error, returns 0 (cannot be ruled out: treated as still there);
#   no state file -> prints nothing, returns 1.
R6_STATE=results/serverless-endpoint.state
r6_state_probe() {
  local id err msg dst
  [[ -f "${R6_STATE}" ]] || return 1
  id="$(sed -n 's/^ENDPOINT_ID=//p' "${R6_STATE}" | head -n 1)"
  [[ -n "${id}" ]] || { echo "${R6_STATE} exists but names no ENDPOINT_ID (treated as an endpoint left)"; return 0; }
  err="$(mktemp)"
  if nebius --profile "${NEBIUS_PROFILE}" ai endpoint get --id "${id}" --format json >/dev/null 2>"${err}"; then
    rm -f "${err}"; echo "${R6_STATE}: endpoint ${id} exists"; return 0
  fi
  if grep -qiE 'not ?found|does not exist' "${err}"; then
    rm -f "${err}"
    mkdir -p "${STATE_DIR}/archive"; chmod 700 "${STATE_DIR}/archive"
    dst="${STATE_DIR}/archive/serverless-endpoint.state.$(date -u +%Y%m%dT%H%M%SZ)"
    if mv "${R6_STATE}" "${dst}"; then
      echo "stale state file, endpoint gone: ${R6_STATE} named ${id}, which get reports NotFound; moved to ${dst}"
    else
      echo "stale state file, endpoint gone: ${R6_STATE} named ${id} (NotFound) but could not be moved: mv ${REPO}/${R6_STATE} ${STATE_DIR}/archive/"
    fi
    return 3
  fi
  msg="$(head -n 2 "${err}" | tr '\n' ' ')"; rm -f "${err}"
  echo "${R6_STATE} names endpoint ${id}; get failed (${msg}), so it is treated as still there"
  return 0
}

r6_endpoint_left() {
  local name="${ENDPOINT_NAME:-nip-vllm-compare}" out err id found="" prc=0 pmsg
  pmsg="$(r6_state_probe)" || prc=$?
  case "${prc}" in
    0) found="${pmsg}" ;;
    3) say "${pmsg}" >&2 ;;
  esac
  err="$(mktemp)"
  if out="$(nebius --profile "${NEBIUS_PROFILE}" ai endpoint get-by-name --name "${name}" --parent-id "${NEBIUS_PROJECT_ID}" --format json 2>"${err}")"; then
    id="$(jq -r '.metadata.id // empty' <<<"${out:-null}" 2>/dev/null || true)"
    [[ -n "${id}" ]] && found="${found:+${found}; }endpoint ${name} = ${id} exists in ${NEBIUS_PROJECT_ID}"
  elif ! grep -qiE 'not ?found|does not exist' "${err}"; then
    out="$(head -n 2 "${err}" | tr '\n' ' ')"; rm -f "${err}"
    [[ -n "${found}" ]] && { echo "${found}"; return 0; }
    echo "cannot check endpoint ${name} by name: ${out}"; return 2
  fi
  rm -f "${err}"
  [[ -n "${found}" ]] || return 1
  echo "${found}"
}
