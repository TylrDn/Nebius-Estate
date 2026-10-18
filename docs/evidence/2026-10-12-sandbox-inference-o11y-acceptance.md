# sandbox/inference observability acceptance (R14) — 2026-10-12

- **Kind:** run of this repository (`recipes/observability/acceptance.sh` against the o11y releases that
  `terraform/live/sandbox/inference` installs through `terraform/modules/o11y`), the first run of R14's
  acceptance against a live cluster; run 2, step 6, of the
  [live-run plan](../plans/2026-10-12-live-runs.md).
- **Date / region / platform:** 2026-10-12, 19:37:24–19:37:50 UTC, `eu-north1`, on the R1 cluster of the
  [validation run](2026-10-12-sandbox-inference-validate.md) (o11y installed 9 min earlier).
- **Versions:** Grafana `13.2.2` (database `ok`) as reported by `/api/health`; the Prometheus and
  Alertmanager versions were not read.
- **Method:** port-forwards from the operator host: Grafana `svc/grafana-and-prometheus:80`, Prometheus
  **also** `svc/grafana-and-prometheus:80`, Alertmanager `svc/grafana-and-prometheus-alertmanager:9093`;
  all three answered 2xx on their health or ready paths. The script compares Grafana's data sources with
  `grafana/datasources.yaml`, Prometheus `/api/v1/rules` with `platform/alerts/*.yaml`, reads
  `/api/v1/alertmanagers`, and posts a `NipAcceptanceTest` alert to Alertmanager and reads back its
  receivers. `EXPECT_RECEIVER` unset (sandbox routes to a null receiver).
- **Cost:** none beyond the R1 cluster.

## Results

Raw: [`o11y-acceptance.json`](../../results/2026-10-12/o11y-acceptance.json) (scrubbed).

| Check | Result |
|---|---|
| Grafana data sources | **fail**: none provisioned; all four expected (`nebius-provider-metrics`, `nebius-ingested-metrics`, `nebius-logs`, `nebius-traces`) missing |
| Alert rules | **fail**: 0 of 13 loaded, 0 Alertmanagers attached — but the Prometheus port-forward pointed at the Grafana service, not `svc/prometheus-server` (listed in the same namespace), so these two figures may describe the wrong service. Whether the rules were loaded is **unknown** |
| Test alert | posted, `active`, routed to the `null` receiver only (the sandbox default); delivery to a real receiver not tested |

The cluster had both `grafana-and-prometheus` and `prometheus-server` services; which one serves the
Prometheus API with the R14 rules is a property of the Marketplace release that the cached docs do not
state (unknown here).

## What this does and does not show

- Shows: the o11y releases come up with the cluster, Grafana and Alertmanager answer, an alert can be
  posted and routed; R14's data sources are **not** provisioned into that Grafana by the current module
  (this repository's gap, not a Nebius finding).
- Does not show: any Nebius signal in Grafana, whether the alert rules load (the check read the wrong
  service), traces, journald, or an alert reaching a person.
