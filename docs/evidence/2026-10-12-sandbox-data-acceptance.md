# sandbox/data acceptance run (R8) — 2026-10-12

- **Kind:** run of this repository (`terraform/live/sandbox/data`, R8), the second apply of this root; run 2,
  steps 2a and 4, of the [live-run plan](../plans/2026-10-12-live-runs.md), approved by the owner.
- **Date / region / platform:** 2026-10-12, apply 19:11:11–19:11:40 UTC, destroy 19:58–20:01 UTC (in the
  teardown rerun, [lifecycle](2026-10-12-sandbox-session-lifecycle.md)), `eu-north1`. Two buckets
  (`checkpoints` versioned with the three lifecycle rules, `datasets` unversioned) and a 256 GiB
  `NETWORK_SSD` filesystem (4 KiB blocks). Labels `nip-run=live-20261012-run2`, TTL 23:40:31Z, re-armed for
  22:50:29Z in step 2d.
- **Versions:** provider `nebius/nebius` 0.6.67; `fio` 3.13 in the probe pod; the throughput ran on the
  R1 cluster of the same session (Kubernetes 1.36.3, Ubuntu 24.04.4, kernel 6.11.0-1016-nvidia).
- **Method:** `make preflight` (GO), `make init plan` (4 to add: two buckets, the filesystem,
  `terraform_data.stage_policy`), `make ttl-teardown CONFIRM=yes` before `make apply CONFIRM=yes`.
  Throughput: `tests/validate/03-storage.sh` on the filesystem mounted as virtiofs on the R1 GPU node:
  4 parallel `fio` jobs × 1 GiB, 1 MiB sequential write then read, `direct=1`, aggregate `bw_bytes`. Bar
  `DATA_MIN_MIBPS` = 450 MiB/s, a floor taken from one Network SSD disk's ceiling
  ([docs compute/storage/types](https://docs.nebius.com/compute/storage/types#disk-types-comparison));
  the filesystem's own figures there are upper bounds ("tested … per client: up to 15 GiB/s read, 10 GiB/s
  write"), not a target. Restore: `tests/validate/checkpoint-restore.sh` with a drill identity
  (`storage.object-editor` on the checkpoint bucket only, 2 h key), removed after the drill.
- **Cost:** filesystem $0.0281/h list (re-priced on the day) for about 50 min ≈ $0.02 estimated; buckets
  held no data. Billed figure: not yet in the FOCUS export (unknown).

## Results

Raw: [`03-storage.json`](../../results/2026-10-12/03-storage.json),
[`03-storage-fio.json`](../../results/2026-10-12/03-storage-fio.json),
[`checkpoint-restore.json`](../../results/2026-10-12/checkpoint-restore.json) (scrubbed).

| Check | Result |
|---|---|
| Apply | 4 added in 29 s (buckets 7 s, filesystem 9 s); outputs read back |
| Mount | every node virtiofs, source `data`, at `/mnt/data` |
| Sequential write, 4 jobs | **2,066 MiB/s** aggregate (4 GiB in 1.98 s; completion latency p50 1.6 ms, p99 6.3 ms), 0 errors |
| Sequential read, 4 jobs | **1,757 MiB/s** aggregate, 0 errors |
| Against the floor (450 MiB/s) | both above it. The step itself reported `fail` because its PVC check found no `inference/model-cache` claim: no vLLM workload was deployed in this session ([R1 validate](2026-10-12-sandbox-inference-validate.md)); the rate was not the failure |
| Checkpoint restore drill | **not run**: the first `put-object` failed with `Blob values must be a path to a file`. Cause: the run harness's `aws` was a container wrapper that mounted no host directory, so the drill's temp file did not exist inside it. A harness defect, not the drill or Nebius; the drill identity was removed. Its `context` field records a kube context other than the session cluster (`<unrelated-context>` in the committed copy): kubectl pointed elsewhere at that moment. The drill uses S3 only, not Kubernetes, so the result is not affected |
| Teardown | 4 destroyed; `make leftovers STACK=data` empty; the stage gate clean |

## What this does and does not show

- Shows: one throughput figure for a 256 GiB shared filesystem from one L40S node, judged against a floor;
  the R8 lifecycle (preflight, TTL job armed before apply, destroy, leftovers) a second time.
- Does not show: a sustained rate (each phase took about 2 s, so caching effects cannot be excluded),
  more than one client, a size-dependent figure, transfer or copy-job throughput, and the restore drill.
  R8 stays at Live run in [What is proven](../../README.md#what-is-proven): the floor is a disk ceiling, not
  a filesystem target, and one short run is a baseline, not a measurement to plan on.
