# Fleet alerts runbook — GPU health, idle GPUs and portal connectors

What to do when an alert from `platform/alerts/` fires in Nebius Estate (Alerts page) or in a
cluster's Prometheus. Every step here is read-only; the changes listed under "Fix" are made through
Terraform and review (`runbooks/deploy.md`), never from the portal.

The portal evaluates the same rule files after each sync: rules on DCGM, node and disk metrics run
against Nebius Monitoring with the portal's read-only identity; rules on `nebius_estate_*` signals
come from the inventory; rules that need kube-state-metrics, kubelet or vLLM metrics are listed as
"needs in-cluster Prometheus" and run in the cluster when Alertmanager is enabled
([alerting runbook](alerting.md)).

## GPU idle

A GPU has stayed below 5 % utilisation for an hour while its VM keeps running (and billing).

Checks:

1. Open the GPU on the Fleet page (24 h range): idle since a job finished, or idle all along?
2. Workloads page: is anything scheduled on the node? A pod Pending elsewhere may be waiting for a
   different node group.
3. For a node group, look at the other GPUs of the group: one idle GPU of eight is a scheduling
   question; a whole idle group is a sizing question.

Fix: scale the node group down (`gpu_node_count`, or the autoscaling minimum) or tear the stage down
(`runbooks/teardown.md`). For a standalone VM, stop or delete it. The idle-cost figure on Fleet is an
estimate at the live price, not a bill.

## GPU hot or throttling

GPU temperature at or above 85 °C for five minutes, or clocks throttled under load.

Checks:

1. Fleet page, temperature and power toggles: one GPU or every GPU of the VM? A single hot GPU next
   to cool ones points at the hardware; all of them at a sustained load.
2. Serial-console logs of the VM (Logs page, preset "Serial-console errors") for thermal or Xid
   messages.
3. Scheduled maintenance for the VM (GPU & Capacity page).

Fix: none on our side for a single hot GPU — open a support case with the VM id and the time range
([escalating](incident.md#escalating-to-nebius-support)). For a whole node under sustained load,
reduce the batch size or spread replicas across nodes.

## GPU Xid or ECC errors

DCGM reported an Xid error or uncorrectable (double-bit) ECC errors: the GPU is not reliable.

Checks:

1. Serial-console logs of the VM around the alert time: `NVRM: Xid` lines give the Xid code.
2. Nebius maintenance on the VM (GPU & Capacity page): GPU errors often lead to a maintenance event
   with a reason code.

Fix: cordon and drain the node (`kubectl cordon`, `kubectl drain` — a change, made by the on-call
engineer, not the portal), let the node group replace it, and open a support case with the Xid code.

## GPU node not Ready

A GPU node left Ready. Checks: the node's conditions (`kubectl describe node`, read-only), the node
group's rollout in the MK8s console, and the control-plane logs (Logs page, preset "Control-plane
errors"). Managed Kubernetes health checks may already be replacing the node.

Fix: none while a health check replaces the node; otherwise drain it and let the node group recreate it.

## GPU metrics missing

GPU nodes exist but no DCGM series arrive. Checks: the observability agent and the device plugin
DaemonSets on the cluster (`kubectl get ds -A`, read-only), and `tests/validate/01-gpu.sh`.

Fix: restore the device plugin or the agent release (`dcgm_exporter_enabled = true`) through Terraform.

## Connector failing

One of the portal's connectors (inventory, Monitoring, Logs, pricing, billing export, a cluster) failed
its last syncs or its data is older than its freshness bound. Figures that depend on it are shown as
stale, never as zero.

The connector of a discovered cluster that is deleting or gone never raises this alert: it is retired
at once (state "retired" on Integrations, with the cluster and project names and the time it was last
seen) and its last snapshot is kept, marked stale, until it is removed.

Checks:

1. Integrations page: the connector's last error, HTTP status and failure streak.
2. A 401/403 names the role to grant; a timeout or 5xx is usually transient (the connector retries
   with backoff).
3. `yarn verify:live` from `portal/` with the repository `.env` loaded re-checks every call.

Fix: grant the missing role to the portal's group (`docs/portal/nebius-setup.md`), or correct the
credential variables in `.env`. The portal keeps reading with the last good data meanwhile.
