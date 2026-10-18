# Alerting runbook: wire a real receiver for a stage

Alerting rules live in `platform/alerts/*.yaml` and load in every stage whose policy enables
Alertmanager (`alertmanager` in the [stage policy](../platform/README.md#stage-policy)). Until a receiver is wired, alerts fire
into a **null receiver**: visible in Alertmanager, nobody is paged. Targets: [docs/slo.md](../docs/slo.md).

## Receivers with credentials (Slack/PagerDuty/webhook): use a Secret, not tfvars

The receiver's URL or routing key must not appear in git **or** in Terraform state, so the stack
only takes the *name* of a Secret you create in the cluster:

```bash
# 1. write the full Alertmanager config locally (never commit it)
cat > /tmp/alertmanager.yml <<'YAML'
route:
  receiver: oncall
  group_by: [alertname, namespace]
  routes:
    - matchers: [severity="info"]
      receiver: "null"
receivers:
  - name: "null"
  - name: oncall
    webhook_configs:
      - url: https://hooks.example.invalid/REPLACE   # your receiver
YAML
# 2. create the Secret in the o11y namespace (key name must be alertmanager.yml)
kubectl -n o11y create secret generic alertmanager-config --from-file=alertmanager.yml=/tmp/alertmanager.yml
rm /tmp/alertmanager.yml
```

3. In `terraform/live/<stage>/<stack>/<stage>.auto.tfvars` set `alertmanager_config_secret = "alertmanager-config"`,
   then plan/apply through the normal path ([change-management](../docs/change-management.md)).
4. Prove it: fire a test alert (`amtool alert add TestAlert severity=warning` against the Alertmanager
   service, or scale a test Deployment to an unschedulable request) and record the delivery in
   `docs/evidence/`.

Rotate a receiver by updating the Secret (`kubectl create secret … --dry-run=client -o yaml | kubectl apply -f -`)
and restarting Alertmanager; no Terraform change is needed.

## How the Secret reaches Alertmanager (not yet verified on a live cluster)

The Marketplace `nebius/grafana-and-prometheus` app wraps the Prometheus community chart, whose
Alertmanager is the `alertmanager` subchart (2.x). That subchart has no `configFromSecret` (the key of
the old built-in Alertmanager, which earlier versions of this module set and the subchart silently
ignored), so the module mounts the Secret with `extraSecretMounts` at `/etc/alertmanager-secret` and
points `--config.file` at its `alertmanager.yml` (`extraArgs`). The app's own chart versions are not
published (unknown). On the first deploy, `recipes/observability/acceptance.sh` checks it: Alertmanager
listing only `default-receiver` is `alertmanager_config_not_applied`. The config reloader watches the
chart's ConfigMap, not the Secret, so a Secret change needs the restart below.

## What Nebius-managed alerts cover (checked 2026-10-11)

[Observability alerts](https://docs.nebius.com/observability/alerts) cover only Compute VMs and
Object Storage buckets, are set up in the console and notify by email. They cannot evaluate the
PromQL rules in `platform/alerts/`, and the provider's recording-rule resource
(`nebius_monitoring_v1_recording_rule`) was removed, so the in-cluster Prometheus and Alertmanager
stay the rule engine. A console alert on a bucket (for example the checkpoint bucket) is a useful
addition, recorded in `docs/evidence/` like any manual setting.

## Receivers without credentials

`alertmanager_config` (inline, in tfvars) is fine for a receiver that needs no secret, for example
routing everything to a team's in-cluster webhook.
