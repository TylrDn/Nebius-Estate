#!/usr/bin/env bash
# R14: read Nebius Monitoring through its Prometheus-compatible read API. GET only: creates,
# changes and deletes nothing.
#   provider metrics   https://read.monitoring.api.nebius.cloud/projects/<project>/service-provider/prometheus
#                      (https://docs.nebius.com/observability/metrics/grafana#how-to-connect-grafana-data-source)
#   one service        …/projects/<project>/buckets/<compute|gpu|nbs|sp_storage|msp>/prometheus
#                      (https://docs.nebius.com/observability/metrics/prometheus#how-to-connect-prometheus)
#   your own metrics   …/projects/<project>/prometheus (--ingested)
#                      (https://docs.nebius.com/observability/metrics/ingest#connect-grafana-to-view-your-own-metrics)
#
# Usage: recipes/observability/metrics.sh [options] <command> [arg]
#   names [regex]       metric names (optionally filtered by an extended regex)
#   query '<promql>'    instant PromQL query; prints metric labels and value per series
#   series '<selector>' series matching a selector over the last hour, e.g. '{__name__="DCGM_FI_DEV_GPU_UTIL"}'
#   coverage            every metric the rules in platform/alerts/ use, and whether this project's
#                       provider metrics or ingested metrics have it now
# Options:
#   --project <id>      default NEBIUS_PROJECT_ID (environment or .env)
#   --bucket <service>  one service's metrics: compute, gpu, nbs, sp_storage, msp
#   --ingested          your own metrics (agent, Prometheus remote write) instead of the provider's
#   --json              print the raw API response
#   --dry-run           print the request(s) with the token redacted; no token, no network
# Token: NEBIUS_IAM_TOKEN, PROMETHEUS_TOKEN or the nebius CLI profile (lib.sh).
# NIP_O11Y_MONITORING_URL overrides the host (default https://read.monitoring.api.nebius.cloud).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=recipes/observability/lib.sh
source "${here}/lib.sh"

project_flag="" bucket="" ingested=0 json=0 dry=0 cmd="" arg=""
while (( $# )); do
  case "$1" in
    --project) project_flag="${2:?--project needs a value}"; shift ;;
    --bucket) bucket="${2:?--bucket needs a value}"; shift ;;
    --ingested) ingested=1 ;;
    --json) json=1 ;;
    --dry-run) dry=1 ;;
    -h|--help) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    names|query|series|coverage) [[ -z "${cmd}" ]] || o11y_die "one command at a time"; cmd="$1" ;;
    -*) o11y_die "unknown option: $1 (see --help)" ;;
    *) [[ -n "${cmd}" && -z "${arg}" ]] || o11y_die "unexpected argument: $1 (see --help)"; arg="$1" ;;
  esac
  shift
done
[[ -n "${cmd}" ]] || o11y_die "no command (names, query, series, coverage; see --help)"
[[ -z "${bucket}" ]] || [[ "${bucket}" =~ ^(compute|gpu|nbs|sp_storage|msp)$ ]] || o11y_die "--bucket must be one of compute, gpu, nbs, sp_storage, msp"
(( ingested == 0 )) || [[ -z "${bucket}" ]] || o11y_die "--ingested and --bucket exclude each other"
for c in jq python3; do command -v "${c}" >/dev/null || o11y_die "missing: ${c}"; done

project="$(o11y_project "${project_flag}")"
host="${NIP_O11Y_MONITORING_URL:-https://read.monitoring.api.nebius.cloud}"
host="${host%/}"
base_for() { # base_for <provider|ingested|bucket>
  case "$1" in
    ingested) printf '%s/projects/%s/prometheus/api/v1' "${host}" "${project}" ;;
    bucket) printf '%s/projects/%s/buckets/%s/prometheus/api/v1' "${host}" "${project}" "${bucket}" ;;
    *) printf '%s/projects/%s/service-provider/prometheus/api/v1' "${host}" "${project}" ;;
  esac
}
kind=provider; (( ingested )) && kind=ingested; [[ -n "${bucket}" ]] && kind=bucket
base="$(base_for "${kind}")"
body="$(mktemp)"; trap 'rm -f "${body}" "${body}".*' EXIT

# check <what>: fail with the API's message unless the last call returned 200 and status success.
check() {
  [[ "${O11Y_STATUS}" == dry-run ]] && return 0
  if [[ "${O11Y_STATUS}" != 200 ]] || [[ "$(jq -r '.status // empty' "${body}" 2>/dev/null)" != success ]]; then
    echo "$1: HTTP ${O11Y_STATUS}: $(jq -c '.error // .message // .' "${body}" 2>/dev/null || head -c 300 "${body}")" >&2
    exit 1
  fi
}

# Metric names used by the alert rules (expr: lines), one "<name> <file>" per line.
alert_metrics() {
  python3 -I - "${o11y_repo_root}/platform/alerts" <<'PY'
import pathlib, re, sys
KEYWORDS = {"by", "without", "on", "ignoring", "group_left", "group_right", "and", "or", "unless", "bool", "offset", "inf", "nan"}
for f in sorted(pathlib.Path(sys.argv[1]).rglob("*.yaml")):
    for line in f.read_text().splitlines():
        m = re.match(r"\s*expr:\s*(.+)$", line)
        if not m:
            continue
        e = m.group(1)
        e = re.sub(r'"(?:[^"\\]|\\.)*"', "", e)                     # strings
        e = re.sub(r"\{[^}]*\}", "", e)                              # label matchers
        e = re.sub(r"\[[^\]]*\]", "", e)                             # ranges
        e = re.sub(r"\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)", "", e)  # label lists
        for t in re.finditer(r"[A-Za-z_:][A-Za-z0-9_:]*", e):
            name, after = t.group(0), e[t.end():].lstrip()
            if after.startswith("(") or name.lower() in KEYWORDS:   # a function or a keyword
                continue
            print(name, f.relative_to(pathlib.Path(sys.argv[1]).parent.parent))
PY
}

case "${cmd}" in
  names)
    o11y_get "${dry}" "${body}" "${base}/label/__name__/values"
    check "metric names"; (( dry )) && exit 0
    if (( json )); then jq . "${body}"; else jq -r '.data[]' "${body}" | { if [[ -n "${arg}" ]]; then grep -E -- "${arg}" || true; else cat; fi; }; fi
    echo "$(jq '.data | length' "${body}") metric names in ${kind} metrics of ${project} ($(date -u +%FT%TZ))" >&2
    ;;
  query)
    [[ -n "${arg}" ]] || o11y_die "query needs a PromQL expression"
    o11y_get "${dry}" "${body}" "${base}/query" --data-urlencode "query=${arg}"
    check "query"; (( dry )) && exit 0
    if (( json )); then jq . "${body}"; else
      jq -r '.data.result[]? | [(.metric | to_entries | map("\(.key)=\(.value)") | join(",")), (.value[1] // "-")] | @tsv' "${body}"
    fi
    echo "$(jq '.data.result | length' "${body}") series ($(date -u +%FT%TZ))" >&2
    ;;
  series)
    [[ -n "${arg}" ]] || o11y_die "series needs a selector, e.g. '{__name__=\"DCGM_FI_DEV_GPU_UTIL\"}'"
    now="$(date +%s)"
    o11y_get "${dry}" "${body}" "${base}/series" --data-urlencode "match[]=${arg}" --data-urlencode "start=$((now - 3600))" --data-urlencode "end=${now}"
    check "series"; (( dry )) && exit 0
    if (( json )); then jq . "${body}"; else jq -r '.data[] | to_entries | map("\(.key)=\(.value)") | join(",")' "${body}"; fi
    echo "$(jq '.data | length' "${body}") series in the last hour" >&2
    ;;
  coverage)
    rules="$(alert_metrics | sort -u)"
    [[ -n "${rules}" ]] || o11y_die "no metric names found in platform/alerts"
    for k in provider ingested; do
      o11y_get "${dry}" "${body}.${k}" "$(base_for "${k}")/label/__name__/values"
      if [[ "${O11Y_STATUS}" == 200 ]]; then jq -r '.data[]' "${body}.${k}" > "${body}.${k}.names"
      else : > "${body}.${k}.names"; [[ "${O11Y_STATUS}" == dry-run ]] || echo "${k} metrics: HTTP ${O11Y_STATUS} (read as none)" >&2; fi
    done
    (( dry )) && { echo "${rules}" | awk '{print "rule metric: " $1 "  (" $2 ")"}'; exit 0; }
    printf 'METRIC\tPROVIDER\tINGESTED\tRULE FILES\n'
    awk '{f[$1] = f[$1] ? f[$1] "," $2 : $2} END {for (m in f) print m "\t" f[m]}' <<<"${rules}" | sort | while IFS=$'\t' read -r m files; do
      p=no; i=no
      grep -qxF -- "${m}" "${body}.provider.names" && p=yes
      grep -qxF -- "${m}" "${body}.ingested.names" && i=yes
      printf '%s\t%s\t%s\t%s\n' "${m}" "${p}" "${i}" "${files}"
    done
    echo "coverage of platform/alerts metrics in ${project} ($(date -u +%FT%TZ)); 'no' in both = the rule needs in-cluster Prometheus or a renamed metric (README.md)" >&2
    ;;
esac
