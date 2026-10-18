#!/usr/bin/env bash
# R14 end to end, after a cluster runs modules/o11y (runbooks/observability.md):
#   grafana  every data source in grafana/datasources.yaml is provisioned (GET /api/datasources) and
#            passes Grafana's own health check (GET /api/datasources/uid/<uid>/health: status OK), which
#            queries Nebius Monitoring, Logging and Tracing with the configured key
#   alerts   in-cluster Prometheus runs a config that names the rule file and an Alertmanager
#            (GET /api/v1/status/config), has loaded every rule of platform/alerts/*.yaml (GET
#            /api/v1/rules) and sends to an Alertmanager (GET /api/v1/alertmanagers); Alertmanager runs
#            our config, not the chart's default (GET /api/v2/receivers); a test alert NipAcceptanceTest
#            (severity warning, ends after 5 min) posted to it (POST /api/v2/alerts, as `amtool alert add`
#            in runbooks/alerting.md) is active and routed to a receiver
# A failing part is never just a count: details.causes names each cause class with a hint (the
# classes are listed in recipes/observability/README.md#acceptance-cause-classes), and stderr prints
# one line per cause. An endpoint that does not answer is "unreachable", never "0 of N".
# Delivery itself is confirmed at the receiver (Slack channel, webhook log); record it with the result.
# Writes results/o11y-acceptance.json; exit 0 pass, 1 fail, 2 bad input.
# Inputs: GRAFANA_URL (default http://127.0.0.1:3000) with GRAFANA_TOKEN (service account token) or
#         GRAFANA_USER + GRAFANA_PASSWORD, passed to curl on stdin, never in argv or output;
#         PROMETHEUS_URL (default http://127.0.0.1:9090), ALERTMANAGER_URL (default http://127.0.0.1:9093):
#         `kubectl -n o11y port-forward svc/<name> <local>:<service port>` to the services
#         `kubectl -n o11y get svc` lists (the Grafana and Prometheus server services listen on 80);
#         O11Y_PROVISIONING (a file holding `terraform output -json o11y_provisioning` of the stack: what
#         the plan sent; tells "input missing" from "sent but not applied"; unset = not compared);
#         EXPECT_RECEIVER (a receiver the test alert must reach; unset = any, a null-only route is flagged);
#         O11Y_DATASOURCES (default every uid in the file; the ingested-metrics source answers 404 until
#         something writes metrics, so leave it out before the agent runs),
#         O11Y_PARTS (default "grafana alerts"), O11Y_FIRE (default 1; 0 checks rules and wiring only),
#         O11Y_ALERT_WAIT_S (default 60), O11Y_POLL_S (default 5).
# shellcheck source=tests/validate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../../tests/validate/lib.sh"; need curl jq
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; root="$(cd "${here}/../.." && pwd)"
G="${GRAFANA_URL:-http://127.0.0.1:3000}"; P="${PROMETHEUS_URL:-http://127.0.0.1:9090}"; A="${ALERTMANAGER_URL:-http://127.0.0.1:9093}"
PARTS="${O11Y_PARTS:-grafana alerts}"; FIRE="${O11Y_FIRE:-1}"; WAIT_S="${O11Y_ALERT_WAIT_S:-60}"; POLL_S="${O11Y_POLL_S:-5}"
part() { [[ " ${PARTS} " == *" $1 "* ]]; }

prov='null'
if [[ -n "${O11Y_PROVISIONING:-}" ]]; then
  if ! [[ -f "${O11Y_PROVISIONING}" ]] || ! prov="$(jq -ce 'select(type == "object")' "${O11Y_PROVISIONING}" 2>/dev/null)"; then
    echo "O11Y_PROVISIONING must be a file with \`terraform output -json o11y_provisioning\` (got '${O11Y_PROVISIONING}')" >&2; exit 2
  fi
fi

# http_get <curl args...>: GET; sets HTTP_CODE ("000" when nothing answers) and HTTP_BODY.
http_get() {
  local out
  out="$(curl -sS --max-time 30 -w '\n%{http_code}' "$@" 2>/dev/null)" || true
  if [[ "${out}" == *$'\n'* ]]; then HTTP_CODE="${out##*$'\n'}"; HTTP_BODY="${out%$'\n'*}"
  else HTTP_CODE="${out:-000}"; HTTP_BODY=""; fi
  [[ "${HTTP_CODE}" =~ ^[0-9]{3}$ ]] || HTTP_CODE=000
}
# grafana_get <path>: GET with the credential in a curl config on stdin (-K -).
grafana_cfg() {
  if [[ -n "${GRAFANA_TOKEN:-}" ]]; then printf 'header = "Authorization: Bearer %s"\n' "${GRAFANA_TOKEN}"
  else printf 'user = "%s:%s"\n' "${GRAFANA_USER}" "${GRAFANA_PASSWORD:-}"; fi
}
grafana_get() { http_get -K - -H 'Accept: application/json' "${G%/}$1" < <(grafana_cfg); }

# cause <class> <part> <severity fail|note> <detail> <hint>: one entry of details.causes.
causes='[]'
cause() {
  causes="$(jq -c --arg c "$1" --arg p "$2" --arg s "$3" --arg d "$4" --arg h "$5" '. + [{class:$c, part:$p, severity:$s, detail:$d, hint:$h}]' <<<"$causes")"
}

if part grafana && [[ -z "${GRAFANA_TOKEN:-}" && -z "${GRAFANA_USER:-}" ]]; then
  echo "set GRAFANA_TOKEN (a Grafana service account token) or GRAFANA_USER and GRAFANA_PASSWORD" >&2; exit 2
fi

grafana='{"skipped":true}'
if part grafana; then
  want="$(sed -n 's/^ *uid: *\([A-Za-z0-9_-]*\).*/\1/p' "${here}/grafana/datasources.yaml" | jq -R . | jq -sc .)"
  if [[ -n "${O11Y_DATASOURCES:-}" ]]; then
    pick="$(tr ' ' '\n' <<<"${O11Y_DATASOURCES}" | grep . | jq -R . | jq -sc .)"
    jq -e --argjson w "$want" '(. - $w) == []' <<<"$pick" >/dev/null \
      || { echo "O11Y_DATASOURCES names a uid not in grafana/datasources.yaml ($(jq -r 'join(", ")' <<<"$want"))" >&2; exit 2; }
    want="$pick"
  fi
  http_get -H 'Accept: application/json' "${G%/}/api/health"
  health="$(jq -ce '{database, version}' <<<"${HTTP_BODY}" 2>/dev/null || echo '{"database":"unreachable"}')"
  have='[]'; rows='[]'; ds_status=null
  if [[ "${HTTP_CODE}" == 000 ]]; then
    cause grafana_unreachable grafana fail "nothing answers at ${G}" \
      "port-forward Grafana: its service listens on 80 (kubectl -n o11y port-forward svc/grafana-and-prometheus 3000:80; kubectl -n o11y get svc)"
  else
    grafana_get /api/datasources; ds_status="${HTTP_CODE}"
    if [[ "${HTTP_CODE}" == 401 || "${HTTP_CODE}" == 403 ]]; then
      cause grafana_auth_failed grafana fail "GET /api/datasources answered HTTP ${HTTP_CODE}" \
        "Grafana refused the credentials: GRAFANA_USER=admin with the stack's grafana_admin_password output (or its SecretStash secret), or a service account token with at least Viewer"
    elif [[ "${HTTP_CODE}" != 200 ]] || ! jq -e 'type == "array"' <<<"${HTTP_BODY}" >/dev/null 2>&1; then
      cause grafana_api_error grafana fail "GET /api/datasources answered HTTP ${HTTP_CODE}" "read the body with curl and Grafana's log (kubectl -n o11y logs deploy/grafana-and-prometheus)"
    else
      have="$(jq -c '[.[]?.uid]' <<<"${HTTP_BODY}")"
      for uid in $(jq -r '.[]' <<<"$want"); do
        jq -e --arg u "$uid" 'index($u)' <<<"$have" >/dev/null || continue
        grafana_get "/api/datasources/uid/${uid}/health"
        rows="$(jq -c --arg u "$uid" --arg h "${HTTP_BODY}" '. + [{uid:$u, health:(($h | fromjson? | .status) // "unreachable"), message:(($h | fromjson? | .message) // null)}]' <<<"$rows")"
      done
      missing="$(jq -c --argjson h "$have" '. - $h' <<<"$want")"
      if [[ "${missing}" != '[]' ]]; then
        m="$(jq -r 'join(", ")' <<<"$missing")"
        if [[ "${prov}" == null ]]; then
          cause datasources_not_provisioned grafana fail "not in this Grafana: ${m}" \
            "modules/o11y provisions them only with grafana_datasource_token_secret; set O11Y_PROVISIONING to a file of \`terraform output -json o11y_provisioning\` to tell an unset input from values that were not applied"
        elif [[ "$(jq -r '.datasources.provisioned // false' <<<"$prov")" != true ]]; then
          cause datasources_token_secret_unset grafana fail "not in this Grafana: ${m}; the plan did not send them" \
            "$(jq -r '.datasources.missing_input // "grafana_datasource_token_secret is unset: create a Secret with key PROMETHEUS_TOKEN holding an OBSERVABILITY static key (docs/credentials.md#observability-static-key) and set it"' <<<"$prov")"
        else
          cause datasources_not_applied grafana fail "the plan sent them but this Grafana lacks: ${m}" \
            "the release values did not reach the grafana subchart (the Marketplace app's keys are unknown) or Grafana has not restarted since the apply: kubectl -n o11y get cm -o yaml | grep -n nebius.yaml; kubectl -n o11y rollout restart deploy/grafana-and-prometheus"
        fi
      fi
      token_secret="$(jq -r '.datasources.token_secret // "the token Secret"' <<<"$prov" 2>/dev/null || echo 'the token Secret')"
      while IFS=$'\t' read -r uid msg; do
        [[ -n "${uid}" ]] || continue
        if [[ "${msg}" =~ 401|403|[Uu]nauthori[sz]ed|[Ff]orbidden|PermissionDenied|[Uu]nauthenticated ]]; then
          cause datasource_token_rejected grafana fail "${uid}: ${msg}" \
            "Nebius refused the key: ${token_secret} is missing in the o11y namespace (it is optional, Grafana starts without it) or was created after Grafana started (restart it), the key is not an OBSERVABILITY static key, or its service account is not in a group with viewer (docs/credentials.md#observability-static-key)"
        else
          cause datasource_unhealthy grafana fail "${uid}: ${msg}" "Save & test the source in Grafana; check egress to read.*.api.nebius.cloud and the URL (recipes/observability/grafana/datasources.yaml)"
        fi
      done < <(jq -r '.[] | select(.health != "OK") | [.uid, (.message // .health)] | @tsv' <<<"$rows")
    fi
  fi
  grafana="$(jq -nc --argjson want "$want" --argjson have "$have" --argjson rows "$rows" --argjson h "$health" --argjson s "${ds_status}" \
    '{grafana:$h, http_status:$s, expected:$want, missing:($want - $have), datasources:$rows}
     | .ok = (.grafana.database == "ok" and .http_status == 200 and (.missing | length) == 0 and (.datasources | length) == (.expected | length) and all(.datasources[]; .health == "OK"))')"
fi

alerts='{"skipped":true}'
if part alerts; then
  want="$(sed -n 's/^ *- alert: *\([A-Za-z0-9_]*\).*/\1/p' "${root}"/platform/alerts/*.yaml | jq -R . | jq -sc 'unique')"
  sent="$(jq -r '.alerting.rules // empty' <<<"$prov" 2>/dev/null || true)"
  rules='null'; ams='null'; config='{}'; receivers='null'
  http_get "${P%/}/api/v1/status/buildinfo"
  if [[ "${HTTP_CODE}" == 000 ]]; then
    cause prometheus_unreachable alerts fail "nothing answers at ${P}" \
      "port-forward the Prometheus server: its service listens on 80 (kubectl -n o11y get svc; kubectl -n o11y port-forward svc/<...-server> 9090:80)"
  else
    http_get "${P%/}/api/v1/status/config"
    yaml="$(jq -r '.data.yaml // ""' <<<"${HTTP_BODY}" 2>/dev/null || true)"
    has_rule_file=false; grep -q 'alerting_rules.yml' <<<"${yaml}" && has_rule_file=true
    has_alerting=false; grep -q '^alerting:' <<<"${yaml}" && grep -q 'alertmanagers:' <<<"${yaml}" && has_alerting=true
    config="$(jq -nc --argjson r "$has_rule_file" --argjson a "$has_alerting" '{rule_file:$r, alerting:$a}')"
    http_get "${P%/}/api/v1/rules?type=alert"
    rules="$(jq -c '[.data.groups[]?.rules[]? | select(.type == "alerting") | {name, health}]' <<<"${HTTP_BODY}" 2>/dev/null || echo '[]')"
    http_get "${P%/}/api/v1/alertmanagers"
    ams="$(jq '.data.activeAlertmanagers // [] | length' <<<"${HTTP_BODY}" 2>/dev/null || echo 0)"
    dropped="$(jq '.data.droppedAlertmanagers // [] | length' <<<"${HTTP_BODY}" 2>/dev/null || echo 0)"

    if [[ "${has_rule_file}" != true ]]; then
      cause prometheus_config_no_rule_files alerts fail "the running prometheus.yml does not name alerting_rules.yml" \
        "the release values did not reach the prometheus subchart's serverFiles (the Marketplace app's keys are unknown): compare kubectl -n o11y get cm -o yaml with o11y_provisioning"
    else
      loaded="$(jq length <<<"$rules")"
      if [[ "${loaded}" == 0 ]]; then
        if [[ -z "${sent}" ]]; then
          cause rules_not_loaded alerts fail "prometheus.yml names alerting_rules.yml but 0 alerting rules are loaded" \
            "either no rules were sent or Prometheus rejected the file (kubectl -n o11y logs <server pod> -c prometheus-server | grep -i rule); set O11Y_PROVISIONING to tell which"
        elif [[ "${sent}" == 0 ]]; then
          cause rules_not_sent alerts fail "the plan sent 0 rules (o11y_provisioning.alerting.rules)" "the stack passes platform/alerts/*.yaml to modules/o11y; re-plan from this branch and apply"
        else
          cause rules_sent_not_loaded alerts fail "the plan sent ${sent} rules, Prometheus loaded 0" \
            "the values did not reach serverFiles.alerting_rules.yml (app keys) or the file failed to load (server log); kubectl -n o11y get cm -o yaml | grep -c 'alert:'"
        fi
      else
        miss="$(jq -c --argjson r "$rules" '. - ($r | map(.name))' <<<"$want")"
        [[ "${miss}" == '[]' ]] || cause rules_missing alerts fail "not loaded: $(jq -r 'join(", ")' <<<"$miss")" "the release predates these rules: re-plan and apply"
      fi
      bad="$(jq -r '[.[] | select(.health != "ok") | .name] | join(", ")' <<<"$rules")"
      [[ -z "${bad}" ]] || cause rules_unhealthy alerts fail "evaluation errors: ${bad}" "GET /api/v1/rules shows lastError per rule"
    fi
    if [[ "${has_alerting}" != true ]]; then
      cause prometheus_config_no_alerting alerts fail "the running prometheus.yml has no alerting section" \
        "prometheus.alertmanager.enabled was false when the chart rendered: sandbox's policy leaves it off, so export TF_VAR_alertmanager_enabled=true before the plan that is applied (o11y_provisioning.alerting.alertmanager)"
    elif [[ "${ams}" == 0 && "${dropped}" -gt 0 ]]; then
      cause alertmanager_dropped_by_relabel alerts fail "Prometheus found ${dropped} Alertmanager(s) and dropped them" \
        "the chart's relabel keeps pods labelled app.kubernetes.io/instance=<release> and app.kubernetes.io/name=alertmanager on port 9093: compare kubectl -n o11y get pod --show-labels"
    elif [[ "${ams}" == 0 ]]; then
      cause alertmanager_not_discovered alerts fail "prometheus.yml has an alerting section but no Alertmanager is active" \
        "the Alertmanager pod is not Running, or Prometheus may not list pods (kubectl -n o11y get pod; kubectl auth can-i list pods --as=system:serviceaccount:o11y:<server SA> -n o11y)"
    fi
  fi

  http_get "${A%/}/api/v2/receivers"
  if [[ "${HTTP_CODE}" == 000 ]]; then
    cause alertmanager_unreachable alerts fail "nothing answers at ${A}" "port-forward Alertmanager (kubectl -n o11y port-forward svc/<...-alertmanager> 9093:9093)"
  else
    receivers="$(jq -c '[.[]?.name]' <<<"${HTTP_BODY}" 2>/dev/null || echo '[]')"
    if [[ "${receivers}" == '["default-receiver"]' ]]; then
      cause alertmanager_config_not_applied alerts fail "Alertmanager runs the chart's default config (receiver default-receiver only)" \
        "neither alertmanager_config (inline) nor alertmanager_config_secret reached it: o11y_provisioning.alerting.receiver_config says which was sent; for a Secret, kubectl -n o11y get secret <name> and the pod's --config.file argument"
    fi
  fi

  test_alert='{"skipped":true}'
  if [[ "$FIRE" == 1 ]]; then
    run="$(date -u +%Y%m%dT%H%M%SZ)-$$"; tmp="$(mktemp)"
    jq -n --arg run "$run" --arg now "$(date -u +%FT%TZ)" --arg end "$(date -u -d '+5 min' +%FT%TZ 2>/dev/null || date -u -v+5M +%FT%TZ)" \
      '[{labels:{alertname:"NipAcceptanceTest", severity:"warning", nip_check:$run},
         annotations:{summary:"R14 acceptance test alert (recipes/observability/acceptance.sh); resolves by itself"},
         startsAt:$now, endsAt:$end}]' >"$tmp"
    posted=false; curl -sS -f -X POST -H 'Content-Type: application/json' --data-binary "@${tmp}" "${A%/}/api/v2/alerts" >/dev/null 2>&1 && posted=true
    rm -f "$tmp"
    found='null'; end=$((SECONDS + WAIT_S))
    while [[ "$posted" == true ]]; do
      http_get "${A%/}/api/v2/alerts?filter=alertname%3D%22NipAcceptanceTest%22"
      found="$(jq -c --arg run "$run" '[.[]? | select(.labels.nip_check == $run)] | first // null' <<<"${HTTP_BODY}" 2>/dev/null || echo null)"
      [[ "$found" != null ]] && break
      (( SECONDS >= end )) && break
      sleep "$POLL_S"
    done
    test_alert="$(jq -nc --argjson p "$posted" --argjson f "$found" --arg run "$run" --arg exp "${EXPECT_RECEIVER:-}" '
      ($f.receivers // [] | map(.name)) as $r
      | {posted:$p, run:$run, state:($f.status.state // null), receivers:$r, null_only:($r == ["null"]), expected_receiver:(if $exp == "" then null else $exp end)}
      | .ok = (.posted and .state == "active" and ($r | length) > 0 and (if $exp == "" then true else ($r | index($exp)) != null end))')"
    if jq -e '.posted' <<<"$test_alert" >/dev/null; then
      if ! jq -e '.state == "active" and (.receivers | length) > 0' <<<"$test_alert" >/dev/null; then
        cause test_alert_not_active alerts fail "NipAcceptanceTest was posted but not active with a receiver within ${WAIT_S}s" "raise O11Y_ALERT_WAIT_S; read Alertmanager's log"
      elif [[ -n "${EXPECT_RECEIVER:-}" ]] && ! jq -e '.ok' <<<"$test_alert" >/dev/null; then
        cause receiver_not_reached alerts fail "routed to $(jq -r '.receivers | join(", ")' <<<"$test_alert"), not ${EXPECT_RECEIVER}" \
          "the route does not send severity=warning to ${EXPECT_RECEIVER}: the Alertmanager config (runbooks/alerting.md)"
      elif jq -e '.null_only' <<<"$test_alert" >/dev/null; then
        cause receiver_null_only alerts note "routed only to the null receiver: visible, nobody notified" "expected in sandbox; wire a receiver per runbooks/alerting.md"
      fi
    elif ! jq -e 'any(.[]; .class == "alertmanager_unreachable")' <<<"$causes" >/dev/null; then
      cause test_alert_not_posted alerts fail "POST ${A%/}/api/v2/alerts failed" "Alertmanager answered GETs but refused the alert: read its log"
    fi
  fi
  alerts="$(jq -nc --argjson want "$want" --argjson rules "$rules" --argjson ams "$ams" --argjson t "$test_alert" --argjson c "$config" --argjson rc "$receivers" --arg sent "${sent}" '
    {rules_expected:($want | length), rules_sent:(if $sent == "" then null else ($sent | tonumber) end),
     rules_loaded:(if $rules == null then null else ($rules | length) end),
     rules_missing:(if $rules == null then $want else $want - ($rules | map(.name)) end),
     rules_unhealthy:[($rules // [])[] | select(.health != "ok") | .name], prometheus_config:$c,
     alertmanagers:$ams, alertmanager_receivers:$rc, test_alert:$t}')"
  alerts="$(jq -c --argjson c "$causes" '.ok = ([$c[] | select(.part == "alerts" and .severity == "fail")] | length == 0)
    and (.rules_missing | length) == 0 and (.rules_unhealthy | length) == 0 and (.alertmanagers // 0) > 0
    and (.test_alert.skipped == true or .test_alert.ok)' <<<"$alerts")"
fi

jq -r '.[] | "\(.severity) \(.class) [\(.part)]: \(.detail)\n    hint: \(.hint)"' <<<"$causes" >&2
details="$(jq -n --argjson g "$grafana" --argjson a "$alerts" --argjson c "$causes" --argjson pv "$prov" --arg gu "$G" --arg pu "$P" --arg au "$A" \
  '{grafana:$g, alerts:$a, causes:$c, provisioning:$pv, endpoints:{grafana:$gu, prometheus:$pu, alertmanager:$au},
    method:"Grafana /api/datasources + /api/datasources/uid/<uid>/health for grafana/datasources.yaml; Prometheus /api/v1/status/config, /api/v1/rules vs platform/alerts/*.yaml and /api/v1/alertmanagers; Alertmanager /api/v2/receivers; NipAcceptanceTest posted to Alertmanager /api/v2/alerts and read back with its receivers; causes per recipes/observability/README.md#acceptance-cause-classes"}')"
if jq -e '(.grafana.skipped == true or .grafana.ok) and (.alerts.skipped == true or .alerts.ok)' <<<"$details" >/dev/null; then
  record o11y-acceptance pass "$details"
else
  record o11y-acceptance fail "$details"
fi
