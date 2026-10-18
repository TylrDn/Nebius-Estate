#!/usr/bin/env bash
# Offline check of the R14 observability recipe (part of `make recipes-check`): no token, no
# network, no cloud call.
#   - every script parses; --dry-run builds the documented URLs and never prints a token
#   - the documented LogQL limits and bad arguments are refused (exit 2) before any call
#   - coverage reads metric names, not PromQL functions, out of platform/alerts
#   - the Grafana provisioning file carries no credential, only ${VAR} references
# Usage: recipes/observability/test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
m="${here}/metrics.sh" l="${here}/logs.sh"
# A sentinel instead of a real token: it must never appear in any output. The hosts are reserved
# .invalid names, so even a bug that sent a request could not reach a real service.
sentinel="nip-test-token-must-not-print-0000"
export NEBIUS_IAM_TOKEN="${sentinel}" PROMETHEUS_TOKEN="${sentinel}" NEBIUS_PROFILE="nip-test-no-such-profile"
export NIP_O11Y_MONITORING_URL="https://read.monitoring.invalid" NIP_O11Y_LOGGING_URL="https://read.logging.invalid/"
p="project-e00example"
fail() { echo "FAIL: $*" >&2; exit 1; }
out="$(mktemp)"; trap 'rm -f "${out}"' EXIT

for s in "${here}"/*.sh; do bash -n "${s}" || fail "$(basename "${s}") does not parse"; done

# expect_url <expected URL prefix> <expected query param k=v or ""> -- <command...>
expect_url() {
  local want="$1" param="$2"; shift 3
  "$@" >"${out}" 2>&1 || fail "'$*' exited non-zero: $(cat "${out}")"
  grep -qF "${sentinel}" "${out}" && fail "'$*' printed the token"
  python3 -I - "${out}" "${want}" "${param}" <<'PY' || fail "'$*' built the wrong request: $(cat "${out}")"
import json, sys
text, want, param = open(sys.argv[1]).read(), sys.argv[2], sys.argv[3]
req = json.loads(text[text.index("{"):text.rindex("}") + 1])
assert req["dry_run"] is True and req["method"] == "GET", req
assert req["url"] == want, (req["url"], want)
assert req["headers"]["Authorization"] == "Bearer <token redacted>", req["headers"]
if param:
    k, v = param.split("=", 1)
    assert req["params"].get(k) == v, (req["params"], param)
PY
}

mon="https://read.monitoring.invalid/projects/${p}"
expect_url "${mon}/service-provider/prometheus/api/v1/label/__name__/values" "" -- "${m}" --project "${p}" --dry-run names
expect_url "${mon}/prometheus/api/v1/query" "query=up" -- "${m}" --project "${p}" --dry-run --ingested query up
expect_url "${mon}/buckets/gpu/prometheus/api/v1/series" 'match[]={__name__="DCGM_FI_DEV_GPU_UTIL"}' -- "${m}" --project "${p}" --dry-run --bucket gpu series '{__name__="DCGM_FI_DEV_GPU_UTIL"}'

logs="https://read.logging.invalid/projects/${p}/loki/api/v1"
expect_url "${logs}/label/__bucket__/values" "" -- "${l}" --project "${p}" --dry-run buckets
expect_url "${logs}/labels" 'query={__bucket__="sp_mk8s_control_plane"}' -- "${l}" --project "${p}" --dry-run labels --bucket sp_mk8s_control_plane
expect_url "${logs}/label/level/values" 'query={__bucket__="sp_serial"}' -- "${l}" --project "${p}" --dry-run values level --bucket sp_serial
expect_url "${logs}/query_range" 'query={__bucket__="sp_serial",level="error"}' -- "${l}" --project "${p}" --dry-run query '{level="error"}' --bucket sp_serial
expect_url "${logs}/query_range" 'query={__bucket__="sp_postgres"} |= "deadlock detected"' -- "${l}" --project "${p}" --dry-run query '{} |= "deadlock detected"' --bucket sp_postgres
expect_url "${logs}/query_range" 'query=sum by (level)(count_over_time({__bucket__="default"}[5m]))' -- "${l}" --project "${p}" --dry-run query 'sum by (level)(count_over_time({__bucket__="default"}[5m]))'
expect_url "${logs}/query_range" "limit=1000" -- "${l}" --project "${p}" --dry-run query '{}' --bucket default --limit 1000

# refuse <description> -- <command...>: exit 2, no token in the output.
refuse() {
  local what="$1"; shift 2
  set +e; "$@" >"${out}" 2>&1; local rc=$?; set -e
  [[ "${rc}" == 2 ]] || fail "${what}: expected exit 2, got ${rc}: $(cat "${out}")"
  grep -qF "${sentinel}" "${out}" && fail "${what}: printed the token"
  return 0
}
refuse "query without a bucket" -- "${l}" --project "${p}" --dry-run query '{level="error"}'
refuse "unknown bucket" -- "${l}" --project "${p}" --dry-run labels --bucket sp_unknown
for f in 'bytes_rate({__bucket__="default"}[5m])' 'bytes_over_time({__bucket__="default"}[5m])' \
         'absent_over_time({__bucket__="default"}[5m])' 'sort(count_over_time({__bucket__="default"}[5m]))' \
         'sort_desc(count_over_time({__bucket__="default"}[5m]))' 'count_over_time({__bucket__="default"}[5m]) or vector(0)' \
         'approx_topk(3, count_over_time({__bucket__="default"}[5m]))' \
         'sum without (level) (count_over_time({__bucket__="default"}[5m]))'; do
  refuse "unsupported LogQL ${f}" -- "${l}" --project "${p}" --dry-run query "${f}"
done
refuse "limit above 1000" -- "${l}" --project "${p}" --dry-run query '{}' --bucket default --limit 1001
refuse "window beyond retention" -- "${l}" --project "${p}" --dry-run buckets --since 15d
refuse "malformed project" -- "${m}" --project e00example --dry-run names
refuse "unknown metrics bucket" -- "${m}" --project "${p}" --dry-run --bucket billing names
refuse "ingested and bucket together" -- "${m}" --project "${p}" --dry-run --ingested --bucket gpu names
refuse "no command" -- "${m}" --project "${p}" --dry-run

# coverage: names from platform/alerts, never PromQL functions or keywords.
"${m}" --project "${p}" --dry-run coverage >"${out}" 2>&1 || fail "coverage --dry-run exited non-zero"
grep -q '^rule metric: DCGM_FI_DEV_XID_ERRORS ' "${out}" || fail "coverage misses DCGM_FI_DEV_XID_ERRORS"
grep -q '^rule metric: kube_pod_status_phase ' "${out}" || fail "coverage misses kube_pod_status_phase"
grep -Eq '^rule metric: (increase|rate|sum|max|histogram_quantile|by|on|and|group_left)[[:space:]]' "${out}" && fail "coverage reports a PromQL function or keyword as a metric"
grep -qF "${sentinel}" "${out}" && fail "coverage printed the token"

# Grafana provisioning: four data sources on the documented hosts; credentials only as ${VAR}.
ds="${here}/grafana/datasources.yaml"
[[ "$(grep -c '^  - name: ' "${ds}")" == 4 ]] || fail "datasources.yaml should define 4 data sources"
for u in "read.monitoring.api.nebius.cloud/projects/\${NEBIUS_PROJECT_ID}/service-provider/prometheus" \
         "read.monitoring.api.nebius.cloud/projects/\${NEBIUS_PROJECT_ID}/prometheus" \
         "read.logging.api.nebius.cloud/projects/\${NEBIUS_PROJECT_ID}" \
         "read.tracing.api.nebius.cloud/projects/\${NEBIUS_PROJECT_ID}/tempo"; do
  grep -qF "url: https://${u}" "${ds}" || fail "datasources.yaml lacks ${u}"
done
grep -E 'httpHeaderValue[0-9]+:' "${ds}" | grep -vqE ':[[:space:]]+(Bearer )?\$\{PROMETHEUS_TOKEN\}$' && fail "a header value in datasources.yaml is not \${PROMETHEUS_TOKEN}"
grep -Eq 'project-[a-z0-9]{8,}|eyJ[A-Za-z0-9_-]{10,}' "${ds}" && fail "datasources.yaml holds a project ID or a token"

echo "observability: dry-run requests, LogQL refusals, alert-rule coverage and Grafana provisioning ok (no network, no token)"
