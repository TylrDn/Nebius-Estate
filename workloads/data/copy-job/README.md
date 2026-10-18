# Copy job — stage a bucket prefix onto the shared filesystem (R8)

A pinned rclone Job that copies `<dataset_bucket>/<prefix>` into the `datasets` claim on the shared
filesystem, so a training or serving run reads local data instead of streaming from Object
Storage. The same Job re-populates the filesystem after a loss ([`runbooks/backup-restore.md`](../../../runbooks/backup-restore.md)).
The bucket, the filesystem and the credentials come from [`terraform/stacks/data`](../../../terraform/stacks/data/);
the full procedure is [`runbooks/data.md`](../../../runbooks/data.md).

The Job runs on CPU nodes only. Their non-GPU vCPU quota defaults to **0** in `eu-north1` and
`us-central1` (`.cache/nebius-docs/compute/resources/quotas-limits.md:41`), so a cluster there has no CPU node until it is raised
([evidence](../../../docs/evidence/2026-10-11-sandbox-inference-portal-connectors.md)); with R1's `cpu_node_count = 0` the Job stays pending.

| File | What |
|---|---|
| `kustomization.yaml` | namespace (`training`), the `stage-dataset` ConfigMap: `S3_ENDPOINT`, `S3_REGION`, `SOURCE`, `TARGET`, `TRANSFERS` |
| `job.yaml` | `rclone copy`, CPU nodes only, root with all capabilities dropped and a read-only root filesystem; JSON logs carry the transfer stats |
| `pvc.yaml` | `datasets`, 100 GiB `ReadWriteMany` on `csi-mounted-fs-path-sc` |
| `networkpolicy.yaml` | egress to DNS and 443, needed only in a default-deny namespace |

```bash
kubectl -n training create secret generic s3-credentials \
  --from-literal=AWS_ACCESS_KEY_ID=… --from-literal=AWS_SECRET_ACCESS_KEY=…   # never committed
kubectl apply -k workloads/data/copy-job
tests/validate/data.sh                      # bytes, files, MiB/s -> results/data.json
```

A claim is namespaced: to stage for another namespace, use an overlay that sets `namespace:`.
Re-running is safe (unchanged files are skipped); delete the Job first, since its template is
immutable. This Job stages datasets only; checkpoints go to the filesystem and then the
checkpoint bucket ([`runbooks/data.md` → Checkpoints](../../../runbooks/data.md#checkpoints)).

Alternative without this Job: with `filesystem_bucket = true` in the data stack, the data
transfer (`transfer.to_filesystem`) or any S3 tool writes straight into `/datasets` on the shared
filesystem ([filesystem buckets](https://docs.nebius.com/object-storage/buckets/filesystem-buckets),
preview). The claim here mounts the CSI path, not the filesystem root, so point `TARGET` and the
bucket directory at the same place before mixing the two.
