# Disaster recovery

What holds state, how it is protected, and how it comes back. Recovery objectives are per
stage; nothing below has been demonstrated on a live cluster yet (recorded as pending in
`docs/security.md`; the first drill lands in `docs/evidence/`).

## What holds state

| Asset | Where | Protection | Recovery |
|---|---|---|---|
| Terraform state (per stage, per stack) | versioned Object Storage bucket, key `stages/<stage>/<stack>.tfstate` | bucket versioning and `prevent_destroy`; non-current versions kept 90 days (`modules/foundation/state-bucket`); `use_lockfile` locking; bucket-scoped identity (ADR-0005) | restore a previous object version, then `terraform plan` to see the drift ([runbooks/backup-restore.md](../runbooks/backup-restore.md)) |
| Shared filesystem (model cache, datasets) | `nebius_compute_v1_filesystem` | prod: `forbid_deletion = true` (API refuses deletion); the cache is rebuildable from the model registry (ADR-0004) | re-pull models; datasets restored from Object Storage (customer-owned copy) |
| R8 checkpoints and datasets | Object Storage buckets (`stacks/data`) | checkpoint bucket versioned, non-current versions expire per stage (7 days sandbox and staging, 30 prod); the dataset bucket is a copy of a customer-owned source | restore a previous checkpoint version; re-run the transfer or copy job for datasets |
| Soperator jail and `/data` submount | Filestore | prod `stage.tfvars`: `forbid_deletion = true`, `backups_enabled = "auto"` (the recipe's backup job, jails ≤ 12 TiB) | the recipe's restore procedure; `runbooks/backup-restore.md` |
| Prometheus TSDB | `compute-csi` disk (25 GiB) | none beyond the disk; 7-day retention | accepted loss: metrics are not a system of record; the Nebius observability agent keeps node/GPU metrics in Nebius Monitoring and container logs in Nebius Logging, 14 days each ([constraints](https://docs.nebius.com/observability/resources/quotas-limits#metrics-constraints)) |
| Kubernetes objects | control plane (managed) | everything is declarative in `workloads/` and Terraform | re-apply from git |
| Secrets (Grafana password, SA keys) | Terraform state (sensitive) / GitHub Environment secrets | state protection above; keys rotate ([runbooks/credential-rotation.md](../runbooks/credential-rotation.md)) | regenerate |

## Objectives (targets, not measurements)

| Stage | RPO | RTO | Scenario drilled |
|---|---|---|---|
| sandbox | n/a | n/a | none: rebuild from scratch |
| staging | 24 h (datasets), 0 for config | 2 h | state restore; cluster rebuild from git |
| prod | 1 h (jail/datasets via backups), 0 for config | 4 h for a full stack rebuild in the same region | state restore; filesystem restore; control-plane rebuild |

Region loss is **not** covered: Filestore and GPU clusters are regional, and the reference
architecture is single-region by design (ADR-0002). A second region is a second set of live
roots with its own foundation objects.

## Rebuild order

1. Foundation objects exist (buckets, identities) — they are never destroyed by stage runs.
2. `make init plan apply STAGE=<stage> STACK=<stack>`: control plane, node groups, filesystem.
3. Platform layer comes with the same apply (device plugin, CSI, o11y).
4. `kubectl apply -k workloads/...`; restore data into the filesystem; re-run
   `tests/validate/run-all.sh` and record the drill in `docs/evidence/`.

## Where `prevent_destroy` is used, and where it is not

Terraform's `lifecycle { prevent_destroy }` is a literal inside the resource block: it cannot be switched
per stage without forking a module. It is therefore used only where every stage wants it, the state
bucket (`modules/foundation/state-bucket`), which the foundation root owns and stage runs never destroy.
The stacks rely instead on API-level deletion protection (`forbid_deletion` on filesystems and jails),
the `make destroy` refusal for `STAGE=prod`, the plan-time stage policy, and the protected `prod`
GitHub environment.
