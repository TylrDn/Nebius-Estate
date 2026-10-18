# Observability runbook — R14 read metrics, logs and traces; Grafana; journald; console alerts

Read any Nebius signal of a project from a terminal during an incident, connect a Grafana to all of
them, switch on journald for a node group, and set a console alert. Which signal lives where, and
why: [`recipes/observability`](../recipes/observability/README.md#which-signal-comes-from-where). The
scripts ran read-only against a real project on 2026-10-11
([evidence](../docs/evidence/2026-10-11-observability-read-only.md)); the Grafana, journald and
console-alert steps have not run yet.

Who: anyone in a group with `viewer` for reading; `editor` for log exports, the stage's apply path for
journald. Risk: **read-only**, except journald (recreates every node of the group) and console
alerts (a notification only).

Upstream references: [metrics in Grafana](https://docs.nebius.com/observability/metrics/grafana#how-to-connect-grafana-data-source),
[logs from the CLI](https://docs.nebius.com/observability/logs/nebius-cli#running-log-queries),
[LogQL limits](https://docs.nebius.com/observability/logs/query-language#limitations),
[journald on MK8s](https://docs.nebius.com/kubernetes/logs#how-to-enable-journald-logs),
[alerts](https://docs.nebius.com/observability/alerts).

## Read during an incident

```bash
export NEBIUS_PROFILE=nip-portal-viewer NEBIUS_PROJECT_ID=<stage project>   # or NEBIUS_IAM_TOKEN
```

| # | Question | Command | Expect |
|---|---|---|---|
| 1 | Which log buckets have data? | `recipes/observability/logs.sh buckets --since 24h` | `sp_serial`, `sp_mk8s_control_plane`, `default` once the agent runs; a service bucket appears only after the service wrote to it |
| 2 | Control-plane errors (scheduling, autoscaler, node events) | `recipes/observability/logs.sh query '{level="error"}' --bucket sp_mk8s_control_plane --since 30m` | newest first; filter with `k8s_namespace_name`, `component` (`logs.sh labels --bucket sp_mk8s_control_plane`) |
| 3 | A VM or node that does not come up | `recipes/observability/logs.sh query '{} \|= "error"' --bucket sp_serial --since 1h` | serial console lines, newest first |
| 4 | Pod logs of a namespace | `recipes/observability/logs.sh query '{k8s_namespace_name="inference"}' --bucket default --since 15m` | needs the observability agent (`modules/o11y`) |
| 5 | GPU utilisation and errors per VM | `recipes/observability/metrics.sh query 'avg by (instance_id) (DCGM_FI_DEV_GPU_UTIL)'`; `… query 'increase(DCGM_FI_DEV_XID_ERRORS[10m]) > 0'` | one row per GPU VM; the second empty when healthy |
| 6 | Pending pods (cluster state) | `recipes/observability/metrics.sh --ingested query 'sum by (namespace) (kube_pod_status_phase{phase="Pending"})'` | needs the agent's cluster metrics |
| 7 | Can our alert rules see their metrics here? | `recipes/observability/metrics.sh coverage` | `no` in both columns: the rule runs only in-cluster or its metric was renamed ([recipe](../recipes/observability/README.md#findings-from-the-read-only-run)) |

A `--since` above 14 days is refused: logs are kept 14 days. To keep an incident's logs, export them
to a bucket before they expire ([export](https://docs.nebius.com/observability/logs/export#how-to-export-logs);
`editor`; 3 pending exports per region).

## Connect Grafana

1. A read-only service account in a group with `viewer` (the portal's, [`docs/credentials.md`](../docs/credentials.md#portal-read-only-service-account))
   and an OBSERVABILITY static key for it
   ([credentials](../docs/credentials.md#observability-static-key)); the key goes into `.env`
   as `PROMETHEUS_TOKEN`, never into a file in the repository.
2. Copy [`recipes/observability/grafana/datasources.yaml`](../recipes/observability/grafana/datasources.yaml)
   into `<grafana>/provisioning/datasources/` and start Grafana with `NEBIUS_PROJECT_ID` and
   `PROMETHEUS_TOKEN` in its environment.
3. **Connections → Data sources**: each source **Save & test** → "Successfully queried the
   Prometheus API" (metrics), "Data source successfully connected" (logs), a success message
   (traces). The ingested-metrics source answers 404 until something has written metrics to the project.
4. Import the Nebius dashboards from the Grafana marketplace
   ([dashboards](https://docs.nebius.com/observability/dashboards#installing-a-dashboard-in-grafana)).
5. Scripted check of 2–3: `GRAFANA_URL=… GRAFANA_TOKEN=… O11Y_PARTS=grafana recipes/observability/acceptance.sh`
   (a Grafana service account token, from the environment, never on the command line history): every
   source in the file provisioned and passing Grafana's health check; leave `nebius-ingested-metrics`
   out with `O11Y_DATASOURCES` until the agent writes metrics. Result: `results/o11y-acceptance.json`.
6. Record the run (Grafana version, which sources tested OK) in `docs/evidence/` and flip the
   recipe's evidence row.

### In-cluster Grafana (`modules/o11y`)

The Grafana that R1/R3 install gets the same four sources as its own provisioning file, once it can
authenticate. The one Nebius-side input is an OBSERVABILITY static key of a service account in a group
with `viewer` ([prerequisites](https://docs.nebius.com/observability/metrics/grafana#prerequisites),
[credentials](../docs/credentials.md#observability-static-key)); it never passes through Terraform:

1. Set `grafana_datasource_token_secret = "grafana-nebius-token"` (tfvars or
   `TF_VAR_grafana_datasource_token_secret`) before the plan that is applied; the Secret need not exist
   yet. Without it the plan output `o11y_provisioning.datasources.missing_input` says the sources are not
   provisioned and why; it is not an error, the rest of the release still applies.
2. Once the `o11y` namespace exists (after the apply), put the key into the Secret, read at a silent
   prompt so it is in no shell history: `read -rs PROMETHEUS_TOKEN; kubectl -n o11y create secret generic
   grafana-nebius-token --from-literal=PROMETHEUS_TOKEN="$PROMETHEUS_TOKEN"; unset PROMETHEUS_TOKEN`.
3. Grafana reads the Secret as environment variables (`envFromSecrets`, optional, so Grafana starts
   without it) and only at start: after creating or rotating it,
   `kubectl -n o11y rollout restart deploy/grafana-and-prometheus`.
4. `terraform -chdir=terraform/live/<stage>/<stack> output -json o11y_provisioning > .cache/o11y-provisioning.json`
   and run the acceptance with `O11Y_PROVISIONING=.cache/o11y-provisioning.json`: a missing source then
   says whether the input was never set or the values did not arrive
   ([cause classes](../recipes/observability/README.md#acceptance-cause-classes)).

The Marketplace app's chart versions are not published; the keys used (`grafana.datasources`,
`grafana.env`, `grafana.envFromSecrets`) are those of the Grafana community chart. If the acceptance
reports `datasources_not_applied`, read the Grafana ConfigMaps (`kubectl -n o11y get cm -o yaml | grep -n
nebius.yaml`) before anything else and record the result in `docs/evidence/`.

### Alerts end to end (in-cluster Prometheus and Alertmanager, `modules/o11y`)

Alertmanager is on where the stage policy sets it (staging, prod); in sandbox export
`TF_VAR_alertmanager_enabled=true` before the plan that is applied. The rules load in every stage. Port-forward
the Prometheus server and Alertmanager services (`kubectl -n o11y get svc` names them; the Prometheus
server service listens on port 80, so `port-forward svc/<...-server> 9090:80`), then
`O11Y_PARTS=alerts PROMETHEUS_URL=http://127.0.0.1:9090 ALERTMANAGER_URL=http://127.0.0.1:9093
O11Y_PROVISIONING=.cache/o11y-provisioning.json EXPECT_RECEIVER=<receiver> recipes/observability/acceptance.sh`:
the running config names the rule file and an Alertmanager, every rule in `platform/alerts/*.yaml`
loaded and healthy, Prometheus connected to an Alertmanager that runs our config (not the chart's
`default-receiver`), and a test alert `NipAcceptanceTest`
(severity `warning`, resolves after 5 minutes) active and routed to `<receiver>`; a route that reaches
only the `null` receiver is flagged. It is the one write: an alert into the cluster's Alertmanager, as
`amtool alert add` in [`alerting.md`](alerting.md); `O11Y_FIRE=0` checks rules and wiring only. Any
failure names its [cause class](../recipes/observability/README.md#acceptance-cause-classes). Confirm
delivery at the receiver and record both in `docs/evidence/`.

## Switch on journald for a node group

Set at creation if possible: instance metadata labels recreate every node of the group when changed
([journald](https://docs.nebius.com/kubernetes/logs#how-to-enable-journald-logs)).

1. In the stage's R1/R3 tfvars: `journald_logs = true`, `journald_units = "kubelet.service;containerd.service"`.
2. Plan: every node of the group is replaced; with surge capacity (`gpu_rollout_surge`) or in a
   maintenance window ([`change-management.md`](../docs/change-management.md)). Apply through the normal path.
3. Check: `recipes/observability/logs.sh labels --bucket default` lists `mk8s_cluster_id` and
   `SYSTEMD_UNIT`; `logs.sh query '{mk8s_cluster_id="<cluster id>"}' --bucket default --since 15m` shows
   kubelet lines.

## Set a console alert (Compute VM or Object Storage bucket)

**Observability → Alerts → Create alert**: metric, condition, threshold, duration; then **Add email**
(a verified address; admins can pick tenant contacts) ([alerts](https://docs.nebius.com/observability/alerts)).
There is no API or Terraform resource for these alerts: record each one (resource, metric, threshold,
recipient) in the stage's evidence file so it can be recreated. Statuses: `Firing`, `Pending`,
`Normal`. Everything else pages through Alertmanager ([`alerting.md`](alerting.md)).
