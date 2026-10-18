# Data runbook — R8 datasets and checkpoints

Create the data plane, get data into it, stage it next to the GPUs, restore a checkpoint, and
remove it. The stack is [`terraform/stacks/data`](../terraform/stacks/data/): a dataset bucket
(read-mostly, no versioning), a versioned checkpoint bucket whose replaced versions expire after
`checkpoint_noncurrent_days`, a shared filesystem that R1/R3 attach, and an optional Object
Storage data transfer from an external S3-compatible bucket. The copy Job is
[`workloads/data/copy-job`](../workloads/data/copy-job/). First live run:
[2026-10-11](../docs/evidence/2026-10-11-sandbox-data-live-recipe.md) (apply, settings read back, teardown).

Upstream references: [data transfers](https://docs.nebius.com/object-storage/transfer/overview),
[versioning](https://docs.nebius.com/object-storage/buckets/versioning),
[lifecycle rules](https://docs.nebius.com/object-storage/objects/lifecycles),
[filesystems over CSI](https://docs.nebius.com/kubernetes/storage/filesystem-over-csi),
[access keys](https://docs.nebius.com/iam/service-accounts/access-keys),
[ml-cookbook checkpointing](https://github.com/nebius/ml-cookbook/tree/main/slurm/object-storage-checkpointing).

## Deploy

After the network (R7, [`network.md`](network.md)) when you use one; before the cluster.

| # | Command | Expect |
|---|---|---|
| 1 | `source scripts/bootstrap-backend.sh <stage> data`; sandbox: `export TF_VAR_labels='{"nip-owner":"platform",…,"nip-ttl-expires":"…"}'` | as in [`deploy.md`](deploy.md) |
| 2 | `make init plan STAGE=<stage> STACK=data` | two buckets `nip-<stage>-datasets-…` / `nip-<stage>-checkpoints-…`, the filesystem `nip-<stage>-data` (`forbid_deletion` on in prod), a transfer only when `transfer` is set |
| 3 | `make apply CONFIRM=yes STAGE=<stage> STACK=data` | outputs `dataset_bucket`, `checkpoint_bucket`, `filesystem_id`, `s3_endpoint` |
| 4 | before planning R1/R3: `export TF_VAR_existing_filesystem_id="$(terraform -chdir=terraform/live/<stage>/data output -raw filesystem_id)"` | every node of the cluster mounts this filesystem, so staged data outlives the cluster |

## Credentials: access keys, never committed

Workloads read and write the buckets with an S3 access key of a service account. Create one
service account per purpose (copy job: read on datasets; trainer: write on checkpoints) and
grant it through a group, as [`scripts/bootstrap-backend.sh`](../scripts/bootstrap-backend.sh)
does for state. Then mint a key that expires, named `<identity>-<consumer>-<UTC yyyymmddhhmm>`
([`docs/naming.md`](../docs/naming.md#iam)):

```bash
created=$(nebius iam v2 access-key create --parent-id "$NEBIUS_PROJECT_ID" \
  --name nip-<stage>-copy-k8s-$(date -u +%Y%m%d%H%M) --account-service-account-id <sa id> \
  --expires-at <RFC 3339, e.g. 7 days out> --format json)
key=$(nebius iam v2 access-key get --id "$(jq -r .metadata.id <<<"$created")" --format json)
kubectl -n training create secret generic s3-credentials \
  --from-literal=AWS_ACCESS_KEY_ID="$(jq -r .status.aws_access_key_id <<<"$key")" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$(jq -r .status.secret <<<"$key")"
```

The key exists only in the cluster Secret and your shell; it is never written to a file in
this repository, a tfvars file, or a commit (gitleaks runs in CI). Delete the Secret when the
run ends and the key when it is no longer needed (`nebius iam v2 access-key delete --id …`; not in the docs, which show only `create` and `get`; per CLI help, `nebius` 0.12.285).

## Ingest: Object Storage data transfer

For a one-off pull of an external S3-compatible bucket (another cloud, a partner) into the
dataset bucket, set `transfer` in the data root and pass the secrets through the environment;
they are write-only (never in plan or state):

```bash
export TF_VAR_transfer='{"source_endpoint":"https://s3.<region>.amazonaws.com","source_region":"<region>",
  "source_bucket":"<bucket>","source_prefix":"corpus/v1/","destination_prefix":"corpus/v1/",
  "source_access_key_id":"<id>","destination_access_key_id":"<id of a key that can write the dataset bucket>"}'
export TF_VAR_transfer_source_secret_key=… TF_VAR_transfer_destination_secret_key=…
make plan STAGE=<stage> STACK=data   # review, then make apply CONFIRM=yes STAGE=<stage> STACK=data
nebius storage transfer list --parent-id "$NEBIUS_PROJECT_ID"   # status of the run
```

The transfer stops after one full pass and copies current object versions only. The source
prefix is removed from each key and the destination prefix added
([key prefixes](https://docs.nebius.com/object-storage/transfer/key-prefixes)), so keep
`destination_prefix` equal to `source_prefix` when the copy Job's `SOURCE` names that prefix.
Defaults are 4000 requests/s and 50 GiB/s per transfer; lower them with `requests_per_second` /
`bandwidth_bytes_per_second` for a rate-limited source. Bucket requirements and limits:
[requirements](https://docs.nebius.com/object-storage/transfer/requirements),
[limits](https://docs.nebius.com/object-storage/transfer/limits). For data already reachable with
your own tools, `aws s3 sync` or `rclone` into the dataset bucket is equally valid.

To skip the copy Job, set `filesystem_bucket = true` and `"to_filesystem":true` in `transfer`: the
transfer then writes into `/datasets` on the shared filesystem through a filesystem bucket
([filesystem buckets](https://docs.nebius.com/object-storage/buckets/filesystem-buckets), preview, no
SLA; keys `a/b` and `a/b/c` cannot both exist as files). The `filesystem_bucket` output names it
for `aws s3`/`rclone` too.

To measure the managed transfer itself (not the copy Job), the docs' method needs about 20,000
objects / 20 TiB and the bucket's Traffic metric
([testing transfer speed](https://docs.nebius.com/object-storage/transfer/testing-transfer-speed));
it does not fit sandbox quotas.

## Stage onto the shared filesystem: the copy Job

A claim is namespaced, so the Job writes into the `datasets` claim of the namespace whose pods
read the data (default `training`; for `inference`, an overlay that sets `namespace: inference`).

```bash
kubectl create namespace training --dry-run=client -o yaml | kubectl apply -f -
# edit SOURCE (<dataset_bucket>/<prefix>), TARGET, S3_ENDPOINT, S3_REGION in
# workloads/data/copy-job/kustomization.yaml (or an overlay), then:
kubectl -n training delete job stage-dataset --ignore-not-found   # a Job's template is immutable
kubectl apply -k workloads/data/copy-job
tests/validate/data.sh            # waits, then records bytes, files and MiB/s in results/data.json
kubectl -n training delete secret s3-credentials
```

The copy is idempotent: a re-run skips files already present with the same size and modification
time. Mount the same claim (`datasets`) in the training pod and read from `TARGET`. Filesystem
write and read throughput itself is `tests/validate/03-storage.sh` (parallel fio jobs, bar `DATA_MIN_MIBPS`);
`COPY_MIN_MIBPS` sets a bar for the copy.

Streaming instead of staging: the Mountpoint for Amazon S3 CSI driver mounts a bucket read-only in
pods for large sequential reads; it is not POSIX (no locks, directory renames or symlinks)
([Mountpoint](https://docs.nebius.com/object-storage/interfaces/mountpoint-s3#kubernetes-clusters)).
This repository does not install it.

## Checkpoints

Save checkpoints to the shared filesystem (fast save and restore), then copy them asynchronously
to the checkpoint bucket, as the docs suggest
([use cases → training](https://docs.nebius.com/compute/storage/types#training)). Writing straight
to the bucket is the fallback when no filesystem is attached: the ml-cookbook pattern (linked
above) uploads PyTorch DCP shards asynchronously and commits a small `latest` marker last, so a
killed upload never replaces the last good checkpoint. The bucket is versioned, which the docs say
lowers peak throughput under high load
([best practices](https://docs.nebius.com/object-storage/performance-cost-best-practices#use-object-versioning-only-if-required)),
and concurrent writes to the same key perform poorly, so have one writer per key. Versioning is the
safety net: an overwritten or deleted object keeps its previous version for
`checkpoint_noncurrent_days` (7 sandbox and staging, 30 prod).

### Restore a checkpoint from a noncurrent version

```bash
ep=$(terraform -chdir=terraform/live/<stage>/data output -raw s3_endpoint)
b=$(terraform -chdir=terraform/live/<stage>/data output -raw checkpoint_bucket)
# 1. find the version written before the bad save
aws --endpoint-url "$ep" s3api list-object-versions --bucket "$b" --prefix "<run>/latest" \
  --query 'Versions[].{v:VersionId,t:LastModified,latest:IsLatest}'
# 2. make it current again (a new version; nothing is deleted)
aws --endpoint-url "$ep" s3api copy-object --bucket "$b" --key "<run>/latest" \
  --copy-source "$b/<run>/latest?versionId=<id>"
# 3. repeat for each shard the marker names, or restore the whole step prefix the same way
```

A deleted object shows a delete marker as its latest version; copying the prior version back,
as above, restores it.

**Drill.** `tests/validate/checkpoint-restore.sh` scripts the two cases above against the checkpoint
bucket (`CKPT_BUCKET=$b S3_ENDPOINT=$ep` and a key that may write it): a good marker overwritten by a
bad save, then deleted, restored both times by list + copy, the drill's versions removed afterwards;
the result is `results/checkpoint-restore.json`. Run it after each apply of the data stack. Noncurrent versions older than the lifecycle window are gone: export
what must outlive it.

## Teardown

Data outlives clusters by design: destroy R1/R3 first, and the data stack only when the data
is no longer needed or has been exported.

1. Export what must be kept (`aws s3 sync s3://<bucket> <destination>` for both buckets, or a
   data transfer to another bucket). A bucket that still holds objects or versions cannot be
   deleted; empty it deliberately.
2. In prod, the filesystem carries `forbid_deletion`; prod follows
   [`teardown.md` → Prod](teardown.md#prod).
3. `make destroy-plan STAGE=<stage> STACK=data`, review, `make destroy CONFIRM=yes STAGE=<stage> STACK=data`.
4. `make leftovers STACK=data` with `NEBIUS_PROJECT_ID` set to the stage's project (`make leftovers` ignores `STAGE`, `Makefile:229-230`); delete the workload access keys you minted.
