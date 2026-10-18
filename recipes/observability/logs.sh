#!/usr/bin/env bash
# R14: read Nebius Observability Logs through its Loki-compatible read API
# (https://read.logging.api.nebius.cloud/projects/<project>, the URL LogCLI and Grafana use:
# https://docs.nebius.com/observability/logs/logcli#how-to-query-logs-with-logcli). GET only:
# creates, changes, exports and deletes nothing. The nebius CLI equivalents are in README.md.
#
# Usage: recipes/observability/logs.sh [options] <command> [arg]
#   buckets              log buckets with entries in the window (sp_serial, sp_mk8s_control_plane, default, ...)
#   labels               labels of --bucket in the window
#   values <label>       values of one label in --bucket
#   query '<logql>'      log lines, newest first; the selector gets __bucket__ from --bucket when it
#                        has none, e.g. query '{level="error"}' --bucket sp_serial
# Options:
#   --project <id>       default NEBIUS_PROJECT_ID (environment or .env)
#   --bucket <bucket>    sp_serial | sp_mk8s_control_plane | sp_mk8s_audit_logs | sp_mlflow |
#                        sp_postgres | sp_cloudapps | sp_k8srelease | default (required except for buckets)
#   --since <duration>   window back from now: 15m, 2h, 7d (default 1h; logs are kept 14 days)
#   --limit <n>          lines for query, 1..1000 (default 100; the service returns at most 1000 rows)
#   --json               print the raw API response
#   --dry-run            print the request with the token redacted; no token, no network
# Refused before any call (documented limits of Nebius LogQL,
# https://docs.nebius.com/observability/logs/query-language#limitations): a query without a
# bucket, and bytes_rate, bytes_over_time, absent_over_time, sort, sort_desc, vector, approx_topk,
# `without`. Token: NEBIUS_IAM_TOKEN, PROMETHEUS_TOKEN or the nebius CLI profile (lib.sh).
# NIP_O11Y_LOGGING_URL overrides the host (default https://read.logging.api.nebius.cloud).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=recipes/observability/lib.sh
source "${here}/lib.sh"

buckets_known="sp_serial sp_mk8s_control_plane sp_mk8s_audit_logs sp_mlflow sp_postgres sp_cloudapps sp_k8srelease default"
project_flag="" bucket="" since="1h" limit=100 json=0 dry=0 cmd="" arg=""
while (( $# )); do
  case "$1" in
    --project) project_flag="${2:?--project needs a value}"; shift ;;
    --bucket) bucket="${2:?--bucket needs a value}"; shift ;;
    --since) since="${2:?--since needs a value}"; shift ;;
    --limit) limit="${2:?--limit needs a value}"; shift ;;
    --json) json=1 ;;
    --dry-run) dry=1 ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    buckets|labels|values|query) [[ -z "${cmd}" ]] || o11y_die "one command at a time"; cmd="$1" ;;
    -*) o11y_die "unknown option: $1 (see --help)" ;;
    *) [[ -n "${cmd}" && -z "${arg}" ]] || o11y_die "unexpected argument: $1 (see --help)"; arg="$1" ;;
  esac
  shift
done
[[ -n "${cmd}" ]] || o11y_die "no command (buckets, labels, values, query; see --help)"
[[ -z "${bucket}" ]] || [[ " ${buckets_known} " == *" ${bucket} "* ]] || o11y_die "--bucket must be one of: ${buckets_known}"
if ! [[ "${limit}" =~ ^[0-9]+$ ]] || (( limit < 1 || limit > 1000 )); then o11y_die "--limit must be 1..1000"; fi
seconds="$(o11y_since "${since}")"
(( seconds <= 14 * 86400 )) || o11y_die "--since beyond 14 days: logs are kept 14 days (https://docs.nebius.com/observability/resources/quotas-limits#logs-constraints)"
for c in jq python3; do command -v "${c}" >/dev/null || o11y_die "missing: ${c}"; done

# selector <logql>: the query with __bucket__ added from --bucket when its selector has none.
selector() {
  local q="$1"
  if [[ "${q}" != *__bucket__* ]]; then
    [[ -n "${bucket}" ]] || o11y_die "a query must name a bucket: pass --bucket or put __bucket__ in the selector"
    [[ "${q}" == \{* ]] || o11y_die "a query starts with a stream selector, e.g. '{level=\"error\"}'"
    if [[ "${q}" == "{}"* ]]; then q="{__bucket__=\"${bucket}\"}${q#\{\}}"; else q="{__bucket__=\"${bucket}\",${q#\{}"; fi
  fi
  local f
  for f in bytes_rate bytes_over_time absent_over_time sort_desc sort vector approx_topk; do
    [[ ! "${q}" =~ (^|[^a-z_])${f}[[:space:]]*\( ]] || o11y_die "${f}() is not supported by Nebius LogQL (query-language#limitations)"
  done
  [[ ! "${q}" =~ (^|[^a-z_])without[[:space:]]*\( ]] || o11y_die "'without' aggregation is not supported by Nebius LogQL (query-language#limitations)"
  printf '%s' "${q}"
}

project="$(o11y_project "${project_flag}")"
host="${NIP_O11Y_LOGGING_URL:-https://read.logging.api.nebius.cloud}"
base="${host%/}/projects/${project}/loki/api/v1"
now="$(date +%s)"
window=(--data-urlencode "start=$((now - seconds))000000000" --data-urlencode "end=${now}000000000")
body="$(mktemp)"; trap 'rm -f "${body}"' EXIT

check() {
  [[ "${O11Y_STATUS}" == dry-run ]] && return 0
  if [[ "${O11Y_STATUS}" != 200 ]] || [[ "$(jq -r '.status // empty' "${body}" 2>/dev/null)" != success ]]; then
    echo "$1: HTTP ${O11Y_STATUS}: $(jq -c '.error // .message // .' "${body}" 2>/dev/null || head -c 300 "${body}")" >&2
    exit 1
  fi
}

case "${cmd}" in
  buckets)
    o11y_get "${dry}" "${body}" "${base}/label/__bucket__/values" "${window[@]}"
    check "buckets"; (( dry )) && exit 0
    if (( json )); then jq . "${body}"; else jq -r '.data[]?' "${body}"; fi
    echo "buckets with entries in the last ${since} in ${project}" >&2
    ;;
  labels)
    [[ -n "${bucket}" ]] || o11y_die "labels needs --bucket"
    o11y_get "${dry}" "${body}" "${base}/labels" --data-urlencode "query={__bucket__=\"${bucket}\"}" "${window[@]}"
    check "labels"; (( dry )) && exit 0
    if (( json )); then jq . "${body}"; else jq -r '.data[]?' "${body}" | sort; fi
    echo "labels of ${bucket}, last ${since}" >&2
    ;;
  values)
    [[ -n "${bucket}" ]] || o11y_die "values needs --bucket"
    [[ "${arg}" =~ ^[A-Za-z_][A-Za-z0-9_.]*$ ]] || o11y_die "values needs a label name"
    o11y_get "${dry}" "${body}" "${base}/label/${arg}/values" --data-urlencode "query={__bucket__=\"${bucket}\"}" "${window[@]}"
    check "values"; (( dry )) && exit 0
    if (( json )); then jq . "${body}"; else jq -r '.data[]?' "${body}" | sort; fi
    echo "values of ${arg} in ${bucket}, last ${since}" >&2
    ;;
  query)
    [[ -n "${arg}" ]] || o11y_die "query needs a LogQL expression"
    q="$(selector "${arg}")"
    o11y_get "${dry}" "${body}" "${base}/query_range" --data-urlencode "query=${q}" "${window[@]}" \
      --data-urlencode "limit=${limit}" --data-urlencode "direction=backward"
    check "query"; (( dry )) && exit 0
    if (( json )); then jq . "${body}"; else
      jq -r '.data.result[]? | .stream as $s | .values[] | [(.[0] | tonumber / 1e9 | todate), ($s.level // "-"), .[1]] | @tsv' "${body}" | sort -r
    fi
    echo "$(jq '[.data.result[]?.values | length] | add // 0' "${body}") lines, last ${since}, limit ${limit}" >&2
    ;;
esac
