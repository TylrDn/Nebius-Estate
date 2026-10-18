#!/usr/bin/env bash
# Run 2 step 6: R14 acceptance. kubectl -n o11y get svc; port-forward Grafana, Prometheus and
# Alertmanager to local 13000/19090/19093 (R14_LOCAL_GRAFANA_PORT / _PROM_PORT / _AM_PORT override;
# 3000 is the Nebius Estate portal's (Backstage) port, which runs beside a session), passing
# GRAFANA_URL / PROMETHEUS_URL / ALERTMANAGER_URL to acceptance.sh; Grafana admin password at a
# silent prompt (Enter, or ASSUME_YES=1: read it from the inference root's state output, never
# printed); recipes/observability/acceptance.sh.
# Executed: bash run2-6-r14-acceptance.sh   EXPECT_RECEIVER=<receiver> (sandbox default: null, flagged)
# Service names are detected; override with GRAFANA_SVC / PROM_SVC / AM_SVC.
# Refuses while anything already listens on the chosen local ports: a forward that cannot bind
# would send the Grafana admin credentials to that local service.
# Data sources: step 2c names the token Secret (grafana-nebius-token, key PROMETHEUS_TOKEN). When .env
# has PROMETHEUS_TOKEN (an OBSERVABILITY static key, docs/credentials.md#observability-static-key) it is
# put into that Secret from stdin (never argv) and Grafana is restarted to read it; when it is absent the
# acceptance runs anyway, so the data-source part fails with a named cause class. The plan output
# o11y_provisioning goes to the acceptance (O11Y_PROVISIONING) so the class tells an unset input from
# values that did not arrive. state/run2.env: R14_TOKEN (created|absent), R14_CAUSES (failing classes).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-6-r14-acceptance
if [[ "${R14:-1}" == 0 ]]; then
  result_begin; say "VERDICT: SKIP (R14=0: Alertmanager and the data-source Secret were left out of this session's R1 plan)"; exit 0
fi
header "Run 2 step 6 - R14 observability acceptance" \
  "port-forwards to Grafana/Prometheus/Alertmanager; acceptance.sh (data sources healthy, every platform/alerts rule loaded, test alert routed)" \
  "\$0 extra" "about 3-5 min" "the RESULT block (o11y-acceptance.json) + whether delivery was seen at the receiver"
need kubectl jq curl terraform nebius lsof
need_tty
check_repo
load_env
kube_env
NS=o11y
run kubectl -n "${NS}" get svc

# The plan's o11y_provisioning output (what was sent to Grafana and Prometheus), for the cause classes.
boot inference
PROV="${STATE_DIR}/o11y-provisioning.json"
if terraform -chdir=terraform/live/sandbox/inference output -json o11y_provisioning > "${PROV}" 2>/dev/null && jq -e 'type == "object"' "${PROV}" >/dev/null 2>&1; then
  export O11Y_PROVISIONING="${PROV}"
  say "o11y_provisioning: datasources provisioned=$(jq -r '.datasources.provisioned // "?"' "${PROV}") token_secret=$(jq -r '.datasources.token_secret // "none"' "${PROV}")"
else
  rm -f "${PROV}"; say "WARNING: no o11y_provisioning output; the acceptance cannot tell an unset input from values that did not arrive"
fi

# The data-source token Secret from .env's PROMETHEUS_TOKEN (stdin, never argv), then a Grafana restart
# (it reads the Secret only at start). Server-side apply: a client-side apply would copy the whole manifest,
# token included, into the last-applied-configuration annotation. Absent: recorded, and the acceptance names the cause class.
tok="$(env_get PROMETHEUS_TOKEN)"
if [[ -n "${tok}" ]]; then
  say ">>> printf <PROMETHEUS_TOKEN from .env> | kubectl -n ${NS} create secret generic ${R14_TOKEN_SECRET} --from-file=PROMETHEUS_TOKEN=/dev/stdin --dry-run=client -o yaml | kubectl apply --server-side --field-manager=nip-live -f -"
  printf '%s' "${tok}" | kubectl -n "${NS}" create secret generic "${R14_TOKEN_SECRET}" --from-file=PROMETHEUS_TOKEN=/dev/stdin --dry-run=client -o yaml \
    | kubectl apply --server-side --field-manager=nip-live -f - >/dev/null || die "could not create the Secret ${NS}/${R14_TOKEN_SECRET}"
  unset tok
  gdep="$(kubectl -n "${NS}" get deploy -o json | jq -r '[.items[].metadata.name | select(test("grafana"))] | first // empty')"
  [[ -n "${gdep}" ]] || die "no Grafana Deployment in ${NS} to restart"
  run kubectl -n "${NS}" rollout restart "deploy/${gdep}"
  run kubectl -n "${NS}" rollout status "deploy/${gdep}" --timeout=5m
  state_set run2 R14_TOKEN created
else
  say "PROMETHEUS_TOKEN is not in .env: the ${R14_TOKEN_SECRET} Secret is not created; running the acceptance anyway (its data-source part fails with a named cause class)"
  state_set run2 R14_TOKEN absent
fi

# svc_for <regex> <port>: first Service whose name matches and that exposes <port> (else first match).
svc_for() {
  kubectl -n "${NS}" get svc -o json | jq -r --arg re "$1" --argjson p "$2" '
    [.items[] | select(.metadata.name | test($re)) | select(.metadata.name | test("operated|node-exporter|kube-state|operator|headless") | not)] as $c
    | ([$c[] | select([.spec.ports[].port] | index($p))] + $c) | first | .metadata.name // empty'
}
svc_port() { kubectl -n "${NS}" get svc "$1" -o json | jq -r --argjson p "$2" '[.spec.ports[].port] | if index($p) then $p else .[0] end'; }
G="${GRAFANA_SVC:-$(svc_for grafana 80)}"; P="${PROM_SVC:-$(svc_for prometheus 9090)}"; A="${AM_SVC:-$(svc_for alertmanager 9093)}"
[[ -n "${G}" && -n "${P}" && -n "${A}" ]] || die "could not find grafana/prometheus/alertmanager Services (got '${G}' '${P}' '${A}'); set GRAFANA_SVC/PROM_SVC/AM_SVC"
gp="$(svc_port "${G}" 80)"; pp="$(svc_port "${P}" 9090)"; ap="$(svc_port "${A}" 9093)"
# Local ports: 3000 is the Nebius Estate portal (and Backstage's dev port), so the forwards use 13000/19090/19093
# by default and acceptance.sh gets the URLs (GRAFANA_URL, PROMETHEUS_URL, ALERTMANAGER_URL).
LG="${R14_LOCAL_GRAFANA_PORT:-13000}" LP="${R14_LOCAL_PROM_PORT:-19090}" LA="${R14_LOCAL_AM_PORT:-19093}"
export GRAFANA_URL="http://127.0.0.1:${LG}" PROMETHEUS_URL="http://127.0.0.1:${LP}" ALERTMANAGER_URL="http://127.0.0.1:${LA}"
say "Grafana svc/${G}:${gp} -> ${LG}, Prometheus svc/${P}:${pp} -> ${LP}, Alertmanager svc/${A}:${ap} -> ${LA}"

for port in "${LG}" "${LP}" "${LA}"; do
  busy_by="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 {print $1 " pid " $2}' || true)"
  [[ -z "${busy_by}" ]] || die "127.0.0.1:${port} is already in use (${busy_by}; another tool; set R14_LOCAL_*_PORT to free ports): stop it or choose other ports, then rerun. A port-forward could not bind there, and the checks and the Grafana credentials would go to that service"
done

pf=()
cleanup() { local p; for p in "${pf[@]+"${pf[@]}"}"; do kill "${p}" 2>/dev/null || true; done; }
trap 'rc=$?; cleanup; _on_exit $rc' EXIT
kubectl -n "${NS}" port-forward "svc/${G}" "${LG}:${gp}" >"${STATE_DIR}/pf-grafana.log" 2>&1 & pf+=($!)
kubectl -n "${NS}" port-forward "svc/${P}" "${LP}:${pp}" >"${STATE_DIR}/pf-prometheus.log" 2>&1 & pf+=($!)
kubectl -n "${NS}" port-forward "svc/${A}" "${LA}:${ap}" >"${STATE_DIR}/pf-alertmanager.log" 2>&1 & pf+=($!)
pf_alive() { local p; for p in "${pf[@]}"; do kill -0 "${p}" 2>/dev/null || return 1; done; }
for u in "http://127.0.0.1:${LG}/api/health" "http://127.0.0.1:${LP}/-/ready" "http://127.0.0.1:${LA}/-/ready"; do
  ok=0
  for _ in $(seq 1 30); do
    pf_alive || die "a kubectl port-forward exited (port taken, or the Service is gone): see ${STATE_DIR}/pf-*.log"
    curl -sf -m 3 -o /dev/null "${u}" && { ok=1; break; }
    sleep 2
  done
  (( ok == 1 )) || die "port-forward not healthy at ${u} (see ${STATE_DIR}/pf-*.log)"
done
pf_alive || die "a kubectl port-forward exited after the health checks: see ${STATE_DIR}/pf-*.log"
say "port-forwards ${pf[*]} alive; Grafana /api/health, Prometheus and Alertmanager /-/ready answer 2xx"

GRAFANA_PW=""
if [[ "${ASSUME_YES}" != 1 ]]; then read -rs -p "Grafana admin password (hidden; Enter = read it from the inference state output): " GRAFANA_PW; echo; fi
if [[ -z "${GRAFANA_PW}" ]]; then
  GRAFANA_PW="$(terraform -chdir=terraform/live/sandbox/inference output -raw grafana_admin_password)"
fi
[[ -n "${GRAFANA_PW}" ]] || die "no Grafana password"
if [[ -n "${EXPECT_RECEIVER:-}" ]]; then say "EXPECT_RECEIVER=${EXPECT_RECEIVER}"; else say "EXPECT_RECEIVER unset: any receiver; sandbox's default null route is flagged by the script"; fi
rc=0
if [[ -n "${EXPECT_RECEIVER:-}" ]]; then export EXPECT_RECEIVER; fi
pf_alive || die "a kubectl port-forward exited before acceptance.sh (see ${STATE_DIR}/pf-*.log); the Grafana password was not sent"
GRAFANA_USER=admin GRAFANA_PASSWORD="${GRAFANA_PW}" recipes/observability/acceptance.sh || rc=$?
unset GRAFANA_PW
cleanup

causes="$(jq -r '[.details.causes[]? | select(.severity == "fail") | .class] | unique | join(",")' results/o11y-acceptance.json 2>/dev/null || true)"
state_set run2 R14_CAUSES "${causes}"

result_begin
say "acceptance.sh exit ${rc}"
state_load run2
say "data-source token Secret ${R14_TOKEN_SECRET}: ${R14_TOKEN:-?}; failing cause classes: ${causes:-none}"
jq -r '.details.causes[]? | "  \(.severity) \(.class) [\(.part)]: \(.detail)"' results/o11y-acceptance.json 2>/dev/null || true
jq -c '{status, details}' results/o11y-acceptance.json 2>/dev/null || say "results/o11y-acceptance.json missing"
say "BY HAND: confirm the NipAcceptanceTest alert arrived at the receiver (${EXPECT_RECEIVER:-none set}); say so when pasting back"
say "evidence: docs/evidence/<date>-sandbox-inference-o11y-acceptance.md"
(( rc == 0 )) || exit "${rc}"
say "next: bash ${LIVE_DIR}/run2-7-r5.sh"
