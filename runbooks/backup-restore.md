# Backup and restore runbook

What to back up is in `docs/dr.md`; this page is the hands-on procedure. Nothing here has been
exercised on a live cluster yet; the first drill is recorded in `docs/evidence/`.

## Terraform state (any stage)

State lives in a versioned bucket (`stages/<stage>/<stack>.tfstate`); every apply writes a new
object version and the foundation keeps non-current versions for 90 days.

```bash
# list versions of a state object (S3-compatible endpoint; credentials from bootstrap-backend.sh)
aws --endpoint-url "https://storage.${NEBIUS_REGION}.nebius.cloud" s3api list-object-versions \
  --bucket "<bucket>" --prefix "stages/<stage>/<stack>.tfstate"

# restore: copy the wanted version back as the current object, then plan to see the drift
aws --endpoint-url "https://storage.${NEBIUS_REGION}.nebius.cloud" s3api copy-object \
  --bucket "<bucket>" --key "stages/<stage>/<stack>.tfstate" \
  --copy-source "<bucket>/stages/<stage>/<stack>.tfstate?versionId=<id>"
make plan STAGE=<stage> STACK=<stack>        # review every change before applying
```

Never edit state by hand; never `terraform state rm` to make a plan look clean.

## Shared filesystem (inference cache, training datasets)

The model cache is rebuildable (ADR-0004). Datasets that matter live in Object Storage first and
are copied in; the filesystem is a working copy. Restore = re-copy:

Use the R8 copy Job, [`workloads/data/copy-job`](../workloads/data/copy-job/): a pinned rclone
image copies a bucket prefix into a claim on the shared filesystem, with the bucket credentials
in a Secret you create first (never committed) and the egress rule a default-deny namespace
needs. Procedure, credentials and throughput check: [`data.md` → Stage onto the shared
filesystem](data.md#stage-onto-the-shared-filesystem-the-copy-job). The inference model cache
needs no restore: vLLM downloads the pinned revision again on the next start.

In prod the filesystem carries `forbid_deletion = true`: a `terraform destroy` or a console
delete is refused until the flag is cleared by a reviewed change.

## Soperator jail and submounts

Prod sets `backups_enabled = "auto"` (jails ≤ 12 TiB) in `terraform/live/prod/soperator/stage.tfvars`;
the recipe's backup job writes to the bucket it creates, protected by `TF_VAR_backups_password`
(never committed). Restore follows the recipe's documentation for the pinned tag; verify the
procedure on staging before relying on it.

## Prometheus

Not backed up (7-day retention, not a system of record). Node and GPU metrics also flow to Nebius
Monitoring, and container logs to Nebius Logging, through the observability agent; both keep 14
days ([constraints](https://docs.nebius.com/observability/resources/quotas-limits#logs-constraints)).
For longer log retention, export logs to Object Storage
([log export](https://docs.nebius.com/observability/logs/export)).

## Drill checklist (record in `docs/evidence/<date>-<stage>-dr-drill.md`)

- [ ] state restored from a previous version on staging; plan showed only the expected drift
- [ ] filesystem re-populated from Object Storage (copy Job); `tests/validate/data.sh` and `03-storage.sh` passed
- [ ] a checkpoint restored from a noncurrent version ([`data.md`](data.md#restore-a-checkpoint-from-a-noncurrent-version))
- [ ] full stack rebuild from git in a fresh project; time measured against `docs/dr.md` RTO
