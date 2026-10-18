# Upgrade runbook (Kubernetes version, node groups, platform releases)

Managed Kubernetes supports a short window ([`docs/capacity.md`](../docs/capacity.md#kubernetes-version-window)).
`k8s_version_offset` in the [stage policy](../platform/README.md#stage-policy) sets how far behind
the newest version each stage runs. The weekly drift job does not track Kubernetes versions: check
the versions page below monthly ([`maintenance.md`](maintenance.md)).
Source: [Kubernetes versions](https://docs.nebius.com/kubernetes/versions),
[cluster upgrade](https://docs.nebius.com/kubernetes/manage-versions).

## Order

0. **Pre-check**: confirm the driver preset and OS exist for the new version on every GPU platform the
   stage uses: `nebius mk8s node-group get-compatibility-matrix --cluster-kubernetes-version <v> --platform <p>`
   ([GPU drivers and components](https://docs.nebius.com/kubernetes/gpu/set-up#gpu-drivers-and-other-components)).
1. **Sandbox**: set `k8s_version` to the new version in `sandbox.auto.tfvars`, `make plan`, review,
   `make apply CONFIRM=yes` (apply refuses without it, `Makefile:201-202`),
   run `tests/validate/run-all.sh`. Soperator: check the release's `driver_presets.tf` window
   first (`docs/soperator-compatibility.md`); it may not accept the new version yet.
2. **Staging** (offset policy): the version that prod will run next. Same steps, keep the evidence
   (`docs/evidence/`).
3. **Prod**: on a release tag, after staging ran the version for at least one week of real traffic.

## Steps per cluster

```bash
# 1. one k8s_version for the whole stack: the control plane AND every node group move in the
#    same apply (edit <stage>.auto.tfvars: k8s_version = "1.35")
make plan STAGE=<stage> STACK=<stack>        # expect: control_plane.version and each node group's version updated in place
make apply CONFIRM=yes STAGE=<stage> STACK=<stack>
kubectl get nodes                            # API blips during the control-plane upgrade are expected

# 2. verify the platform layer still schedules (device plugin, CSI, o11y DaemonSets)
tests/validate/00-nodes.sh && tests/validate/01-gpu.sh

# 3. node groups: the same apply rolled them, one node at a time (docs/change-management.md,
#    "Kinds of change"); check every node reports the new kubelet version
kubectl get nodes -o custom-columns=NAME:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion

# 4. workloads
tests/validate/04-workload.sh && WITH_LOAD=1 tests/validate/05-load.sh
```

Node replacement drains each node for at most the node group's drain timeout, which now defaults
to **10 minutes**; after that Managed Kubernetes force-drains and deletes the node
([deployment strategy](https://docs.nebius.com/kubernetes/node-groups/manage#deployment-strategy-and-quotas)).
Checkpoint or stop long training jobs before a node-group change; a PodDisruptionBudget does not
hold the node past the timeout. The modules pass `drain_timeout = null` (the default).

Rolling back a control-plane version is not supported by the API; roll forward or rebuild
from state (`runbooks/rollback.md`, `docs/dr.md`).

## Platform releases (charts, Marketplace)

Bump the version in `platform/versions.yaml`, regenerate the matrix (`make compat-matrix`),
change the module pin, `make ci`, then sandbox → staging → prod. Marketplace releases restart
their pods; the CSI driver node DaemonSet restart briefly blocks new mounts, not existing ones.
Expected: `make compat-matrix-check` and `make ci` pass with the new pin; the stage plan changes only
that release; after apply, `tests/validate/run-all.sh` passes (each step `"status": "pass"` in
`results/<step>.json`) in each stage before the next one.

## Soperator

The recipe owns its upgrade path (`terraform/stacks/soperator/README.md`): bump the tag in
`platform/versions.yaml` and `scripts/fetch-soperator.sh`, re-verify every override fragment
against the new tag, re-review every patch in `terraform/stacks/soperator/patches/` (the fetch stops
when one no longer applies: delete it if the new tag already made the change, otherwise rebase it;
[Patches](../terraform/stacks/soperator/README.md#patches)), run `make soperator-check`, then the
recipe's own upgrade notes.
