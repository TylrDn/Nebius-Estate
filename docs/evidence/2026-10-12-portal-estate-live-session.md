# Portal (Nebius Estate) during the live session, and a real network outage — 2026-10-12

- **Kind:** run of this repository: the portal (`portal/`, local backend on loopback with the read-only
  portal identity) watching the run-2 roots of the [session](2026-10-12-sandbox-session-lifecycle.md),
  and the outage test of its retry and wake fixes (F1.30, F1.31, F1.45). No Terraform root ran from the
  portal; it only reads.
- **Date / region:** 2026-10-12: long outage 16:23Z, run-2 roots 19:11–20:01Z, short outage (time not
  recorded); `eu-north1` (the sandbox project) within the one tenant the portal reads.
- **Versions:** the portal at the session's commit; Nebius public REST API as served on the day.
- **Method:** the portal's scheduled and manual inventory syncs, its Kubernetes connector and Fleet
  telemetry, read through its own UI and API. Outage: Wi-Fi (`en0`) turned off on the host, a sync
  started into the outage, Wi-Fi back (the short case inside the ~30 s retry budget; the long case
  outside it), the inventory connector's state and last run read back from `/api/nebius-estate/integrations`.
- **Cost:** none (GET calls only).
- **Source:** the owner's record of the session (observations and the outage script's result lines); the
  portal's own logs were not kept, so no figure here has a raw file.

## Results

| Check | Result |
|---|---|
| New resources | the run-2 resources appeared within **one sync**, with their `nip-run` and `nip-ttl-expires` labels and the TTL shown (for resources whose API keeps labels; MLflow keeps none, see [R12 2026-10-11](2026-10-11-sandbox-ml-services-live-recipe.md)) |
| Kubernetes connector | connected to the new R1 cluster by itself (no manual step) |
| Fleet telemetry | GPU series from the real L40S node |
| Run-rate | fell from **0.83 to 0.23 USD/h** during the session (which resources made up each figure was not recorded) |
| Alerts | `GpuIdle` went pending, later resolved |
| After deletion | **stale**: slow-tier lists still showed resources after they were deleted (how long was not recorded) |
| Short outage (about 10 s) | absorbed by the retries: the sync finished **ok** in 21 s |
| Long outage | the connector went **degraded**, last run `ok=false`, `ENOTFOUND after 10 attempts in 29 s`; it recovered once the network was back |

## What this does and does not show

- Shows: the portal follows a real session end to end (discovery with labels and TTL, cluster connection,
  GPU telemetry, run-rate, an alert's life cycle) and its retry budget behaves as designed under a real
  outage, both inside and outside the budget.
- Does not show: the slow-tier staleness fixed (it is a finding for the portal); billed amounts; any
  figure that can be re-read from a committed file.
