# `stacks/data` — Dataset and checkpoint data plane (R8)

**Purpose.** Storage that outlives any one cluster: a dataset bucket, a versioned checkpoint
bucket, and a shared filesystem that R1/R3 attach instead of creating their own. Optionally one
Object Storage data transfer pulls an external S3-compatible bucket into the dataset bucket.
Operator procedure: [`runbooks/data.md`](../../../runbooks/data.md).

**Used by.** [S1](../../../solutions/S1-private-llm-serving-vpn/README.md) private LLM serving with VPN, [S2](../../../solutions/S2-fine-tune-70b-two-weeks/README.md) 70B fine-tune, [S4](../../../solutions/S4-burst-training-preemptible/README.md) burst training on preemptible, [S5](../../../solutions/S5-slurm-migration/README.md) Slurm migration, [S6](../../../solutions/S6-multi-region-dr/README.md) multi-region DR, [S7](../../../solutions/S7-eu-data-residency/README.md) EU data residency, [S8](../../../solutions/S8-batch-inference/README.md) batch inference, [S9](../../../solutions/S9-data-science-notebooks/README.md) data-science notebooks ([all solutions](../../../solutions/README.md)).

## What it builds

| Resource | Notes |
|---|---|
| Dataset bucket | no versioning; `dataset_storage_class`; aborts stale multipart uploads after 7 days |
| Checkpoint bucket | versioned; replaced versions expire after `checkpoint_noncurrent_days`; orphaned delete markers removed |
| Shared filesystem | `enable_filesystem`; deletion-protected where the stage requires it (prod) |
| Data transfer | `transfer`: one iteration, `NEVER` overwrite by default; secret keys write-only, from SecretStash (Nebius's secret store, formerly MysteryBox, API id `mysterybox`; `.cache/nebius-docs/mysterybox/overview.md`) (`transfer_secret_id`) or `TF_VAR_*`; optional bandwidth and request-rate limits |
| Filesystem bucket | `filesystem_bucket` (off): S3 view of the shared filesystem at `/datasets`; `transfer.to_filesystem` writes there instead of the dataset bucket. Preview, no SLA, no lifecycle or versioning |

Where the stage requires audit logs (staging, prod), the buckets log every write and delete.
Bucket names are `<name>-<stage>-<datasets|checkpoints|fs>-<project suffix>`.

## Inputs that matter

| Variable | Default | Meaning |
|---|---|---|
| `filesystem_size_gib` | 256 | working set staged from the bucket, not the whole bucket (sizing: 256/512/2,048) |
| `checkpoint_noncurrent_days` | 14 | rollback window for a bad save |
| `dataset_storage_class` | `null` = region default | `STANDARD`; `ENHANCED_THROUGHPUT` in `uk-south1`, `uk-south2`, `eu-south1`, `eu-west2`, `us-north1`, which offer no Standard or Intelligent class (`platform/regions.yaml`). Set `ENHANCED_THROUGHPUT` for high-throughput reads (prod). The checkpoint bucket uses the region default |
| `filesystem_type` | `NETWORK_SSD` | the only documented shared filesystem type |
| `filesystem_bucket` | `false` | expose the filesystem over S3 (needs `enable_filesystem`) |
| `transfer` | `null` | source endpoint/bucket/prefix, key ids, `requests_per_second`, `bandwidth_bytes_per_second`, `to_filesystem`; the destination key needs `storage.object-editor` on the destination bucket. The source prefix is stripped from keys: set `destination_prefix` to keep it |
| `transfer_secret_id`, `transfer_secret_version_id` | `null` | SecretStash secret (and pinned version) holding `destination-secret-access-key` and, for a keyed source, `source-secret-access-key`. The values are read from it into `TF_VAR_transfer_*_secret_key` before the plan that is applied; a reviewed-only plan runs without them, an apply refuses to. Pinning a new version re-sends rotated keys ([credentials](../../../docs/credentials.md#secretstash)) |
| `TF_VAR_transfer_*_secret_key` | — | ephemeral and write-only; never in tfvars, plan or state. Without `transfer_secret_id` they are typed in and required for every plan with a transfer |

## Outputs and composition

`filesystem_id` → R1/R3 `existing_filesystem_id` (the cluster then creates no filesystem of its
own). `dataset_bucket`, `checkpoint_bucket` and `s3_endpoint` feed
[`workloads/data/copy-job`](../../../workloads/data/copy-job/) and training jobs. Apply after the
network (R7) and before the clusters.

## Quotas and cost

2 buckets and one filesystem (256 / 512 / 2,048 GiB per stage;
[`docs/capacity.md`](../../../docs/capacity.md#stacksnetwork-r7-and-stacksdata-r8)). Billed by
stored bytes, requests and the filesystem size; a transfer adds only bucket request and storage
charges.

- Enhanced Throughput storage has a default quota of 1 TiB per region (10 TiB in `eu-south1`);
  request more before a prod dataset or any bucket in an Enhanced-Throughput-only region outgrows it
  ([quotas](https://docs.nebius.com/object-storage/resources/quotas-limits#quotas)).
- Filesystem bandwidth grows per 4 TiB (up to 3.70 GiB/s read, 1.89 GiB/s write each), so all three
  stage sizes sit in one unit; up to 256 GiB the inode limit is 4,194,304, which matters for
  many-small-file datasets ([filesystem performance](https://docs.nebius.com/compute/storage/types#filesystem-performance)).

## Validate

- Static: `terraform test` (mocked): versioning, lifecycle rules, audit logging per stage,
  filesystem protection, transfer secrets from either path (SecretStash or `TF_VAR_*`) and stop
  condition.
- Live: [`tests/validate/03-storage.sh`](../../../tests/validate/03-storage.sh) (fio write and read,
  parallel jobs, bar `DATA_MIN_MIBPS`), [`tests/validate/data.sh`](../../../tests/validate/data.sh) (copy
  throughput) and [`tests/validate/checkpoint-restore.sh`](../../../tests/validate/checkpoint-restore.sh)
  (restore drill on the checkpoint bucket); procedure in [`runbooks/data.md`](../../../runbooks/data.md).

## Evidence

Run live once, 2026-10-11 ([evidence](../../../docs/evidence/2026-10-11-sandbox-data-live-recipe.md)): both buckets
(`STANDARD`; versioning off / on; 1 / 3 lifecycle rules) and the 256 GiB filesystem created and destroyed in
`eu-north1` in seconds. Not yet shown: throughput (fio, copy Job), a transfer or a restore. The prior fio run of
2026-10-07 left a [cost estimate only](../../../docs/evidence/costs.md#runs-with-a-cost-estimate-only); no figure from it may be quoted.

Run live again, 2026-10-12 ([evidence](../../../docs/evidence/2026-10-12-sandbox-data-acceptance.md)): the
filesystem mounted on an R1 L40S node gave 2,066 MiB/s write and 1,757 MiB/s read with 4 `fio` jobs (one short
run, above the 450 MiB/s floor of `DATA_MIN_MIBPS`). The restore drill did not run (a run-harness defect, not the
drill); transfer and copy-Job throughput not yet shown.

## Teardown

Destroy the clusters that attach the filesystem first. Empty the buckets (all versions) before
`make destroy-plan destroy STAGE=<stage> STACK=data CONFIRM=yes`. Prod refuses `make destroy`; its
filesystem is deletion-protected ([`runbooks/teardown.md`](../../../runbooks/teardown.md)).

## Upstream references

[Lifecycle rules](https://docs.nebius.com/object-storage/objects/lifecycles) ·
[versioning](https://docs.nebius.com/object-storage/buckets/versioning) ·
[data transfers](https://docs.nebius.com/object-storage/transfer/overview) and
[access](https://docs.nebius.com/object-storage/transfer/access) ·
[filesystem buckets](https://docs.nebius.com/object-storage/buckets/filesystem-buckets) ·
[Mountpoint for S3](https://docs.nebius.com/object-storage/interfaces/mountpoint-s3) ·
[filesystems over CSI](https://docs.nebius.com/kubernetes/storage/filesystem-over-csi) ·
solutions library `data-transfer/`, `nfs-server/`.
