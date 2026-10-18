# Sandbox inference root: portal lifecycle and automated teardown, verified live — 2026-10-11

- **Kind:** run of this repository (`terraform/live/sandbox/inference`, R1), the third apply of a live
  root. Purpose: prove live what the earlier runs could only test offline — the automated destroy path
  and the portal's behaviour while a cluster appears and disappears. Approved within the owner's $20
  overnight budget.
- **Date / region / platform:** 2026-10-11, apply 12:26–12:35 UTC, destroy 12:51:16–13:01:47 UTC,
  `eu-north1`. `gpu-l40s-a` / `1gpu-8vcpu-32gb` × 1, preemptible; `cpu_node_count = 0`; 64 GiB shared
  filesystem. A safety-net teardown armed for 13:40 UTC (computed in UTC and checked: 4409 s) was not needed.
- **Versions:** provider `nebius/nebius` 0.6.67, Managed Kubernetes 1.36, Terraform 1.16.3 on the host.
- **Method:** `make init plan apply` with a git-ignored run override (labels `nip-run=teardown-verify-2026-10-11`,
  a 2 h TTL); then `make destroy-plan` and `make destroy CONFIRM=yes`; portal state read every 30 s from
  its API (guest token, GET only) by `scratchpad/portal-state.sh`.
- **Cost:** about 35 min of resources at ≈ $0.78/h list ≈ $0.45 estimated (not billed; the FOCUS export
  carries the billed figure later).

## Results

| Check | Result |
|---|---|
| Apply | `Plan: 12 to add`; `Apply complete! Resources: 12 added` in about 9 min; GPU node group untainted, preemptible |
| Portal discovery | the inventory sync after the cluster reached RUNNING connected it with no configuration: 11 workloads, GPU allocatable 1, Fleet `live` with 1 GPU running, the `mk8s:` connector `ok`. Until that sync (cadence 15 min) the connector said "Cluster is PROVISIONING; it is connected automatically once RUNNING" — true of the last snapshot, 12 min behind Nebius |
| GpuIdle | pending while the GPU sat idle, titled "GPU 0 on mk8snodegroup-…" (VM name, not the UUID); after the VM left the inventory it resolved on the next evaluation |
| Automated destroy | `make destroy-plan` wrote `zz_destroy_override.tf` itself ("public endpoint …; 3 in-cluster resource(s) to refresh"), `Plan: 0 to add, 0 to change, 12 to destroy.`, `Apply complete! Resources: 0 added, 0 changed, 12 destroyed.`, then `make destroy` removed the override. No manual step |
| Portal after teardown | Kubernetes connector `disabled`: "Retired: cluster nip-sandbox-inference no longer exists in project default-project-eu-north1 …" (not an error); Overview "No Kubernetes cluster in scope", "No GPUs running"; Fleet `runningNow` 0; **no PreemptibleNodeLost and no ConnectorFailing alert** |
| Leftovers | `scripts/leftovers.sh --stage sandbox`: "no leftovers … (state bucket excluded by design)" |

## What this does and does not show

- Shows: the destroy path for a root with in-cluster resources works unattended; the portal connects a
  new cluster by itself and retires it without false alerts; per-VM alerts resolve when the VM is gone.
- Did not show in the first run: the "cluster is being deleted" stale reason (15 min cadence); shown
  live in the second run below. Nor a crash-looping workload row (a workload apply needs the owner's kubectl).

## Second run: fast re-sync, verified live (13:28–13:58 UTC)

After this file's first run showed the 15 min inventory cadence hiding transitions, the portal gained a
lifecycle-aware fast re-sync (every 2 min while a cluster, node group or VM is provisioning, updating,
stopping or deleting; core lists only). A second identical apply/destroy (`nip-run=fast-sync-verify-2026-10-11`,
≈ 30 min, ≈ $0.40 estimated) proved it; one "Sync now" was pressed at the start of each phase, as a user would.

| Time (UTC) | Portal |
|---|---|
| 13:30:34 | inventory and `mk8s:` cards: next run because "a cluster is provisioning" |
| 13:32:34 | fast re-sync, 2 min later |
| 13:34:36 | cluster RUNNING → **connected on that fast sync**, 6 workloads; reason moves to "a node group is provisioning" (the first run waited 12 min here) |
| 13:38:41 | teardown: "a cluster is provisioning and a node group is being deleted" (Nebius reports the cluster as PROVISIONING while its node group is removed) |
| 13:47:12 | Workloads: **"Cluster is being deleted (inventory 13:47 UTC)"**; `mk8s:` card "Cluster is DELETING; not connected" |
| teardown | `make destroy-plan` wrote and `make destroy` removed the provider override again; `12 destroyed`; `leftovers.sh --stage sandbox`: no leftovers |

Gap found: fast re-syncs skip alert evaluation, so GpuIdle stayed listed for its deleted VM until the
next full sync; fast syncs now resolve per-VM alerts whose VM left the inventory (no Monitoring query).
