# Troubleshooting

Failure modes the official docs describe, the documented fix, and the runbook in this repository
that covers the procedure. All links read on **2026-10-11**. Work bottom-up: capacity and quota →
node → GPU → interconnect → storage → workload ([`runbooks/incident.md`](../../runbooks/incident.md)).

## Capacity and quota

| Symptom | Likely cause | Documented fix | Repo pointer |
|---|---|---|---|
| "Not enough resources" creating a VM or node | No free capacity for that platform/region | Try a similar platform or region; check the capacity advisor; reserve capacity via sales ([doc](https://docs.nebius.com/compute/virtual-machines/not-enough-resources)) | [`runbooks/capacity-request.md`](../../runbooks/capacity-request.md) |
| "Not enough resources" **restarting** a stopped VM | Stopped VMs release on-demand capacity | Check the capacity advisor; use a reservation for VMs that must restart ([doc](https://docs.nebius.com/compute/virtual-machines/not-enough-resources#error-restarting-a-stopped-vm)) | same |
| Apply fails midway with quota exceeded | Plan does not check quotas; VM counts from create to delete | Request quota (admin only) before apply; delete unused VMs ([quotas](https://docs.nebius.com/overview/quotas), [Compute quotas](https://docs.nebius.com/compute/resources/quotas-limits)) | [`docs/capacity.md`](../capacity.md#quotas-are-the-only-hard-cap), [`runbooks/incident.md` → Terraform run safety](../../runbooks/incident.md#terraform-run-safety) |
| First cluster fails in `eu-north1`/`us-central1` | Non-GPU vCPU default quota is 0 there | Request vCPU quota ([Compute quotas](https://docs.nebius.com/compute/resources/quotas-limits#non-gpu-virtual-machines)) | [`runbooks/deploy.md` → Prerequisites](../../runbooks/deploy.md#prerequisites) |
| Cluster create refused in `me-west1`/`eu-north2` | MK8s cluster quota 0 | Request quota ([MK8s quotas](https://docs.nebius.com/kubernetes/resources/quotas-limits)) | `platform/regions.yaml` notes |
| STRICT node group/VM fails to create | No active matching reservation | Check capacity block group status and intervals; use AUTO or fix IDs ([reservations](https://docs.nebius.com/compute/virtual-machines/reservations)) | [`runbooks/capacity-request.md`](../../runbooks/capacity-request.md) |
| Reserved VM silently on PAYG | Interval expired while running (VM continues as PAYG) | Watch "Ending in N days" on the Limits page ([capacity block groups](https://docs.nebius.com/overview/limits/capacity-block-groups)) | [`docs/capacity.md` → calendar](../capacity.md#capacity-calendar-fill-in-per-tenant) |
| New capacity block group (CBG) allocations blocked | Project limit reached ([project limits](https://docs.nebius.com/overview/limits/project-limits)) | Raise the project limit or free GPUs | — |
| Quota dropped without a request | Automatic quota reduction after low usage ([quotas](https://docs.nebius.com/overview/quotas#automatic-quota-reduction)) | Re-request; respond during the grace period | [`docs/capacity.md`](../capacity.md) |
| Managed Soperator offers no GPU workers | GPU workers require a capacity block group ([deploy](https://docs.nebius.com/slurm-soperator/deploy/overview#managed-service-for-soperator)) | Get a reservation, or self-deploy (R4) on PAYG | [`runbooks/soperator-jobs.md`](../../runbooks/soperator-jobs.md) |

## Preemptible and spot

| Symptom | Cause | Fix |
|---|---|---|
| VM stopped with ~60 s warning | Preempted (capacity or spot price above max) ([preemptible](https://docs.nebius.com/compute/virtual-machines/preemptible)) | Checkpoint on `SIGTERM`; restart or fall back to on-demand |
| Preemptible resource will not start; policy shows **Blocked** | Spot price above the policy max ([pricing policy](https://docs.nebius.com/signup-billing/pricing-policy)) | Raise max price, follow spot price, or wait |
| Capacity advisor shows preemptible VMs available but launch fails | Advisor assumes "follow spot price" ([advisor](https://docs.nebius.com/compute/virtual-machines/capacity-advisor)) | Compare policy max to current spot price |
| `RECOVER` rejected on a preemptible VM | Only `recovery_policy = FAIL` is supported | Set `FAIL`; handle restart in the orchestrator |

## Networking

| Symptom | Cause | Fix | Repo pointer |
|---|---|---|---|
| MK8s cluster stuck `Provisioning`: "Unable to allocate private ipv4 cidr /32 from the pool" | Allocation quota, subnet too small, or service CIDR too large ([doc](https://docs.nebius.com/kubernetes/troubleshooting/cidr-allocation-error)) | Free allocations, enlarge subnet, set a smaller `service_cidrs`; per node needs one /24 + one /32 ([requirements](https://docs.nebius.com/kubernetes/networking/requirements)) | R7 `cidr` variable |
| VMs cannot reach hosts in 172.17.0.0/16 | Docker default bridge route on the VM ([doc](https://docs.nebius.com/compute/virtual-machines/docker-subnet-conflict)) | Avoid that range or set Docker `bip` via cloud-init | R7 default 10.40.0.0/16 avoids it |
| Nodes in a private subnet cannot pull images | No egress route (empty or custom table, no NAT) ([routing](https://docs.nebius.com/vpc/routing/overview)) | Custom NAT gateway + 0.0.0.0/0 route ([NAT](https://docs.nebius.com/vpc/routing/custom-nat-gateway)) | R7 `enable_nat` |
| Traffic to another network/on-prem dropped | Default table discards private destinations outside the network | Route via a gateway allocation (VPN/WireGuard VM) | [networking-and-security.md](networking-and-security.md#routing-facts) |
| Route exists but traffic black-holed | Next-hop allocation not attached to a resource | Re-attach the allocation to the NAT/VPN VM | same |
| Unexpected traffic allowed despite your DENY | Default security group allows all; priority ordering | Inspect `.status.effective_priority` ([security groups](https://docs.nebius.com/vpc/security-groups/overview)) | R7 security groups |
| `kubectl` times out from your laptop | Public endpoint allowlist (update **overwrites** the list) or private endpoint only ([allowlist](https://docs.nebius.com/kubernetes/networking/limit-access-to-public-endpoint)) | Re-add your CIDR or connect through the bastion | prod `public_endpoint: false` in `platform/stages.yaml` |
| Dynamic public IP changed after preemption | Dynamic IPs are not preserved | Use a reserved allocation | — |

## GPU, drivers, interconnect

| Symptom | Cause | Fix | Repo pointer |
|---|---|---|---|
| "CUDA failed to initialize … error 802" | `nvidia-fabricmanager` not running ([doc](https://docs.nebius.com/compute/virtual-machines/cuda-init-error)) | Restart Fabric Manager per the doc | [`runbooks/incident.md` → GPU not visible](../../runbooks/incident.md#gpu-not-visible-to-pods-nvidiacomgpu-allocatable--0) |
| `nvidia.com/gpu` allocatable = 0 | Managed driver option off without GPU Operator, or wrong driver preset | Use a supported `drivers_preset` (`get-compatibility-matrix`) or install GPU Operator ([GPU set-up](https://docs.nebius.com/kubernetes/gpu/set-up)) | same; [ADR-0003](../decisions/0003-gpu-driver-ownership.md) |
| GPU Operator on B300 fails | B300 needs driver `580.95.05` on the operator path ([GPU set-up](https://docs.nebius.com/kubernetes/gpu/set-up)) | Set `driver.version=580.95.05` | `operator_driver_version` in `platform/regions.yaml` |
| IB devices missing on custom images | Network Operator required for B200 or IB node groups when not using the managed image | Install Network Operator before GPU Operator, in order ([GPU set-up](https://docs.nebius.com/kubernetes/gpu/set-up)) | — |
| GPU node cordoned by itself, then drained once its GPU pods stop | `NebiusGPUError=True` (GPU/IB/NVLink/Xid checks every 5 min) → automatic recovery: cordon, **wait until GPU workloads finish or are stopped**, drain (up to 1 h), stop/start the VM, uncordon (`.cache/nebius-docs/kubernetes/maintenance/health-checks.md:33-40`; [health checks](https://docs.nebius.com/kubernetes/maintenance/health-checks)) | A long-running job keeps the faulty node until the job stops: watch the condition, checkpoint and stop the job to let recovery proceed; make jobs resumable | [`runbooks/incident.md`](../../runbooks/incident.md) |
| Node replaced, name changed | `Ready` False > 5 min / Unknown > 15 min, or NRD boot-disk I/O errors | Do not pin workloads to node names | — |
| Cannot create GPU cluster node | Platform not on that fabric, non-8-GPU preset, or GPU cluster in another project ([GPU clusters](https://docs.nebius.com/compute/clusters/gpu)) | Match fabric ↔ platform; 8-GPU preset; same project | R3 plan-time checks (`terraform/stacks/training/main.tf`) |
| `ibstatus` shows a port not `LinkUp` | Physical/IB issue ([test](https://docs.nebius.com/compute/clusters/gpu/test)) | Report to support with the output | [`runbooks/incident.md` → NCCL](../../runbooks/incident.md#nccl--interconnect-training-env) |
| NCCL all-reduce `busbw` low or flat | Wrong `UCX_NET_DEVICES`/HCA list (H100/H200 use `mlx5_0..7`; B200/B300 examples use `mlx5_4..11`), NVLS disabled in the image, poor placement ([NCCL test](https://docs.nebius.com/slurm-soperator/jobs/examples/nccl-all-reduce)) | Use the platform-specific env from the doc; `NCCL_NVLS_ENABLE=1`; topology-aware placement ([TAS](https://docs.nebius.com/kubernetes/gpu/topology-aware-scheduling)) | `workloads/training` |
| VM stopped for maintenance | Overdue maintenance is enforced after the due date ([maintenance](https://docs.nebius.com/compute/virtual-machines/maintenance)) | Stop/start before due date, or ask support to reschedule (≤ 2×, ≤ 7 days each) | [`runbooks/maintenance.md`](../../runbooks/maintenance.md) |

## Storage

| Symptom | Cause | Fix | Repo pointer |
|---|---|---|---|
| PVC Pending on an old cluster | CSI not enabled (clusters created before 2025-01-07) ([disk CSI](https://docs.nebius.com/kubernetes/storage/disk-over-csi)) | Enable CSI per the doc | — |
| Pods on two nodes cannot share a disk PVC | Network disks attach to one node | Use a shared filesystem over CSI ([filesystem CSI](https://docs.nebius.com/kubernetes/storage/filesystem-over-csi)) | R1/R3 `existing_filesystem_id` |
| Filesystem slower than expected | Bandwidth scales per 4 TiB provisioned ([performance](https://docs.nebius.com/compute/storage/types#filesystem-performance)) | Grow the filesystem (and quota) | [storage-and-data.md](storage-and-data.md#shared-filesystems) |
| "No space" with free bytes | Inode limit (size ÷ 64 KiB above 256 GiB) | Pack small files (tar/webdataset) or grow | same |
| Apply fails creating IO M3 PVC | IO M3 capacity quota (Soperator spool) | Request quota | [`docs/capacity.md` → soperator](../capacity.md#stackssoperator-lab-profile-every-stage) |
| Bucket create fails with class `STANDARD` | Standard not offered in `uk-south1`, `uk-south2`, `eu-south1`, `eu-west2`, `us-north1` ([classes](https://docs.nebius.com/object-storage/storage-classes)) | Use `ENHANCED_THROUGHPUT` | R8 `dataset_storage_class` |
| Object uploads throttled | Standard/Intelligent 20 GBps per tenant per region | Enhanced Throughput for hot paths | — |
| `BucketObjectsCountExceeded` (HTTP 400) | 1 billion objects (100 million versions if versioned) ([limits](https://docs.nebius.com/object-storage/resources/quotas-limits)) | Shard buckets or ask support | — |
| Writes misbehave right after enabling versioning | Up to 15 min to take effect on an existing bucket ([versioning](https://docs.nebius.com/object-storage/buckets/versioning)) | Wait 15 min before PUT/DELETE | R8 checkpoints bucket |
| Data lost after VM stop | Local SSD is ephemeral ([local SSD](https://docs.nebius.com/compute/storage/local-disks)) | Durable storage for anything not recreatable | — |
| A CSI disk outlived its cluster | `pvc-*` disks are created by Kubernetes, not Terraform | Delete PVCs before destroy; residue check | [`runbooks/teardown.md`](../../runbooks/teardown.md) |

## Serverless AI and Token Factory

| Symptom | Cause | Fix |
|---|---|---|
| Failed job/endpoint; cannot SSH in | Service deletes VM and boot disk on failure for custom images | Wrap the command with `|| sleep 86400` and add an SSH key ([debugging](https://docs.nebius.com/serverless/jobs/failure)) |
| Endpoint returns 401 | Token auth enabled | Send `Authorization: Bearer <token>` ([endpoints](https://docs.nebius.com/serverless/endpoints/manage)) |
| Endpoint stuck `PROVISIONING` | Capacity or quota for the preset (Compute quotas apply) | Capacity advisor covers Serverless AI VMs ([advisor](https://docs.nebius.com/compute/virtual-machines/capacity-advisor)) |
| Token Factory HTTP 429 | Dynamic rate limit ([rate limits](https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits)) | Ramp gradually; Batch API; Enterprise tier or dedicated endpoint |
| Dedicated endpoint stays "Not ready" after restart | Capacity released on stop/incident/maintenance ([capacity](https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/capacity-and-scaling)) | Wait, or reserve capacity via sales |
| Model ID stops working | Model deprecation on Serverless ([notice](https://docs.tokenfactory.nebius.com/august-2026-deprecation-notice)) | Migrate to the recommended replacement or a dedicated endpoint |

## Observed in this repository's runs (2026-10-11)

Not in the docs; from the first applies of `live/sandbox/inference` and the read-only runs. Register:
[`upstream-findings.md`](../upstream-findings.md#2026-10-11-findings-from-this-repositorys-own-runs).

| Symptom | Cause | Fix | Repo pointer |
|---|---|---|---|
| `nvidia.com/gpu` allocatable = 0 on a cluster with no CPU node group | GPU node tainted `nvidia.com/gpu`, no untainted node for the add-ons (non-GPU vCPU quota 0 in `eu-north1`) ([connectors](../evidence/2026-10-11-sandbox-inference-portal-connectors.md), [populate](../evidence/2026-10-11-sandbox-inference-populate.md)) | `cpu_node_count = 0`: no CPU group and an untainted GPU group (`terraform/stacks/inference/main.tf` line 36); allocatable 1 on the second apply | [`runbooks/deploy.md`](../../runbooks/deploy.md); [`incident.md`](../../runbooks/incident.md#gpu-not-visible-to-pods-nvidiacomgpu-allocatable--0) |
| vLLM 0.31 engine fails after loading weights: `OSError: [Errno 30] Read-only file system` | Triton/Inductor writes `/root/.triton` on the read-only root filesystem ([populate](../evidence/2026-10-11-sandbox-inference-populate.md)) | Cache and config homes on the writable emptyDir (`TRITON_HOME`, `TRITON_CACHE_DIR`, `VLLM_CONFIG_ROOT`, `XDG_CONFIG_HOME`); fixed in the manifest, not yet re-run live | `workloads/inference/base/deployment.yaml`; [`incident.md`](../../runbooks/incident.md#vllm-crashloopbackoff--oom) |
| No subnet named `default-subnet`; `status.default` absent | The default subnet is `default-subnet-<suffix>`; nebius CLI 0.12.285 omits `status.default` ([connectors](../evidence/2026-10-11-sandbox-inference-portal-connectors.md)) | Match the name prefix, or pass `subnet_id` | `scripts/bootstrap-backend.sh` |
| Residue check misses attached `pvc-*` disks | The attachment is `status.readWriteAttachment` (singular) ([connectors](../evidence/2026-10-11-sandbox-inference-portal-connectors.md)) | Read the singular field | `scripts/leftovers.sh` line 77 |
| Compute list fails with `--page-size 1000` | Compute accepts at most 999, undocumented ([connectors](../evidence/2026-10-11-sandbox-inference-portal-connectors.md)) | List with `--all` | `scripts/leftovers.sh` line 37 |
| Throttle alert never fires | `DCGM_FI_DEV_CLOCK_THROTTLE_REASONS` is absent; Nebius serves `DCGM_FI_DEV_CLOCKS_EVENT_REASONS` ([observability](../evidence/2026-10-11-observability-read-only.md)) | Query the new name (or both) | `platform/alerts/gpu-health.yaml` line 31 |
| Trial or promo spend not identifiable in the FOCUS export | `x_TrialId` column present but every value `NULL` ([`costs.md`](../evidence/costs.md)) | Read credit use in the console | [`runbooks/finance.md`](../../runbooks/finance.md) |

## Escalation

Support is free; tickets are technical (per service and project) or billing
([support](https://docs.nebius.com/overview/support)). Service status: [status.nebius.com](https://status.nebius.com/).
Include region, project, resource IDs, timestamps (UTC) and the exact error text.
