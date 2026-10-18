#!/usr/bin/env bash
# Safety-net teardown of one sandbox live root at its nip-ttl-expires (make ttl-teardown).
#
#   scripts/ttl-teardown.sh --stage <stage> --stack <stack> [--expires YYYY-MM-DDTHH:MM:SSZ] [--profile <name>] [--dry-run]
#
# The expiry is --expires, else the nip-ttl-expires label of the rendered run profile
# (terraform/live/<stage>/<stack>/.run-profile.tfvars.json, written by make plan PROFILE=...), else
# the one in TF_VAR_labels. Every time is parsed as UTC (scripts/lib-time.sh); the absolute UTC time
# and the delay are printed. Without --dry-run it needs CONFIRM=yes and starts a background job that
# waits until that time (it re-reads the clock, so a laptop asleep in between only delays it) and then
# runs `make destroy-plan` and `make destroy CONFIRM=yes` for this root, in the current shell's
# environment: the IAM token from scripts/bootstrap-backend.sh must still be valid then. destroy-plan
# gets the inputs the run was planned with: PROFILE=<name> with --profile, else RUN_PROFILE=1 when the
# root has a rendered .run-profile.tfvars.json (passed as -var-file), else the root's own inputs.
# --stack soperator: the upstream recipe labels nothing, so the expiry is --expires (or TF_VAR_labels) and
# the job runs `make soperator-destroy-plan` and `make soperator-destroy CONFIRM=yes` for the stage.
# The job's log and pid are in the root's .terraform/ (git-ignored). Refused for prod.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib-time.sh
source scripts/lib-time.sh

stage="" stack="" expires="" name="" dry=0
while (( $# )); do
  case "$1" in
    --stage) stage="$2"; shift 2 ;;
    --stack) stack="$2"; shift 2 ;;
    --expires) expires="$2"; shift 2 ;;
    --profile) name="$2"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) echo "usage: $0 --stage <stage> --stack <stack> [--expires YYYY-MM-DDTHH:MM:SSZ] [--profile <name>] [--dry-run]" >&2; exit 2 ;;
  esac
done
[[ "${stage}" != prod ]] || { echo "Refusing: prod is torn down through the release process, not a timer (runbooks/teardown.md)" >&2; exit 1; }
dir="terraform/live/${stage}/${stack}"
[[ -n "${stage}" && -n "${stack}" && -d "${dir}" ]] || { echo "No such live root ${dir}: --stage sandbox|staging --stack <stack>" >&2; exit 1; }

profile="${dir}/.run-profile.tfvars.json"
if [[ -z "${expires}" && -f "${profile}" ]]; then
  expires="$(jq -r '.labels["nip-ttl-expires"] // empty' "${profile}")"
fi
if [[ -z "${expires}" && -n "${TF_VAR_labels:-}" ]]; then
  expires="$(jq -r '.["nip-ttl-expires"] // empty' <<<"${TF_VAR_labels}")"
fi
# The destroy plan must see the inputs the run was planned with (Makefile PROFILE / RUN_PROFILE).
profile_arg=""
if [[ "${stack}" == soperator ]]; then
  [[ -z "${name}" ]] || { echo "--profile does not apply to soperator (the recipe's var files are fixed: Makefile SOPERATOR_VARS)" >&2; exit 2; }
elif [[ -n "${name}" ]]; then
  [[ "${name}" =~ ^[a-z0-9][a-z0-9.-]*$ ]] || { echo "--profile '${name}' is not a profile name (platform/profiles/${stack}/)" >&2; exit 2; }
  profile_arg="PROFILE=${name}"
elif [[ -f "${profile}" ]]; then
  profile_arg="RUN_PROFILE=1"
fi
[[ -n "${expires}" ]] || { echo "no nip-ttl-expires: pass --expires, run make plan PROFILE=<profile>, or set it in TF_VAR_labels" >&2; exit 1; }
[[ "${expires}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
  || { echo "nip-ttl-expires '${expires}' is not YYYY-MM-DDTHH:MM:SSZ (docs/naming.md)" >&2; exit 1; }
target="$(nip_epoch "${expires}")"
now="$(nip_now)"
delay=$(( target - now ))
(( delay > 0 )) || { echo "nip-ttl-expires ${expires} has already passed: tear down now (make destroy-plan, then make destroy CONFIRM=yes)" >&2; exit 1; }

echo "Teardown of ${stage}/${stack} at ${expires} (UTC), in ${delay} s ($(( delay / 3600 )) h $(( delay % 3600 / 60 )) min)"
if [[ "${stack}" == soperator ]]; then
  echo "  then: make soperator-destroy-plan STAGE=${stage} && make soperator-destroy STAGE=${stage} CONFIRM=yes"
else
  echo "  then: make destroy-plan STAGE=${stage} STACK=${stack}${profile_arg:+ ${profile_arg}} && make destroy STAGE=${stage} STACK=${stack} CONFIRM=yes"
fi
# A user IAM token lasts 12 h (docs: iam/authorization/access-tokens); the job inherits this shell's.
(( delay < 12 * 3600 )) || echo "Warning: more than 12 h away; the IAM token in this shell will have expired by then" >&2
(( dry == 0 )) || exit 0
[[ "${CONFIRM:-}" == yes ]] || { echo "Refusing: this schedules a destroy; set CONFIRM=yes (or check it with --dry-run)" >&2; exit 1; }

state="${dir}/.terraform"; mkdir -p "${state}"
log="${state}/ttl-teardown.log" pidfile="${state}/ttl-teardown.pid"
poll="${NIP_TTL_POLL:-30}"
# shellcheck disable=SC2016  # the job's script expands in the job
job='while now=$(date -u +%s); (( now < $1 )); do left=$(( $1 - now )); sleep $(( left < $4 ? left : $4 )); done
echo "$(date -u +%FT%TZ) TTL reached: tearing down $2/$3"
if [[ "$3" == soperator ]]; then make soperator-destroy-plan STAGE="$2" && make soperator-destroy STAGE="$2" CONFIRM=yes
else make destroy-plan STAGE="$2" STACK="$3" ${5:+"$5"} && make destroy STAGE="$2" STACK="$3" CONFIRM=yes; fi'
# caffeinate (macOS) keeps the machine from idle sleep until the job ends.
keepawake=(); command -v caffeinate >/dev/null && keepawake=(caffeinate -i)
nohup "${keepawake[@]+"${keepawake[@]}"}" bash -c "${job}" ttl-teardown "${target}" "${stage}" "${stack}" "${poll}" "${profile_arg}" >"${log}" 2>&1 &
echo "$!" > "${pidfile}"
echo "Scheduled (pid $!): log ${log}; cancel with: kill \$(cat ${pidfile})"
