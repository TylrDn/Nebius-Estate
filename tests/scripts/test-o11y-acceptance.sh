#!/usr/bin/env bash
# recipes/observability/acceptance.sh (R14 end to end): Grafana has the four data sources of
# grafana/datasources.yaml provisioned and each passes its health check; in-cluster Prometheus has
# loaded every rule of platform/alerts/*.yaml and is connected to an Alertmanager; a test alert sent
# to that Alertmanager is active and routed to a receiver. When a part fails the result names its
# cause class (details.causes), so a live run says what to fix instead of "0 of 4" (the 2026-10-12
# sandbox run). curl is a stub answering from canned API responses; the Grafana token must never
# reach argv.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
export RULES="${work}/rules.json" POSTED="${work}/posted.json"
# Prometheus answers with every alert name in platform/alerts/*.yaml (as modules/o11y loads them).
sed -n 's/^ *- alert: *\([A-Za-z0-9_]*\).*/\1/p' "${repo_root}"/platform/alerts/*.yaml \
  | jq -R . | jq -sc '{status:"success",data:{groups:[{name:"nip",rules:[.[] | {type:"alerting",name:.,health:"ok",state:"inactive"}]}]}}' >"${RULES}"
# The stub prints the body, then, when called with -w, a newline and the HTTP status (as
# `curl -w '\n%{http_code}'`). UNREACHABLE=<grafana|prometheus|alertmanager> answers like a closed port.
stub curl '
url=""; data=""; method=GET; prev=""; w=0
for a in "$@"; do
  case "${prev}" in -X) method="${a}" ;; --data|--data-binary) data="${a}" ;; -w) w=1 ;; esac
  [[ "${a}" == http* ]] && url="${a}"; prev="${a}"
done
host="${url#http://}"; host="${host%%.invalid*}"
if [[ "${host}" == "${UNREACHABLE:-none}" ]]; then
  echo "curl: (7) Failed to connect" >&2; (( w )) && printf "000"; exit 7
fi
[[ -n "${data}" ]] && { [[ "${data}" == @* ]] && cp "${data#@}" "${POSTED}" || printf "%s" "${data}" >"${POSTED}"; }
ds() { echo "{\"uid\":\"$1\",\"name\":\"$1\",\"type\":\"$2\"}"; }
code=200; body=""
case "${method} ${url}" in
  "GET http://grafana.invalid/api/health") body="{\"database\":\"ok\",\"version\":\"13.2.2\"}" ;;
  "GET http://grafana.invalid/api/datasources")
    if [[ -n "${GRAFANA_401+x}" ]]; then code=401; body="{\"message\":\"Unauthorized\"}"
    elif [[ -n "${NO_DATASOURCES+x}" ]]; then body="[]"
    else
      traces=",$(ds nebius-traces tempo)"; [[ -n "${NO_TRACES+x}" ]] && traces=""
      body="[$(ds nebius-provider-metrics prometheus),$(ds nebius-ingested-metrics prometheus),$(ds nebius-logs loki)${traces}]"
    fi ;;
  "GET http://grafana.invalid/api/datasources/uid/"*"/health")
    u="${url%/health}"; u="${u##*/}"
    if [[ "${u}" == "${BAD_DS:-none}" ]]; then code=400; body="{\"status\":\"ERROR\",\"message\":\"${BAD_DS_MSG:-401 Unauthorized}\"}"
    else body="{\"status\":\"OK\",\"message\":\"Successfully queried the Prometheus API.\"}"; fi ;;
  "GET http://prometheus.invalid/api/v1/status/buildinfo") body="{\"status\":\"success\",\"data\":{\"version\":\"3.5.0\"}}" ;;
  "GET http://prometheus.invalid/api/v1/status/config")
    rf="rule_files:\n- /etc/config/recording_rules.yml\n- /etc/config/alerting_rules.yml\n"; [[ -n "${NO_RULE_FILES+x}" ]] && rf=""
    al="alerting:\n  alertmanagers:\n  - kubernetes_sd_configs:\n    - role: pod\n"; [[ -n "${NO_ALERTING+x}" ]] && al=""
    body="$(jq -nc --arg y "$(printf "global:\n  scrape_interval: 30s\n${al}${rf}")" "{status:\"success\",data:{yaml:\$y}}")" ;;
  "GET http://prometheus.invalid/api/v1/rules"*)
    if [[ -n "${NO_RULES+x}" ]]; then body="{\"status\":\"success\",\"data\":{\"groups\":[]}}"
    elif [[ -n "${DROP_RULE:-}" ]]; then body="$(jq -c --arg d "${DROP_RULE}" ".data.groups[0].rules |= map(select(.name != \$d))" "${RULES}")"
    else body="$(cat "${RULES}")"; fi ;;
  "GET http://prometheus.invalid/api/v1/alertmanagers")
    am="{\"url\":\"http://alertmanager:9093/api/v2/alerts\"}"; [[ -n "${NO_AM+x}" ]] && am=""
    dr=""; [[ -n "${DROPPED_AM+x}" ]] && dr="{\"url\":\"http://10.0.0.9:9093/api/v2/alerts\"}"
    body="{\"status\":\"success\",\"data\":{\"activeAlertmanagers\":[${am}],\"droppedAlertmanagers\":[${dr}]}}" ;;
  "GET http://alertmanager.invalid/api/v2/receivers")
    if [[ -n "${AM_DEFAULT_CONFIG+x}" ]]; then body="[{\"name\":\"default-receiver\"}]"
    else body="[{\"name\":\"null\"},{\"name\":\"${RECEIVER:-oncall}\"}]"; fi ;;
  "POST http://alertmanager.invalid/api/v2/alerts") body="" ;;
  "GET http://alertmanager.invalid/api/v2/alerts"*)
    run="$(jq -r ".[0].labels.nip_check" "${POSTED}")"
    r="${RECEIVER:-oncall}"; [[ -n "${AM_DEFAULT_CONFIG+x}" ]] && r=default-receiver
    body="[{\"labels\":{\"alertname\":\"NipAcceptanceTest\",\"nip_check\":\"${run}\"},\"status\":{\"state\":\"active\"},\"receivers\":[{\"name\":\"${r}\"}]}]" ;;
  *) code=404; body="{\"error\":\"not found\"}" ;;
esac
printf "%s" "${body}"; (( w )) && printf "\n%s" "${code}"
exit 0'
export RESULTS_DIR="${work}/results" GRAFANA_URL=http://grafana.invalid PROMETHEUS_URL=http://prometheus.invalid \
  ALERTMANAGER_URL=http://alertmanager.invalid O11Y_ALERT_WAIT_S=2 O11Y_POLL_S=0
sentinel="nip-test-grafana-token-0000"
check() { set +e; env GRAFANA_TOKEN="${sentinel}" "$@" bash "${repo_root}/recipes/observability/acceptance.sh" >"${work}/out" 2>&1; echo $?; set -e; }
result() { jq -r "$1" "${RESULTS_DIR}/o11y-acceptance.json"; }
causes() { result '[.details.causes[].class] | join(",")'; }
# `terraform output -json o11y_provisioning` of a stack (modules/o11y output `provisioning`).
provisioning() {
  jq -n --argjson p "$1" --argjson r "${2:-13}" '{datasources:{provisioned:$p, uids:(if $p then ["nebius-provider-metrics","nebius-ingested-metrics","nebius-logs","nebius-traces"] else [] end), token_secret:(if $p then "grafana-nebius-token" else null end), missing_input:(if $p then null else "grafana_datasource_token_secret is unset, so the in-cluster Grafana gets none of the Nebius data sources. They need an OBSERVABILITY static key ..." end)}, alerting:{rule_groups:["nip-inference"], rules:$r, alertmanager:true, receiver_config:"inline"}}' >"${work}/provisioning.json"
  echo "${work}/provisioning.json"
}

test_name=o11y-acceptance-pass
rc="$(check)"
[[ "${rc}" == 0 && "$(result .status)" == pass ]] || { cat "${work}/out" >&2; fail "everything healthy must pass (rc ${rc})"; }
[[ "$(result '.details.grafana.datasources | length')" == 4 && "$(result '[.details.grafana.datasources[].health] | unique | join(",")')" == OK ]] \
  || fail "four data sources, each healthy: $(result .details.grafana)"
[[ "$(result '.details.alerts.rules_missing | length')" == 0 && "$(result '.details.alerts.rules_loaded')" -ge 13 ]] || fail "every platform/alerts rule loaded: $(result .details.alerts)"
[[ "$(result '.details.alerts.test_alert.receivers | join(",")')" == oncall ]] || fail "the test alert's receivers are recorded"
[[ "$(result '.details.causes | length')" == 0 ]] || fail "a passing run names no cause: $(causes)"
jq -e '.[0].labels.alertname == "NipAcceptanceTest" and .[0].endsAt != null' "${POSTED}" >/dev/null || fail "the test alert carries its name and an end time"
grep -qF "${sentinel}" "${LOG}" "${work}/out" "${RESULTS_DIR}/o11y-acceptance.json" && fail "the Grafana token reached argv, the output or the result"
ok "data sources provisioned and healthy; rules loaded; test alert active and routed"

test_name=o11y-acceptance-grafana-failures
rc="$(check NO_TRACES=)"
[[ "${rc}" != 0 && "$(result '.details.grafana.missing | join(",")')" == nebius-traces ]] || fail "a data source not provisioned fails (rc ${rc})"
rc="$(check BAD_DS=nebius-logs)"
[[ "${rc}" != 0 ]] || fail "a data source whose health check fails must fail (rc ${rc})"
[[ "$(result '.details.grafana.datasources[] | select(.uid == "nebius-logs") | .health')" == ERROR ]] || fail "the failing health is recorded: $(result .details.grafana)"
[[ "$(causes)" == datasource_token_rejected ]] || fail "a 401 from Nebius is the token (missing from Grafana's environment, wrong, or without viewer): $(causes)"
rc="$(check BAD_DS=nebius-traces BAD_DS_MSG="dial tcp: i/o timeout")"
[[ "${rc}" != 0 && "$(causes)" == datasource_unhealthy ]] || fail "any other health failure is datasource_unhealthy: $(causes)"
# The ingested-metrics source answers 404 until something writes metrics (runbooks/observability.md).
rc="$(check BAD_DS=nebius-ingested-metrics O11Y_DATASOURCES="nebius-provider-metrics nebius-logs nebius-traces")"
[[ "${rc}" == 0 && "$(result '.details.grafana.expected | length')" == 3 ]] || fail "O11Y_DATASOURCES narrows the sources that must be healthy (rc ${rc})"
rc="$(check O11Y_DATASOURCES="nebius-no-such-source")"
[[ "${rc}" == 2 ]] || fail "a source not in datasources.yaml is refused (rc ${rc})"
ok "a missing or unhealthy data source fails with its cause; O11Y_DATASOURCES narrows the set"

test_name=o11y-acceptance-grafana-causes
# The 2026-10-12 sandbox shape: Grafana up (db ok), none of the four sources.
rc="$(check NO_DATASOURCES=)"
[[ "${rc}" == 1 && "$(causes)" == datasources_not_provisioned ]] || fail "no sources and no plan output: not provisioned (rc ${rc}): $(causes)"
grep -q 'O11Y_PROVISIONING' "${work}/out" || fail "the hint says how to tell which input is missing"
rc="$(check NO_DATASOURCES= O11Y_PROVISIONING="$(provisioning false)")"
[[ "${rc}" == 1 && "$(causes)" == datasources_token_secret_unset ]] || fail "the plan said no token Secret: that is the cause (rc ${rc}): $(causes)"
grep -q 'OBSERVABILITY static key' "${work}/out" || fail "the Nebius-side input is named in the output"
rc="$(check NO_DATASOURCES= O11Y_PROVISIONING="$(provisioning true)")"
[[ "${rc}" == 1 && "$(causes)" == datasources_not_applied ]] || fail "sent by Terraform but absent in Grafana: not applied (rc ${rc}): $(causes)"
rc="$(check GRAFANA_401=)"
[[ "${rc}" == 1 && "$(causes)" == grafana_auth_failed && "$(result '.details.grafana.http_status')" == 401 ]] || fail "a 401 from Grafana is not '0 data sources' (rc ${rc}): $(causes)"
rc="$(check UNREACHABLE=grafana O11Y_PARTS=grafana)"
[[ "${rc}" == 1 && "$(causes)" == grafana_unreachable ]] || fail "a closed port is unreachable, not '0 data sources' (rc ${rc}): $(causes)"
rc="$(check O11Y_PROVISIONING="${work}/no-such-file.json")"
[[ "${rc}" == 2 ]] || fail "an O11Y_PROVISIONING file that does not exist is refused (rc ${rc})"
ok "missing sources say why: token Secret unset, values not applied, Grafana auth, Grafana unreachable"

test_name=o11y-acceptance-alert-failures
rc="$(check DROP_RULE=GpuXidError)"
[[ "${rc}" != 0 && "$(result '.details.alerts.rules_missing | join(",")')" == GpuXidError && "$(causes)" == rules_missing ]] || fail "a rule Prometheus did not load fails (rc ${rc}): $(causes)"
rc="$(check NO_AM=)"
[[ "${rc}" != 0 && "$(result '.details.alerts.alertmanagers')" == 0 && "$(causes)" == alertmanager_not_discovered ]] || fail "Prometheus without an Alertmanager fails (rc ${rc}): $(causes)"
rc="$(check NO_AM= DROPPED_AM=)"
[[ "${rc}" != 0 && "$(causes)" == alertmanager_dropped_by_relabel ]] || fail "an Alertmanager Prometheus found and dropped is a relabel mismatch: $(causes)"
rc="$(check EXPECT_RECEIVER=oncall RECEIVER=null)"
[[ "${rc}" != 0 && "$(result '.details.alerts.test_alert.null_only')" == true && "$(causes)" == receiver_not_reached ]] || fail "routed only to the null receiver while EXPECT_RECEIVER=oncall fails (rc ${rc}): $(causes)"
rc="$(check RECEIVER=null)"
[[ "${rc}" == 0 && "$(result '.details.alerts.test_alert.null_only')" == true ]] || fail "without EXPECT_RECEIVER the null route passes and is flagged (rc ${rc})"
[[ "$(result '[.details.causes[] | select(.severity == "note") | .class] | join(",")')" == receiver_null_only ]] || fail "the null-only route is a note: $(causes)"
ok "a missing rule, no Alertmanager, or the wrong receiver fails with its cause"

test_name=o11y-acceptance-alert-causes
# The 2026-10-12 sandbox shape: 0 of 13 rules, 0 Alertmanagers, while Alertmanager answers.
rc="$(check NO_RULES= NO_RULE_FILES= NO_ALERTING= O11Y_FIRE=0)"
[[ "${rc}" == 1 && "$(causes)" == prometheus_config_no_rule_files,prometheus_config_no_alerting ]] || fail "the running config without rule_files and alerting says so (rc ${rc}): $(causes)"
rc="$(check NO_RULES= O11Y_FIRE=0)"
[[ "${rc}" == 1 && "$(causes)" == rules_not_loaded ]] || fail "rule file named but empty: not loaded (rc ${rc}): $(causes)"
rc="$(check NO_RULES= O11Y_FIRE=0 O11Y_PROVISIONING="$(provisioning true 0)")"
[[ "${rc}" == 1 && "$(causes)" == rules_not_sent ]] || fail "the plan sent no rules: not sent (rc ${rc}): $(causes)"
rc="$(check NO_RULES= O11Y_FIRE=0 O11Y_PROVISIONING="$(provisioning true 13)")"
[[ "${rc}" == 1 && "$(causes)" == rules_sent_not_loaded ]] || fail "sent 13, loaded 0: the values did not reach Prometheus (rc ${rc}): $(causes)"
rc="$(check UNREACHABLE=prometheus O11Y_FIRE=0)"
[[ "${rc}" == 1 && "$(causes)" == prometheus_unreachable && "$(result '.details.alerts.rules_loaded')" == null ]] || fail "a closed Prometheus port is unreachable, not '0 rules' (rc ${rc}): $(causes)"
rc="$(check AM_DEFAULT_CONFIG=)"
[[ "${rc}" == 1 && "$(causes)" == alertmanager_config_not_applied ]] || fail "only the chart's default-receiver: our config did not arrive (rc ${rc}): $(causes)"
rc="$(check UNREACHABLE=alertmanager)"
[[ "${rc}" == 1 && "$(causes)" == alertmanager_unreachable ]] || fail "a closed Alertmanager port is unreachable (rc ${rc}): $(causes)"
ok "zero rules or Alertmanagers say why: config, not sent, sent but not loaded, unreachable, default config"

test_name=o11y-acceptance-parts
: > "${LOG}"
rc="$(check O11Y_PARTS=grafana)"
[[ "${rc}" == 0 ]] || fail "grafana alone (rc ${rc})"
grep -q 'alertmanager.invalid' "${LOG}" && fail "O11Y_PARTS=grafana sends no alert"
rc="$(check O11Y_PARTS=alerts O11Y_FIRE=0)"
[[ "${rc}" == 0 && "$(result '.details.alerts.test_alert.skipped')" == true ]] || fail "O11Y_FIRE=0 checks rules and wiring without sending an alert (rc ${rc})"
rc="$(check GRAFANA_TOKEN= GRAFANA_USER= O11Y_PARTS=grafana)"
[[ "${rc}" == 2 ]] || fail "Grafana without credentials is refused (rc ${rc})"
ok "parts run on their own; refuses Grafana without credentials"
