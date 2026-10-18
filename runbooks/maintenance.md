# Maintenance runbook (recurring tasks)

| Cadence | Task | How | Evidence |
|---|---|---|---|
| weekly | version drift | the `Upstream version drift` workflow opens/updates one issue; triage it (`runbooks/upgrade.md`). Expected: no open `version-drift` issue, or each drifted pin either bumped by PR or noted as deferred in the issue (`scripts/check-upstream-versions.py` exits 3 on drift; `.github/workflows/version-refresh.yml`) | the issue |
| weekly | leftovers in sandbox | `make leftovers-stage STAGE=sandbox` (only once every sandbox run has ended) from a shell with the stage's credentials; anything past its `nip-ttl-expires` is deleted by a person | `docs/evidence/` ledger line |
| weekly | alert review (staging/prod) | Alertmanager UI via `kubectl -n o11y port-forward`; every firing alert is either an incident or a threshold change in `docs/slo.md` | PR or incident note |
| monthly | expired access keys | `nebius iam v2 access-key list --parent-id <project> --all` (default page size 10; `list` and `delete` are not in the docs, which show `create` and `get`; per CLI help, `nebius` 0.12.285); delete expired ones, including R8 workload keys (`runbooks/data.md`) | none needed |
| monthly | capacity calendar | reservations, quotas, K8s window (`docs/capacity.md`); new Kubernetes versions on [the versions page](https://docs.nebius.com/kubernetes/versions) (`runbooks/upgrade.md`) | updated table |
| monthly | DR drill on staging | one item from `runbooks/backup-restore.md` checklist | `docs/evidence/<date>-staging-dr-drill.md` |
| quarterly | CI key rotation | `runbooks/credential-rotation.md` | foundation apply |
| quarterly | Soperator tag review | compare the pinned tag with the latest `soperator-v*` (`scripts/check-upstream-versions.py`); re-verify every override fragment. Expected: the script's Soperator rows show no drift, or `make soperator-check` passes on the new tag before the pin moves | `docs/soperator-compatibility.md` |
| per release | CHANGELOG + prod apply | `docs/change-management.md` | the tag |

## Scheduled node maintenance

Nebius issues maintenance events (hardware faults and planned work) per node. Managed Kubernetes
marks the node with the `NebiusMaintenanceScheduled` condition, whose message carries the SLA
deadline, then cordons it, waits for workloads, drains it (up to one hour), stops and starts the
VM, in batches of `max(1, max_unavailable)` per node group
([maintenance](https://docs.nebius.com/kubernetes/maintenance#how-maintenance-occurs)). You can pull
it into a quiet hour:

```bash
nebius compute maintenance list-active --parent-id <project_ID>      # reason codes: compute/virtual-machines/maintenance-reasons
kubectl describe node <node> | grep -A 10 Conditions:               # NebiusMaintenanceScheduled + SLA deadline
kubectl label node <node> nebius.com/perform-maintenance=true --overwrite   # or a time >= 5 min before the deadline
```

([manual maintenance](https://docs.nebius.com/kubernetes/maintenance/manage#how-to-launch-maintenance-manually-in-managed-kubernetes)).
For a stateless serving Deployment the PodDisruptionBudget (`workloads/inference/base/pdb.yaml`)
keeps one replica up during a drain when `replicas > 1`; with one replica the model reload is the
outage. For training, checkpoint to the R8 checkpoint bucket (or the shared filesystem) at an
interval shorter than your tolerance for a restart (ADR-0007, [`data.md` → Checkpoints](data.md#checkpoints)).
Preemptible nodes (sandbox only) are not drained: Compute sends `SIGTERM` 60 s before it stops the
VM (volumes kept, dynamic public IP lost) ([preemptible VMs](https://docs.nebius.com/compute/virtual-machines/preemptible)).

## Quiet-period checks before a release

- `make ci` and `make soperator-check` green on the release commit
- staging has run the commit for a week; `tests/validate/run-all.sh` evidence attached
- no open `version-drift` issue naming a component in the release
- the per-stage quota tables in [`docs/capacity.md`](../docs/capacity.md#quotas-per-stack) still match `terraform/live/prod/*/` sizing
