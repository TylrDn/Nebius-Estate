# Team scheduling runbook — R16 Kueue with topology-aware placement

Install Kueue on a training cluster, create the team queues for the stage, prove that a multi-node
job lands in one GPU cluster and that one team can borrow and be reclaimed, add a team, and remove
it all. The manifests are [`workloads/kueue`](../workloads/kueue/README.md). Built and policy-checked
in CI only; nothing here has run on a live cluster yet (record the first run in `docs/evidence/`).

Upstream references: [topology-aware scheduling](https://docs.nebius.com/kubernetes/gpu/topology-aware-scheduling#how-to-enable-topology-aware-scheduling),
[topology labels](https://docs.nebius.com/kubernetes/gpu/topology-aware-scheduling#how-to-view-topology-labels-in-your-cluster),
[Kueue TAS](https://kueue.sigs.k8s.io/docs/concepts/topology_aware_scheduling/).

Who: a cluster administrator (Kueue installs CRDs, webhooks and cluster roles). Duration: 15 min to
install and configure; the borrow-and-reclaim check takes as long as its jobs. Risk: the install and
queues change nothing billable; **the sample job and the reclaim check run paid GPU jobs** on nodes
that already exist (approval as for any run).

## Before you start

- A training cluster from [R3](../terraform/stacks/training/README.md) with `enable_gpu_cluster = true`
  and at least two 8-GPU nodes for the sample job; `make kubeconfig STAGE=<stage> STACK=training`.
- The GPU nodes carry the topology labels (nodes outside a GPU cluster carry none):

  ```bash
  kubectl get nodes -l nip.nebius.io/infiniband=true \
    -L topology.nebius.com/gpu-cluster-id,topology.nebius.com/tier-2,topology.nebius.com/tier-1,kubernetes.io/hostname
  ```

  Every row shows a `GPU-CLUSTER-ID`, `TIER-2` and `TIER-1` value. An empty column on a GPU node
  means it is not in a GPU cluster or TAS labels are not present yet; Kueue cannot place pods on it
  through `nip-ib` ([example output](https://docs.nebius.com/kubernetes/gpu/topology-aware-scheduling#example-output)).
- No other Kueue installation in the cluster (`kubectl get ns kueue-system` → not found), or upgrade
  it deliberately (below).

## Install and configure

| # | Command | Expect |
|---|---|---|
| 1 | `workloads/kueue/install.sh --dry-run` | the pinned version, URL and sha256 from `platform/versions.yaml` |
| 2 | `workloads/kueue/install.sh` | the manifest's sha256 matches; `deployment.apps/kueue-controller-manager condition met`; the four CRDs listed |
| 3 | `kubectl apply --server-side -k workloads/kueue/overlays/<stage>` | namespaces `team-nlp`, `team-vision`; Topology `nip-ib`; ResourceFlavor `nip-gpu-ib`; two ClusterQueues; two LocalQueues |
| 4 | `kubectl get topology,resourceflavor,clusterqueue,localqueue -A` | both ClusterQueues and LocalQueues `ACTIVE` (wide output: `kubectl get clusterqueue -o wide`) |

A ClusterQueue that stays inactive names the reason in its status
(`kubectl describe clusterqueue nip-team-nlp`): usually a ResourceFlavor or Topology that did not
apply. The queues apply before the CRDs exist only by mistake; re-run step 3 after step 2.

## Validate

| # | Check | Expect |
|---|---|---|
| 1 | `kubectl apply -k workloads/kueue/sample-job`, then `kubectl -n team-nlp get workloads` | one Workload, `ADMITTED` true within seconds when two GPU nodes in one GPU cluster are free |
| 2 | `kubectl -n team-nlp get pods -l batch.kubernetes.io/job-name=tas-sample -o wide` and the node list above | both pods on nodes with the same `topology.nebius.com/gpu-cluster-id` |
| 3 | `kubectl -n team-nlp logs -l batch.kubernetes.io/job-name=tas-sample` | eight `GPU n:` lines per pod |
| 4 | Shrink the free GPUs below 16 in one GPU cluster (or raise `parallelism` to more nodes than one GPU cluster has) and re-submit | the Workload stays `Pending` with a topology reason in `kubectl describe workload`; no pod is created: the required topology holds |
| 5 | Borrow: submit enough `team-vision` jobs to use more than its nominal share while `team-nlp` is idle | admitted beyond the share (`kubectl get clusterqueue nip-team-vision -o jsonpath='{.status.flavorsUsage}'`) |
| 6 | Reclaim: submit the sample job in `team-nlp` | Kueue preempts `team-vision` workloads above its share (events on the Workload: `Preempted`); the sample job is admitted |

**Scripted:** `tests/validate/kueue.sh` runs 1–3, 5 and 6 and writes `results/kueue.json`: the sample
job admitted in one GPU cluster; `team-vision` jobs of one node each (`KUEUE_JOB_GPUS`, default 8) filling
the whole cohort, so its `flavorsUsage` shows GPUs `borrowed`; one `team-nlp` job of the same size
admitted by preempting a `team-vision` Workload. It refuses when both shares together exceed the GPUs on
the InfiniBand nodes; `--shares <gpus>` lowers both GPU shares for the drill and restores them on exit
(sandbox with two 8-GPU nodes: `--shares 8`). Its jobs carry `nip.nebius.io/drill=kueue-acceptance` and
are deleted afterwards. Step 4 (a topology that cannot fit) stays manual.

Record the run (date, stage, Kueue version, node count, outputs of 1–6) in
`docs/evidence/<date>-<stage>-kueue-validate.md` and flip the evidence row in the recipe.

## Add a team or change a share

1. Namespace `team-<team>` labelled `nip.nebius.io/team: <team>` (copy `base/namespaces.yaml`),
   a ClusterQueue `nip-team-<team>` in cohort `nip-gpu` selecting that label, a LocalQueue `gpu`.
2. Re-divide the shares in every `overlays/<stage>` patch; `make kustomize policy` fails if the sum
   passes the stage cap (`max_gpu_nodes.training` × 8 in `platform/stages.yaml`).
3. `kubectl apply --server-side -k workloads/kueue/overlays/<stage>`. Lowering a share does not stop
   admitted workloads; new admissions follow the new quota.

## Upgrade Kueue

Read the release notes of every minor version crossed (Kueue's "Actions required before
upgrading"). Change `workloads.kueue` (version and the new `manifests.yaml` sha256) in
`platform/versions.yaml`, `make compat-matrix`, then `workloads/kueue/install.sh` (server-side apply
upgrades in place). Check the queues are `ACTIVE` again (step 4).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Job never suspended, pods start without admission | the job lacks `kueue.x-k8s.io/queue-name`, or its kind's integration is off (Kubeflow kinds: [README](../workloads/kueue/README.md#outputs-and-composition)) |
| Workload `Pending`, "couldn't assign flavors" | the queue's nominal share plus what it can borrow is below the request; or the flavor's nodes are not labelled `nip.nebius.io/infiniband=true` |
| Workload `Pending` with a topology message | not enough free nodes in one domain of the requested level; use a wider level or `podset-preferred-topology` ([steps](https://docs.nebius.com/kubernetes/gpu/topology-aware-scheduling#steps)) |
| Admitted, pods `Pending` | a node went `NotReady` after admission, or a non-Kueue pod took the GPUs; `kubectl describe pod` |
| Pods rejected with `exceeded quota` | a ResourceQuota in the namespace (R5's `team-research`) caps GPUs below the Kueue share; drop its GPU lines |

## Teardown

```bash
kubectl delete -k workloads/kueue/sample-job
kubectl delete -k workloads/kueue/overlays/<stage>        # deletes the team namespaces and every job in them
v=$(python3 -I -c 'import sys; sys.path.insert(0, "scripts"); from versions import load; print(load()["workloads/kueue"]["version"])')
kubectl delete -f "https://github.com/kubernetes-sigs/kueue/releases/download/${v}/manifests.yaml"
```

Nothing in the cloud to remove; the GPU nodes belong to the training stack.
