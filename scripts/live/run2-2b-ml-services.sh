#!/usr/bin/env bash
# Run 2 step 2b: R12 ml-services. SecretStash secret nip-sandbox-ml-services with both passwords
# (payload from a 0600 request file via the CLI's -f/--file, so no password is on argv), git-ignored
# zz-run.auto.tfvars.json with ONLY enable_mlflow, enable_postgresql, create_node_service_account and
# the secret ids (no labels key), passwords at silent prompts, make init plan, provisional TTL job
# before the apply, make apply, then make plan must print "No changes" (F4.5).
# Executed: bash run2-2b-ml-services.sh   Needs project admin (creates the node service account).
# R12_SECRET_ARGV=1: only if the CLI rejects the -f request file, use the runbook's argv call
# (the plan's accepted exception, to be recorded in the R12 acceptance evidence).
# The provisional ml-services TTL job armed here inherits TF_VAR_mlflow_admin_password and
# TF_VAR_postgresql_password (its destroy plan needs them): they sit in that job's environment
# (`ps eww <pid>`, same user) until step 2d replaces the job.
# A reused secret: the typed passwords are compared with its payload (jq prints only true/false).
# Refuses when fewer than 120 min are left before the provisional TTL time (2b-2d take about 65 min).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-2b-ml-services
header "Run 2 step 2b - R12 ml-services apply" \
  "SecretStash secret, zz-run.auto.tfvars.json, make init plan, TTL job before apply, make apply (MLflow + PostgreSQL + registry + node SA), then a no-change plan" \
  "\$0.648/h: about \$1.30 (2 h) to \$2.59 (4 h); not preemptible" "about 25-35 min (MLflow took about 18 min on 2026-10-11)" \
  "the RESULT block (secret id, how it was created, plan summary, TTL, apply, the No-changes line)"
need make jq terraform nebius python3
need_tty
check_repo
load_env
state_load run2
[[ -n "${LABELS:-}" ]] || die "no run-2 session: run run2-0-preflight.sh first"
[[ -n "${APPLIED_DATA:-}" ]] || die "step 2a has not run (deploy order R8 -> R12 -> R1)"
[[ "${STEP_2D_DONE:-0}" != 1 ]] || die "step 2d already re-armed the final TTL jobs; re-running 2b would replace ml-services' final job"
EXP="$(jq -r '.["nip-ttl-expires"]' <<<"${LABELS}")"
ttl_window 120 "steps 2b-2d (about 65 min, x2 margin)"
ROOT=terraform/live/sandbox/ml-services
SECRET_NAME=nip-sandbox-ml-services
nb() { nebius --profile "${NEBIUS_PROFILE}" "$@"; }

pw_rules() { local why; why="$(r12_pw_problem "$1" "$2")" || die "${why}"; }
read_pw() { # <var> <label>: silent prompt, twice (run2-all.sh: taken from R12_BATCH_*_PW, typed once at its start)
  local a b
  case "$2" in
    *MLflow*)     [[ -n "${R12_BATCH_MLFLOW_PW:-}" ]] && { printf -v "$1" '%s' "${R12_BATCH_MLFLOW_PW}"; return 0; } ;;
    *PostgreSQL*) [[ -n "${R12_BATCH_PG_PW:-}" ]]     && { printf -v "$1" '%s' "${R12_BATCH_PG_PW}"; return 0; } ;;
  esac
  read -rs -p "$2 (input hidden): " a; echo
  read -rs -p "$2 again: " b; echo
  [[ -n "$a" && "$a" == "$b" ]] || die "$2: empty or the two entries differ"
  printf -v "$1" '%s' "$a"
}

# 1. SecretStash secret (reused when it already exists).
METHOD=""
# NotFound means "create it"; any other error (auth, network, permission) stops here, so a failed
# lookup is never mistaken for a missing secret.
SID="" gerr="$(mktemp)"
if gout="$(nb mysterybox secret get-by-name --name "${SECRET_NAME}" --parent-id "${NEBIUS_PROJECT_ID}" --format json 2>"${gerr}")"; then
  SID="$(jq -r '.metadata.id // empty' <<<"${gout:-null}")"
  [[ -n "${SID}" ]] || { rm -f "${gerr}"; die "get-by-name ${SECRET_NAME} succeeded but returned no metadata.id; check: nebius --profile ${NEBIUS_PROFILE} mysterybox secret list --parent-id ${NEBIUS_PROJECT_ID}"; }
elif ! grep -qiE 'not ?found|does not exist' "${gerr}"; then
  gmsg="$(grep -m 1 . "${gerr}" || echo 'no message')"; rm -f "${gerr}"
  die "cannot tell whether secret ${SECRET_NAME} exists: ${gmsg} (an auth, network or permission error, not NotFound; nothing was started). Fix it and rerun"
fi
rm -f "${gerr}"
if [[ -n "${SID}" ]]; then
  say "SecretStash secret ${SECRET_NAME} exists (${SID}); reusing it. Enter the SAME passwords it holds."
  read_pw TF_VAR_mlflow_admin_password "MLflow admin password (as in the secret)"
  read_pw TF_VAR_postgresql_password "PostgreSQL password (as in the secret)"
  # Check the typed values against the secret's primary version without printing either: the payload
  # goes straight from the CLI into jq, the typed values enter jq from file descriptors (printf is a
  # builtin), and jq prints only true/false. Verb: `nebius mysterybox payload get --secret-id`.
  match="$(nb mysterybox payload get --secret-id "${SID}" --format json 2>/dev/null \
    | jq -r --rawfile m <(printf %s "${TF_VAR_mlflow_admin_password}") --rawfile p <(printf %s "${TF_VAR_postgresql_password}") \
      '([.. | objects | select(has("key")) | {(.key): (.string_value // .stringValue // .value.string_value // null)}] | add // {}) as $kv
       | if ($kv | has("mlflow-admin-password") and has("postgresql-password"))
         then ($kv["mlflow-admin-password"] == $m and $kv["postgresql-password"] == $p) else "unreadable" end' 2>/dev/null || true)"
  case "${match}" in
    true) say "typed passwords match secret ${SID} (checked without printing them)" ;;
    false) die "the typed passwords do not match secret ${SECRET_NAME} (${SID}); nothing was started. Rerun and type the values it holds" ;;
    *) say "WARNING: could not read the payload of ${SID} to compare (no payload read permission, or another payload shape). A mismatch would show up only in step 5 (run2-5-r12-acceptance.sh)" ;;
  esac
  METHOD="reused (typed passwords checked against the payload: ${match:-not checked})"
else
  read_pw MLFLOW_PW "New MLflow admin password"
  read_pw PG_PW "New PostgreSQL password"
  pw_rules "${MLFLOW_PW}" "${PG_PW}"
  if [[ "${R12_SECRET_ARGV:-0}" == 1 ]]; then
    # Accepted exception (plan step 2b): one short call with the payload on argv.
    created="$(nb mysterybox secret create --parent-id "${NEBIUS_PROJECT_ID}" --name "${SECRET_NAME}" \
      --description 'R12 MLflow admin and PostgreSQL bootstrap passwords' \
      --secret-version-payload "$(jq -nc --rawfile m <(printf %s "${MLFLOW_PW}") --rawfile p <(printf %s "${PG_PW}") \
        '[{key: "mlflow-admin-password", string_value: $m}, {key: "postgresql-password", string_value: $p}]')" --format json)"
    METHOD="ACCEPTED EXCEPTION: --secret-version-payload on argv (record in the R12 acceptance evidence)"
  else
    # The CLI's generic -f/--file request input (a global option: help, INPUT SCHEMA); values enter
    # jq from file descriptors (printf is a builtin), never argv. Request file 0600 in a 0700 dir,
    # removed at once, and by the EXIT trap on a Ctrl-C or failure during the create.
    tmpd="$(mktemp -d)"; chmod 700 "${tmpd}"
    trap 'rc=$?; rm -P "${tmpd}/req.json" 2>/dev/null || rm -f "${tmpd}/req.json"; rm -f "${tmpd}/err"; rmdir "${tmpd}" 2>/dev/null || true; _on_exit $rc' EXIT
    ( umask 077
      jq -n --rawfile m <(printf %s "${MLFLOW_PW}") --rawfile p <(printf %s "${PG_PW}") \
        --arg parent "${NEBIUS_PROJECT_ID}" --arg name "${SECRET_NAME}" \
        '{metadata:{parent_id:$parent,name:$name},
          spec:{description:"R12 MLflow admin and PostgreSQL bootstrap passwords",
                secret_version:{payload:[{key:"mlflow-admin-password",string_value:$m},{key:"postgresql-password",string_value:$p}],set_primary:true}}}' \
        > "${tmpd}/req.json" )
    rc=0; created="$(nb mysterybox secret create -f "${tmpd}/req.json" --format json 2>"${tmpd}/err")" || rc=$?
    rm -P "${tmpd}/req.json" 2>/dev/null || rm -f "${tmpd}/req.json"
    # Its stderr, with the typed passwords masked should the CLI echo any part of the request.
    cerr="$(head -n 5 "${tmpd}/err" 2>/dev/null || true)"; rm -f "${tmpd}/err"; rmdir "${tmpd}"
    cerr="${cerr//"${MLFLOW_PW}"/<redacted>}"; cerr="${cerr//"${PG_PW}"/<redacted>}"
    trap '_on_exit $?' EXIT
    if (( rc != 0 )); then
      [[ -z "${cerr}" ]] || printf '%s\n' "${cerr}" | sed 's/^/  create: /'
      # Offer the argv exception only when the CLI rejected the -f request input itself.
      if grep -qiE 'unknown (shorthand )?flag|flag provided but not defined|unknown field|unmarshal|(cannot|failed to|unable to) (read|parse|decode|load)|input file|invalid (input|request) file|-f, --file' <<<"${cerr}"; then
        die "secret create -f failed (rc ${rc}): the CLI rejected the -f request file (above); nothing else was started. Rerun with R12_SECRET_ARGV=1 (accepted exception, record it in the R12 evidence)"
      fi
      die "secret create -f failed (rc ${rc}): $(grep -m 1 . <<<"${cerr}" || echo 'no message'). Nothing else was started. This is not a rejected -f input, so R12_SECRET_ARGV=1 would fail the same way: fix the cause (auth, permission, a name still taken by a soft-deleted secret: runbooks/live-session.md, 'SecretStash deletes are soft') and rerun"
    fi
    METHOD="cli -f request file (no password on argv)"
  fi
  SID="$(jq -r '.metadata.id // .resource_id // empty' <<<"${created}")"
  [[ -n "${SID}" ]] || SID="$(nb mysterybox secret get-by-name --name "${SECRET_NAME}" --parent-id "${NEBIUS_PROJECT_ID}" --format json | jq -r '.metadata.id // empty')"
  [[ "${SID}" =~ ^mbsec- ]] || die "secret created but no mbsec- id came back; check: nebius mysterybox secret list --parent-id ${NEBIUS_PROJECT_ID}"
  TF_VAR_mlflow_admin_password="${MLFLOW_PW}"; TF_VAR_postgresql_password="${PG_PW}"
  unset MLFLOW_PW PG_PW
fi
pw_rules "${TF_VAR_mlflow_admin_password}" "${TF_VAR_postgresql_password}"
export TF_VAR_mlflow_admin_password TF_VAR_postgresql_password
# The secret's primary version; else the first listed (runbook: secret-version list).
SVID="$(nb mysterybox secret get --id "${SID}" --format json | jq -r '.spec.primary_version_id // empty' || true)"
[[ -n "${SVID}" ]] || SVID="$(nb mysterybox secret-version list --parent-id "${SID}" --format json | jq -r '[.items[]?.metadata.id] | first // empty')"
[[ "${SVID}" =~ ^mbsecver- ]] || die "no mbsecver- version for ${SID}"
state_set run2 R12_SECRET_ID "${SID}"; state_set run2 R12_SECRET_VERSION_ID "${SVID}"
state_set run2 R12_SECRET_METHOD "${METHOD}"
say "secret ${SECRET_NAME}: ${SID} version ${SVID} (${METHOD})"

# 2. Root inputs: only these keys; TF_VAR_labels is the only source of labels.
boot ml-services
export TF_VAR_labels="${LABELS}"
for f in "${ROOT}"/*.auto.tfvars*; do
  [[ -e "$f" && "$(basename "$f")" != zz-run.auto.tfvars.json ]] || continue
  grep -qE '(^|[^a-z_])labels[[:space:]]*[=:]|"labels"' "$f" && die "$f sets labels; it would outrank TF_VAR_labels (remove it first)"
done
jq -n --arg s "${SID}" --arg v "${SVID}" \
  '{enable_mlflow:true, enable_postgresql:true, create_node_service_account:true, secret_id:$s, secret_version_id:$v}' \
  > "${ROOT}/zz-run.auto.tfvars.json"
git check-ignore -q "${ROOT}/zz-run.auto.tfvars.json" || die "zz-run.auto.tfvars.json is not git-ignored"
say "wrote ${ROOT}/zz-run.auto.tfvars.json: $(jq -c 'keys' "${ROOT}/zz-run.auto.tfvars.json")"

# 3. Preflight, plan, provisional TTL job, apply, no-change plan.
preflight_go STAGE=sandbox STACK=ml-services
run make init plan STACK=ml-services
make -s plan-summary STACK=ml-services || true
ttl_arm ml-services TTL="${EXP}"
FAIL_HINT="ml-services TTL job armed for ${EXP} (pid $(cat ${ROOT}/.terraform/ttl-teardown.pid)); it stays armed (a partial MLflow apply is guarded). Re-run this step, or bash ${LIVE_DIR}/abort.sh"
confirm "Apply sandbox/ml-services (MLflow + PostgreSQL + registry + node SA; IAM change, needs project admin)?"
state_set run2 APPLIED_ML 1
[[ -n "${APPLY_AT_ML:-}" ]] || state_set run2 APPLY_AT_ML "$(nip_now)"
run make apply STACK=ml-services CONFIRM=yes
pf="$(mktemp)"
run make plan STACK=ml-services 2>&1 | tee "${pf}"
nochg="$(grep -E 'No changes' "${pf}" || true)"; rm -f "${pf}"
unset TF_VAR_mlflow_admin_password TF_VAR_postgresql_password
[[ -n "${nochg}" ]] || die "the second plan of ml-services is not 'No changes' (F4.5 fails); the TTL job stays armed"

result_begin
say "secret ${SECRET_NAME}: ${SID} / ${SVID}; created by: ${METHOD}"
say "apply sandbox/ml-services: done; TTL job (provisional, step 2d replaces it): $(ttl_status ml-services)"
say "F4.5 one-pass: ${nochg}"
terraform -chdir="${ROOT}" output -json | jq -r '{registry_url: .registry_url.value, node_service_account_id: .node_service_account_id.value,
  mlflow: (.mlflow.value | if . then {id, private_tracking, public_tracking, artifact_bucket} else null end),
  postgresql: (.postgresql.value | if . then {id, private_read_write} else null end)}'
say "next: bash ${LIVE_DIR}/run2-2c-inference.sh"
