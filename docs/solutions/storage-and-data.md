# Storage and data

Block, file and object storage on Nebius AI Cloud, and which to use for datasets, checkpoints and
model weights. All links read on **2026-10-11**. Prices: [pricing-and-billing.md](pricing-and-billing.md).

## Disks

Source: [Storage types](https://docs.nebius.com/compute/storage/types).

| Type (API value) | Capacity | Max bandwidth | Max read / write IOPS | Allocation unit (perf per unit) | Reliability | Encryption | Docs' suggested use |
|---|---|---|---|---|---|---|---|
| Network SSD (`network_ssd`) | 1–8192 GiB | 450 MiB/s | 20,000 / 20,000 | 32 GiB (15 MiB/s, 1,000 IOPS) | erasure coding, tolerates 2 concurrent failures | always on | boot disks, Slurm controller |
| Network SSD Non-replicated (`network_ssd_non_replicated`) | 93–262,074 GiB, multiples of 93 | 2 GiB/s | 75,000 / 75,000 | 93 GiB (110/82 MiB/s, 28,000/5,600 IOPS) | **none**: data lost if a disk fails | optional | MK8s node boot disks, scratch |
| Network SSD IO M3 (`network_ssd_io_m3`) | 93–262,074 GiB, multiples of 93 | 2 GiB/s | 75,000 / 75,000 | 93 GiB (same as NRD) | 3-way mirror | optional | databases, GlusterFS-style storage on VMs |
| Local SSD | fixed 6 × 3.84 TB per VM | read 6.8 GB/s, write 2.6 GB/s per disk | 510,000 / 350,000 per disk | n/a | **ephemeral**: erased on VM stop/delete or host failure; not encrypted | none | scratch, caches |

| Rule | Source |
|---|---|
| Performance scales with size until the cap (e.g. 450 MiB/s on Network SSD needs 30 units = 960 GiB) | [Disk performance](https://docs.nebius.com/compute/storage/types#disk-performance) |
| Encryption can reduce disk performance by up to 15% | same |
| A network disk attaches to one running VM at a time | same |
| VM-managed disks are deleted with the VM; standalone disks persist and can have deletion protection | [VM-managed vs standalone](https://docs.nebius.com/compute/storage/types#vm-managed-and-standalone-disks) |
| Local SSD only on `gpu-b300-sxm` `8gpu-192vcpu-2768gb` in `uk-south1`, `eu-west2`, `us-north1`; enable at VM create only; keep daily writes below disk capacity (TBW) | [Local SSD](https://docs.nebius.com/compute/storage/local-disks), [pricing note](https://docs.nebius.com/compute/resources/pricing#volumes) |
| MK8s uses local SSD as node ephemeral storage when enabled | [MK8s components](https://docs.nebius.com/kubernetes/components#node) |
| MK8s auto-recovers a node whose NRD boot disk has I/O errors ≥ 30 s (`NebiusBootDiskIOError`) by replacing it | [MK8s health checks](https://docs.nebius.com/kubernetes/maintenance/health-checks) |

## Shared filesystems

Source: [Shared filesystems](https://docs.nebius.com/compute/storage/types#shared-filesystems).

| Property | Value |
|---|---|
| Access | Mounted as virtiofs on many VMs; same project only (no cross-project sharing) |
| Capacity | 1 GiB – 100 PiB |
| Tested per-client bandwidth | read up to 15 GiB/s, write up to 10 GiB/s (depends on platform and region) |
| Tested aggregate bandwidth | read up to 1.9 TiB/s, write up to 1.5 TiB/s (measured on a 20 PiB filesystem) |
| Scaling | each 4 TiB adds up to 3.70 GiB/s read and 1.89 GiB/s write |
| Max file size | 512 GiB × block size in KiB (2 TiB at the default 4 KiB) |
| Inodes | 4,194,304 up to 256 GiB; above that size ÷ 64 KiB |
| Reliability / encryption | erasure coding (2 concurrent failures); encryption always on |
| S3 access | attach a *filesystem bucket* (preview; not covered by the Object Storage SLA) ([filesystem buckets](https://docs.nebius.com/object-storage/buckets/filesystem-buckets)) |
| Kubernetes | CSI driver mounts a filesystem on nodes for shared PVCs ([filesystem over CSI](https://docs.nebius.com/kubernetes/storage/filesystem-over-csi)) |

Sizing consequence: a small filesystem is slow. For a target aggregate read of 37 GiB/s,
37 ÷ 3.70 = 10 units × 4 TiB = **40 TiB** provisioned (arithmetic from the scaling rule above),
which also needs a matching filesystem-capacity quota (defaults 2–5 TiB per region,
[Compute quotas](https://docs.nebius.com/compute/resources/quotas-limits#storage)).

WEKA and VAST: the filesystem `type` enum in the Terraform provider and CLI includes `WEKA` and
`VAST` (and `NETWORK_HDD`), with the note that "the list of available types will be clarified
later" ([`compute_v1_filesystem`](https://docs.nebius.com/terraform-provider/reference/resources/compute_v1_filesystem)).
The encryption page describes WEKA filesystems (encryption must be chosen at create)
([encryption](https://docs.nebius.com/security/encryption#weka-storage)). No page documents how to
order, size or price WEKA or VAST: docs silent, treat as a sales conversation.

## Object Storage

Sources: [overview](https://docs.nebius.com/object-storage/overview),
[storage classes](https://docs.nebius.com/object-storage/storage-classes),
[versioning](https://docs.nebius.com/object-storage/buckets/versioning),
[lifecycles](https://docs.nebius.com/object-storage/objects/lifecycles),
[quotas](https://docs.nebius.com/object-storage/resources/quotas-limits).

| Class (API) | Behaviour | Regions | When |
|---|---|---|---|
| Enhanced Throughput (`ENHANCED_THROUGHPUT`) | Unthrottled; "2x latency improvement (on larger objects) and up to 10x throughput per GiB stored" vs the others in-region; higher storage price, free operations and egress | all | streaming datasets or weights to GPUs, checkpoints, ETL targets |
| Standard (`STANDARD`) | Default where available; 20 GBps per tenant per region limit (shared with Intelligent) | not in `uk-south1`, `uk-south2`, `eu-south1`, `eu-west2`, `us-north1` | general storage |
| Intelligent (`INTELLIGENT`) | Warm → Cold after 30 days without access (often up to 48 h earlier); objects < 180 KiB stay Warm; free egress up to 3× monthly average stored, then throttling and/or charges | as Standard | archives with unpredictable access |

| Feature | Fact |
|---|---|
| Versioning | Off by default; once enabled can only be suspended; first enable on an existing bucket can take up to 15 min; docs recommend versioning **disabled** for lowest latency / highest throughput |
| Lifecycle | Expiration (objects, non-current versions, incomplete multipart uploads) and transition (date, days since upload, days since last access); evaluated nightly after ~00:00 UTC; last-access precision 12 h |
| Incomplete uploads | Buckets created on or after 2026-11-09 auto-abort incomplete multipart uploads after 30 days unless you set your own rule |
| Limits | 1 billion objects per bucket; 100 million versions per versioned bucket; 200 buckets per region |
| Default size quotas | Standard 10 TiB, Intelligent 10 TiB, Enhanced Throughput 1 TiB (10 TiB in `eu-south1`) per region |
| S3 compatibility | AWS CLI and S3 API ([compatibility](https://docs.nebius.com/object-storage/interfaces/s3-api-compatibility)); access keys belong to service accounts ([access keys](https://docs.nebius.com/iam/service-accounts/access-keys)) |
| Mountpoint for S3 | Supported for Linux, VMs and Kubernetes; not full POSIX (no locks, renames of directories, symlinks) ([Mountpoint](https://docs.nebius.com/object-storage/interfaces/mountpoint-s3)) |
| Terraform state | Documented as a backend ([store Terraform state](https://docs.nebius.com/object-storage/store-terraform-state)) |
| Deletion | Deleted objects unrecoverable unless versioned; physically removed within 4 days ([data deletion](https://docs.nebius.com/overview/data-deletion)) |

### Data transfers (managed copy)

Source: [transfers](https://docs.nebius.com/object-storage/transfer/overview),
[limits](https://docs.nebius.com/object-storage/transfer/limits).

| Fact | Detail |
|---|---|
| Sources/destinations | Nebius buckets and S3-compatible third-party services (Azure Blob also mentioned) |
| Iterations | One-shot, N empty iterations, or continuous; after the first success, objects older than the last success are skipped |
| Cost | No charge for the transfer itself; you pay requests, egress and storage at source and destination |
| Default limits | 4000 requests/s and 50 GiB/s per transfer when unset; both configurable, never unlimited |
| Terraform | `nebius_storage_v1_transfer` (used by R8) |

Upstream helper scripts for S3 → shared filesystem copies and fio benchmarks:
[`nebius-solutions-library/data-transfer`](https://github.com/nebius/nebius-solutions-library/tree/main/data-transfer).

## Choosing storage by data type

From the docs' [use-case guidance](https://docs.nebius.com/compute/storage/types#use-cases-and-suggestions),
plus the limits above.

| Data | Primary | Secondary | Why | Watch out for |
|---|---|---|---|---|
| Raw datasets, preprocessing | Object Storage | — | scales, cheap per GiB | 20 GBps tenant cap on Standard/Intelligent |
| Training reads (hot dataset) | Shared filesystem | Enhanced Throughput bucket (datasets ≥ 1 PiB or external workers) | POSIX, high aggregate bandwidth | filesystem bandwidth scales with size; inode limit for many small files |
| Code shared across workers | Shared filesystem | — | consistency | same-project only |
| Checkpoints during training | Shared filesystem | async copy to Object Storage after the run | fast save/restore | versioned buckets trade throughput; NRD/local SSD are not durable |
| Model weights for autoscaled serving | Shared filesystem | Enhanced Throughput bucket | many nodes read the same weights | cold-start time grows with weight size; measure |
| Inference outputs, logs | Object Storage | — | shareable | egress from Standard is charged |
| Node boot | Network SSD (default) or NRD | — | reliability vs speed | NRD has no redundancy |
| Scratch | Local SSD (B300 regions) | NRD disk | throughput | erased on stop |

## How R8 maps

`terraform/stacks/data` + `workloads/data/copy-job`:

| R8 element | Nebius feature | Doc-backed note |
|---|---|---|
| `nebius_storage_v1_bucket.datasets` (versioning disabled, abort multipart after 7 days) | Object Storage bucket, lifecycle expiration | matches the docs' high-throughput recommendation |
| `dataset_storage_class` default `null` = region default from `platform/regions.yaml` | storage class | **Standard and Intelligent are not available in `uk-south1`, `uk-south2`, `eu-south1`, `eu-west2`, `us-north1`**, so the default there is `ENHANCED_THROUGHPUT` (default quota 1 TiB per region); a plan with `STANDARD` in those regions is refused |
| `nebius_storage_v1_bucket.checkpoints` (versioning on, non-current expiry, region-default class) | versioning + lifecycle | protects against a bad save; docs warn versioning lowers peak throughput, so write checkpoints to the filesystem first ([`runbooks/data.md`](../../runbooks/data.md#checkpoints)) |
| `module.filesystem` → `existing_filesystem_id` in R1/R3 | shared filesystem, same project | outlives any one cluster; project-scoped; `NETWORK_SSD` is the only documented type |
| `nebius_storage_v1_transfer.ingest` (one iteration, optional request-rate and bandwidth limits) | data transfer | source egress billed by the source provider; the source prefix is stripped from keys |
| `nebius_storage_v1_bucket.filesystem` (`filesystem_bucket`, opt-in) + `transfer.to_filesystem` | filesystem bucket (preview) | transfer or S3 tools write straight onto the shared filesystem; no SLA, lifecycle or versioning |
| `workloads/data/copy-job` (rclone on CPU nodes) | S3 → filesystem copy | alternative: the filesystem bucket row above |
| `workloads/data/copy-job` | bucket → filesystem staging and restore | [`runbooks/data.md`](../../runbooks/data.md) |

Design rationale: [ADR-0004 storage design](../decisions/0004-storage-design.md).
