# sandbox/data run (R8 datasets and checkpoints) — 2026-10-11

- **Kind:** run of this repository (`terraform/live/sandbox/data`, R8), the first apply of this root.
  Approved within the owner's $10 cap for the live-recipe round.
- **Date / region / platform:** 2026-10-11, apply 18:39:58–18:40:14 UTC, destroy 18:45:53–18:46:13 UTC,
  `eu-north1`. Two buckets and a 256 GiB `NETWORK_SSD` shared filesystem, the sandbox sizing file as committed;
  no transfer, no filesystem bucket. Safety-net teardown armed for 20:09:49 UTC (5392 s, computed in UTC),
  disarmed after the destroy.
- **Versions:** provider `nebius/nebius` 0.6.67, Terraform 1.16.3.
- **Method:** `source scripts/bootstrap-backend.sh sandbox data`; a git-ignored `zz-run.auto.tfvars.json` with
  labels only (`nip-run=live-recipe-data-2026-10-11`, a 3 h TTL); `make init plan apply destroy-plan destroy
  STAGE=sandbox STACK=data`; bucket and filesystem settings read back with the CLI;
  `scripts/leftovers.sh --stage sandbox`.
- **Cost:** `recipes/finance/price.py`: filesystem 0.0281 USD/h; empty buckets bill nothing measurable. About
  6 min ≈ **$0.003 estimated** (not billed).

## Results

| Check | Result |
|---|---|
| Plan | `Plan: 4 to add` (dataset bucket, checkpoint bucket, filesystem, stage policy) |
| Apply | `Apply complete! Resources: 4 added` in 16 s (filesystem 7 s, buckets 8 s) |
| Dataset bucket `nip-sandbox-datasets-<project suffix>` | `ACTIVE`, class `STANDARD` (the `eu-north1` default), versioning `DISABLED`, rule `abort-incomplete-multipart` (7 days) |
| Checkpoint bucket `nip-sandbox-checkpoints-<project suffix>` | `ACTIVE`, `STANDARD`, versioning `ENABLED`, rules `abort-incomplete-multipart` (7 days), `expire-replaced-checkpoints` (noncurrent 7 days, `checkpoint_noncurrent_days` in sandbox), `remove-orphan-delete-markers` |
| Filesystem `nip-sandbox-data` | `READY`, `NETWORK_SSD`, 256 GiB, 4 KiB blocks, no deletion protection (sandbox) |
| Not run | `tests/validate/03-storage.sh` and `data.sh` (need a cluster), a transfer, a checkpoint restore |
| Teardown | `Plan: 0 to add, 0 to change, 4 to destroy.`, `Apply complete! Resources: 0 added, 0 changed, 4 destroyed.` in 20 s; `leftovers.sh --stage sandbox`: no leftovers |

## Portal (Nebius Estate)

| View | Result |
|---|---|
| Estate resources | both buckets and the filesystem attributed to `sandbox / data`, run and TTL; filesystem 256 GiB `NETWORK_SSD` |
| Bucket settings | **gap found and fixed:** buckets showed an empty specification; the inventory now summarises class, versioning and lifecycle rules ("STANDARD · versioning ENABLED · 3 lifecycle rules"), test `buckets.test.ts`, seen live |
| Integrations | `compute.filesystems` 1, `storage.buckets` > 0 |
| Overview run-rate | the filesystem priced at 0.028 USD/h (matches `price.py`) |
| After teardown | resources gone on the next sync; run-rate "nothing in scope"; no new alert |

## What this does and does not show

- Shows: R8 applies and destroys in seconds in `eu-north1` with the documented classes, versioning and
  lifecycle rules.
- Does not show: throughput, a transfer, a checkpoint restore, or a cluster attaching the filesystem.
