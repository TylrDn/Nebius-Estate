# NVL72 runbook — R15 rack-scale GB300

Get GB300 NVL72 capacity, unlock it in the stage policy, add racks to a training cluster, validate a
rack and remove it. The stack is [`terraform/stacks/nvl`](../terraform/stacks/nvl/README.md).
**Mocked tests only:** capacity is not approved, and nothing here has been planned against the real
API. Every step below that touches the cloud waits for an approved reservation.

Upstream references: [NVLink instance group](https://docs.nebius.com/terraform-provider/reference/resources/compute_v1_nvl_instance_group),
[node-group reservations](https://docs.nebius.com/kubernetes/node-groups/reservations#how-to-add-reservations-to-node-groups),
[capacity block groups](https://docs.nebius.com/overview/limits/capacity-block-groups),
[topology labels](https://docs.nebius.com/kubernetes/gpu/topology-aware-scheduling#how-to-view-topology-labels-in-your-cluster).

Who: the platform team with the stage's apply identity; the reservation request goes through the
Nebius account manager. Duration: days to weeks for capacity; about an hour to apply a rack once it
is reserved. Risk: **spend** (a reservation is billed for its whole term) and **disruptive** to
nothing else (new node groups only).

## Before you start

1. **Capacity.** GB300 is not on the VM types, regions or pricing pages; rack-scale capacity is a
   sales conversation ([`docs/solutions/regions.md`](../docs/solutions/regions.md#gpu-platforms-per-region)).
   Ask the Nebius manager for a capacity block group: region, number of racks (18 nodes, 72 GPUs
   each), term, and the InfiniBand fabric if more than one rack. The manager creates the capacity
   block group and a commitment addendum ([capacity block groups](https://docs.nebius.com/overview/limits/capacity-block-groups)).
   Follow [`capacity-request.md`](capacity-request.md) for the paperwork and the spend approval.
2. **Read the reservation** once it exists (read-only):
   `nebius capacity capacity-block-group list` ([project limits](https://docs.nebius.com/overview/limits/manage-project-limits#how-to-set-a-custom-project-limit))
   → its ID, platform, fabric, region and intervals. Keep other stages off it with an R9 project
   limit of 0 ([`finance.md`](finance.md#changing-a-control)).
3. **Quotas** for the target project (console; the API omits limits): regular GPU VMs (default 12;
   a rack is 18), Network SSD capacity (default 4 TiB in eu-north1; a rack with 1,024 GiB boot
   disks needs 18 TiB), disks (32; two racks need 36)
   ([Compute quotas](https://docs.nebius.com/compute/resources/quotas-limits#gpu-virtual-machines)).
   Request increases first.
4. **Cluster.** R3 applied in the stage ([`deploy.md`](deploy.md)); its `cluster_id` and subnet.
5. **Stage policy.** A reviewed change to [`platform/stages.yaml`](../platform/stages.yaml) raises
   `max_gpu_nodes.nvl` for the stage to racks × 18 (the policy refuses other values) and keeps
   `require_strict_reservation.nvl: true`; then `make render-live` creates
   `terraform/live/<stage>/nvl` and `make ci` passes. Until then every plan with a rack stops with
   "caps gpu_node_count for nvl at 0".

## Deploy

| # | Command | Expect |
|---|---|---|
| 1 | `source scripts/bootstrap-backend.sh <stage> nvl` | backend config for `terraform/live/<stage>/nvl` |
| 2 | `export TF_VAR_cluster_id="$(terraform -chdir=terraform/live/<stage>/training output -raw cluster_id)" TF_VAR_subnet_id=<the cluster's subnet>` | R3's cluster |
| 3 | `export TF_VAR_racks=1 TF_VAR_capacity_reservation_ids='["<capacity block group id>"]'`; two or more racks also `TF_VAR_gpu_cluster_id=<GPU cluster in the reservation's fabric>` | the plan refuses a rack without a reservation, and 2+ racks without a GPU cluster |
| 4 | `make init plan STAGE=<stage> STACK=nvl` | per rack: one `nebius_compute_v1_nvl_instance_group` (`GB300`, size 18) and one node group (18 × `gpu-gb300` `4gpu-112vcpu-800gb`, STRICT reservation) |
| 5 | `make apply CONFIRM=yes STAGE=<stage> STACK=nvl` | the node group fails rather than fall back to the common pool if the reservation has no free capacity (STRICT) |

## Validate

| # | Check | Expect |
|---|---|---|
| 1 | `kubectl get nodes -l nip.nebius.io/nvl-rack=rack-001` | 18 nodes `Ready` |
| 2 | `kubectl get nodes -l nip.nebius.io/nvl=true -L topology.nebius.com/tier-0,topology.nebius.com/gpu-cluster-id` | every node of a rack shares one `tier-0` value (the multi-node NVLink domain) |
| 3 | `kubectl describe node <node> \| grep nvidia.com/gpu` | allocatable 4 |
| 4 | `nebius compute nvl-instance-group get --id <racks.rack-001.nvl_instance_group_id>` (read; not in the docs; per CLI help, `nebius` 0.12.285) | 18 instances `RUNNING`, `reconciling` false ([status](https://docs.nebius.com/terraform-provider/reference/resources/compute_v1_nvl_instance_group#nested-schema-for-statusinstances)) |
| 5 | an NCCL all-reduce across the 72 GPUs (no GB300 manifest in this repository yet; the upstream bundled test targets 8-GPU nodes) | bus bandwidth recorded with method and versions (P6) |

Record the run in `docs/evidence/<date>-<stage>-nvl-<what>.md` and flip the evidence row in the
stack README.

## Operate

- **Node replacement.** Updates replace one node at a time (`max_surge 0`, `max_unavailable 1`): an
  18-VM NVLink group has no room for a surge node, so a template change runs at 17 of 18 nodes
  until it finishes. Plan template changes (driver preset, boot disk, labels) as maintenance.
- **No resize.** A node group with NVLink cannot change its node count; capacity changes by whole
  racks (`racks`), each a new NVLink group and node group.
- **Maintenance and health.** As for other GPU nodes ([`maintenance.md`](maintenance.md),
  [`incident.md`](incident.md)); the rack-scale service level counts 16 of 18 nodes per rack and
  keeps 2 as maintenance buffer ([`docs/solutions/platforms.md`](../docs/solutions/platforms.md#published-service-levels)).

## Teardown

```bash
make destroy-plan STAGE=<stage> STACK=nvl                  # review: node groups, then NVLink groups
make destroy CONFIRM=yes STAGE=<stage> STACK=nvl
```

The capacity block group stays and stays billed for its term; return the stage cap to 0 in
`platform/stages.yaml` (and `make render-live`) when the reservation ends.
