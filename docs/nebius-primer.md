# Nebius AI Cloud primer

The Nebius AI Cloud services the recipes build on, where each one appears in this repository, how a GPU
workload lands, the vocabulary, and the gotchas to know before a first apply. Facts link to
docs.nebius.com. Documented services the recipes do not use are in [building blocks](building-blocks.md).

## 1. What Nebius AI Cloud is

Nebius AI Cloud is a GPU-first public cloud: Compute VMs on NVIDIA GPU platforms (H100, H200,
B200, B300, L40S), InfiniBand GPU clusters, Managed Service for Kubernetes (MK8s), shared
filesystems, S3-compatible Object Storage, and managed layers above them (Marketplace
applications, Serverless AI, Managed Soperator). Everything is driven by one API, exposed through
the `nebius` CLI, SDKs and the `nebius/nebius` Terraform provider.

**Resource hierarchy** ([iam/overview](https://docs.nebius.com/iam/overview),
[overview/regions](https://docs.nebius.com/overview/regions))

| Level | What it holds | Notes |
|---|---|---|
| Tenant | Projects, users, groups, federation, quotas, billing | The IAM root; cannot be deleted. Default groups `auditors`, `viewers`, `editors`, `admins` carry tenant-wide roles ([groups](https://docs.nebius.com/iam/authorization/groups)). |
| Project | Most service resources (VMs, disks, filesystems, GPU clusters, MK8s clusters, buckets, service accounts) | Pinned to **one region**; sign-up gives one project per region. Service and platform availability depend on the project's region. |
| Resource | e.g. an MK8s cluster | Some nest further: a node group's parent is its cluster, a group membership's parent is its group. |

Access is granted to **groups**, never directly to accounts. Custom groups receive roles through
**access permits** scoped to the tenant, a project, or an individual resource
([groups](https://docs.nebius.com/iam/authorization/groups)). Automation runs as a **service
account** that is a member of such a group and authenticates with an authorized key
([service-accounts/manage](https://docs.nebius.com/iam/service-accounts/manage)).
In this repo each stage is its own project; [`terraform/live/foundation`](../terraform/live/foundation/)
creates the per-stage identities (ADR [0009](decisions/0009-environment-and-promotion-model.md)).

## 2. Services you will touch, and where they live in this repo

"Nebius" = Nebius operates it; "you" = this repo (or the customer) owns its configuration and lifecycle.

| Service | What it is | Managed by | Repo path(s) | Docs |
|---|---|---|---|---|
| Compute VMs, GPU platforms and presets | VMs sized by *platform* (CPU/GPU type) and *preset* (GPU/vCPU/RAM combination) | Nebius runs hosts; you pick platform + preset | [`platform/regions.yaml`](../platform/regions.yaml) | [types](https://docs.nebius.com/compute/virtual-machines/types) |
| GPU clusters and InfiniBand fabrics | A group of 8-GPU VMs on one InfiniBand fabric (400 Gbps per GPU, GPUDirect RDMA, per-cluster P-Key isolation) | Nebius runs the fabric; you create the cluster | [`terraform/modules/gpu-cluster`](../terraform/modules/gpu-cluster/), `stacks/training` | [clusters/gpu](https://docs.nebius.com/compute/clusters/gpu) |
| Managed Kubernetes: cluster | Control plane (API server, etcd, scheduler, cluster autoscaler) plus CoreDNS and Cilium add-ons | Nebius | [`terraform/modules/mk8s-cluster`](../terraform/modules/mk8s-cluster/) | [components](https://docs.nebius.com/kubernetes/components) |
| Managed Kubernetes: node groups | Identical worker VMs from one template; fixed size or autoscaled | You (through MK8s, not Compute) | [`terraform/modules/node-group`](../terraform/modules/node-group/) | [node-groups/manage](https://docs.nebius.com/kubernetes/node-groups/manage) |
| MK8s drivers presets | Node image with NVIDIA driver and Container Toolkit preinstalled (`cuda13.0` = 580.x, `cuda12.8` = 570.x) | Nebius builds the image; you choose the preset | `modules/node-group` (`drivers_preset`), `platform/regions.yaml` | [gpu/set-up](https://docs.nebius.com/kubernetes/gpu/set-up) |
| MK8s health checks and auto-repair | Node Problem Detector checks; unhealthy nodes are deleted and recreated | Nebius (on by default for clusters created from 2025-12-01) | defaults kept in `modules/node-group` | [health-checks](https://docs.nebius.com/kubernetes/maintenance/health-checks) |
| Shared filesystems | Network file storage attached to many VMs in one project (virtiofs); exposed to pods via the `csi-mounted-fs-path` CSI chart | Nebius runs storage; you attach, mount and size | [`terraform/modules/filestore`](../terraform/modules/filestore/), [`terraform/modules/filestore-csi`](../terraform/modules/filestore-csi/) | [storage/types](https://docs.nebius.com/compute/storage/types), [filesystem-over-csi](https://docs.nebius.com/kubernetes/storage/filesystem-over-csi) |
| Object Storage | S3-compatible buckets: the Terraform state backend (`use_lockfile = true`), and R8's dataset and checkpoint buckets; data transfers copy from an external S3-compatible source | Nebius | [`terraform/modules/foundation/state-bucket`](../terraform/modules/foundation/state-bucket/), [`scripts/bootstrap-backend.sh`](../scripts/bootstrap-backend.sh), [`terraform/stacks/data`](../terraform/stacks/data/) | [store-terraform-state](https://docs.nebius.com/object-storage/store-terraform-state), [transfers](https://docs.nebius.com/object-storage/transfer/overview) |
| VPC: networks, pools, subnets, allocations, routes | Per-project default network and subnet; an *allocation* is a reserved public or private IP; a route table can send `0.0.0.0/0` to a NAT VM | Nebius provides defaults; R7 builds its own | [`terraform/modules/network`](../terraform/modules/network/) (subnet lookup for R1/R3), [`terraform/stacks/network`](../terraform/stacks/network/) (R7) | [vpc/overview](https://docs.nebius.com/vpc/overview), [custom NAT gateway](https://docs.nebius.com/vpc/routing/custom-nat-gateway) |
| VPC security groups | Stateful/stateless allow/deny rules attached to resources | You | created by R7; `security_group_ids` input of `modules/node-group` and the stacks | [security-groups/manage](https://docs.nebius.com/vpc/security-groups/manage) |
| IAM: service accounts, authorized keys, access keys | Non-human identities; authorized key = key pair for API/CLI/Terraform; access key = S3 credential | You | [`modules/foundation/ci-service-account`](../terraform/modules/foundation/ci-service-account/), [`modules/foundation/state-identity`](../terraform/modules/foundation/state-identity/), [`scripts/ci-token.sh`](../scripts/ci-token.sh) | [authorized-keys](https://docs.nebius.com/iam/service-accounts/authorized-keys), [access-keys](https://docs.nebius.com/iam/service-accounts/access-keys) |
| Applications (Marketplace) | Nebius-packaged Helm charts installed into MK8s (`nebius_applications_v1alpha1_k8s_release`) | Nebius packages; you install and configure | [`modules/device-plugin`](../terraform/modules/device-plugin/), [`modules/o11y`](../terraform/modules/o11y/) (Prometheus + Grafana, observability agent), [`modules/gpu-operator`](../terraform/modules/gpu-operator/), [`modules/network-operator`](../terraform/modules/network-operator/); CSI chart in `modules/filestore-csi` | [manage-applications](https://docs.nebius.com/kubernetes/manage-applications) |
| Observability | Console dashboards, metrics, logs and alerts; the Nebius Observability Agent ships cluster metrics | Nebius | `modules/o11y`, [`platform/alerts`](../platform/alerts/) | [observability](https://docs.nebius.com/observability), [nebius-o11y-agent](https://docs.nebius.com/observability/agents/nebius-o11y-agent) |
| Capacity block groups, reservations, quotas | Reserved GPUs on one platform and fabric for dated intervals; quotas are per region and project | Nebius allocates on request; you reference them | `gpu_reservation` in both stacks, [`docs/capacity.md`](capacity.md), [`docs/capacity.md` (quotas per stack)](capacity.md#quotas-per-stack), [`runbooks/capacity-request.md`](../runbooks/capacity-request.md) | [capacity-block-groups](https://docs.nebius.com/overview/limits/capacity-block-groups), [quotas](https://docs.nebius.com/overview/quotas) |
| Serverless AI: endpoints and jobs | Containers run without VMs or clusters to manage; per-second billing | Nebius | [`recipes/serverless`](../recipes/serverless/) | [serverless/overview](https://docs.nebius.com/serverless/overview) |
| Soperator (Slurm on Kubernetes) | Operator that runs Slurm login, controller and worker nodes as pods (`SlurmCluster` CR); managed, Pro or self-deployed | Self-deployed here: you | [`terraform/stacks/soperator`](../terraform/stacks/soperator/README.md), [`docs/soperator-compatibility.md`](soperator-compatibility.md) | [architecture](https://docs.nebius.com/slurm-soperator/overview/architecture), [deploy](https://docs.nebius.com/slurm-soperator/deploy/overview) |

## 3. How a GPU workload lands

Each step maps to a module, the stack that calls it, and the check that proves it. Run the
checks bottom-up with `make validate-cluster` ([`tests/validate/run-all.sh`](../tests/validate/run-all.sh)
for inference, [`run-training.sh`](../tests/validate/run-training.sh) for training); each stops at the first failing layer.

| # | Step | Repo | Proof |
|---|---|---|---|
| 1 | Project, state bucket, identities, quotas | [`terraform/live/foundation`](../terraform/live/foundation/), [`docs/capacity.md` (quotas per stack)](capacity.md#quotas-per-stack) | stage policy preconditions at plan time ([`platform/stages.yaml`](../platform/stages.yaml)); `make policy` |
| 2 | Network: pick the subnet (immutable once resources attach) | `modules/network` | plan output |
| 3 | MK8s cluster: version, etcd size, endpoint exposure | `modules/mk8s-cluster` | plan output; `make kubeconfig` |
| 4 | CPU system node group (CoreDNS, Cilium, add-ons) | `modules/node-group` as `cpu_nodes` | [`00-nodes.sh`](../tests/validate/00-nodes.sh) |
| 5 | GPU node group: platform + preset + `drivers_preset` from `platform/regions.yaml`; training adds a GPU cluster on the region's fabric | `modules/node-group` as `gpu_nodes`; `modules/gpu-cluster` (training) | `00-nodes.sh`, [`01-gpu.sh`](../tests/validate/01-gpu.sh), [`02-interconnect.sh`](../tests/validate/02-interconnect.sh) / [`03-nccl.sh`](../tests/validate/03-nccl.sh) |
| 6 | Storage: shared filesystem attached to every node group, CSI StorageClass for RWX PVCs | `modules/filestore`, `modules/filestore-csi` | [`03-storage.sh`](../tests/validate/03-storage.sh) |
| 7 | Platform add-ons: device plugin (with DCGM exporter), Prometheus/Grafana, observability agent; Network + GPU Operator only when opted in | `modules/device-plugin`, `modules/o11y`, `modules/network-operator` → `modules/gpu-operator` | `01-gpu.sh` |
| 8 | Workload | [`workloads/inference`](../workloads/inference/README.md) (vLLM), [`workloads/training`](../workloads/training/README.md) (NCCL, DDP) | [`04-workload.sh`](../tests/validate/04-workload.sh), [`05-load.sh`](../tests/validate/05-load.sh) (`WITH_LOAD=1`) |

Steps 1 to 7 are wired together by [`terraform/stacks/inference`](../terraform/stacks/inference/) and
[`terraform/stacks/training`](../terraform/stacks/training/), applied per stage through
`terraform/live/<stage>/<stack>`.

## 4. Decisions behind the defaults

Driver path, node shape, capacity type, Kubernetes version, scheduler, storage, serving platform and state
layout are each an ADR, summarised one line apiece in the [ADR index](decisions/README.md).

## 5. Glossary

| Term | Meaning |
|---|---|
| Access key | AWS-style ID + secret for S3-compatible APIs (Object Storage, the state backend); not an access token ([access-keys](https://docs.nebius.com/iam/service-accounts/access-keys)). |
| Access permit | Grants a role to a custom group on a tenant, project or single resource ([groups](https://docs.nebius.com/iam/authorization/groups)). |
| Access token / IAM token | Short-lived bearer token; a user token lasts 12 h and is passed as `NEBIUS_IAM_TOKEN` (here also `TF_VAR_iam_token`) ([terraform-provider/authentication](https://docs.nebius.com/terraform-provider/authentication)). |
| Allocation | A reserved public or private IP address within a subnet; MK8s creates its own ([vpc/overview](https://docs.nebius.com/vpc/overview)). |
| Authorized key | Key pair for a service account; the public half is uploaded, the private half signs requests ([authorized-keys](https://docs.nebius.com/iam/service-accounts/authorized-keys)). |
| Auto-repair | MK8s recovery that deletes and recreates a node failing a health check; conditions can be disabled per node group ([enable-disable-health-checks](https://docs.nebius.com/kubernetes/maintenance/enable-disable-health-checks)). |
| Capacity block group | GPUs reserved on one platform and fabric for dated intervals, arranged through a Nebius manager ([capacity-block-groups](https://docs.nebius.com/overview/limits/capacity-block-groups)). |
| Device plugin | NVIDIA component that advertises `nvidia.com/gpu` to the kubelet; installed here as a Marketplace application (`modules/device-plugin`). |
| Drivers preset | Node-group setting (`cuda13.0`, `cuda12.8`) selecting a node image with drivers preinstalled ([gpu/set-up](https://docs.nebius.com/kubernetes/gpu/set-up)). |
| Fabric | A physical InfiniBand domain (`fabric-3`, `us-north1-a`, …); one fabric serves one GPU platform ([clusters/gpu](https://docs.nebius.com/compute/clusters/gpu)). |
| Filestore (this repo) | The repo's name for a Nebius shared filesystem (`modules/filestore`). |
| Foundation (this repo) | `terraform/live/foundation`: per-stage project, state bucket and identities, applied once by an administrator. |
| GPU cluster | Compute resource binding 8-GPU VMs to one fabric for InfiniBand; must be in the same project as the MK8s cluster ([kubernetes/gpu/clusters](https://docs.nebius.com/kubernetes/gpu/clusters)). |
| Jail (Soperator) | The recipe's name for Soperator's shared root filesystem, mounted as `/` on every login and worker node ([architecture](https://docs.nebius.com/slurm-soperator/overview/architecture)). |
| InfiniBand | The GPU-to-GPU network inside a GPU cluster: one 400 Gbps NIC per GPU, 3.2 Tbps per 8-GPU node ([clusters/gpu](https://docs.nebius.com/compute/clusters/gpu)). |
| Live root (this repo) | `terraform/live/<stage>/<stack>`: backend, providers and one stack call; generated by `scripts/render-live-roots.py`. |
| Marketplace application | A Nebius-packaged chart deployable to MK8s from the Applications catalog ([manage-applications](https://docs.nebius.com/kubernetes/manage-applications)). |
| Node group | Set of identical MK8s worker VMs created from one template ([node-groups/manage](https://docs.nebius.com/kubernetes/node-groups/manage)). |
| Nodeset (Soperator) | A group of Slurm worker nodes with one shape; the recipe maps each to MK8s node groups; the managed service calls it a worker node set ([managed-soperator/manage](https://docs.nebius.com/slurm-soperator/managed-soperator/manage)). |
| P-Key | InfiniBand partition key assigned per GPU cluster; isolates clusters sharing a fabric ([clusters/gpu](https://docs.nebius.com/compute/clusters/gpu)). |
| Platform | VM hardware type, e.g. `gpu-h100-sxm`, `gpu-b300-sxm`, `cpu-d3` ([types](https://docs.nebius.com/compute/virtual-machines/types)). |
| Preemptible | VM or node group that Nebius may stop at any time, billed at spot price; `SIGTERM` 60 s before stop ([preemptible](https://docs.nebius.com/compute/virtual-machines/preemptible)). |
| Preset | GPU/vCPU/RAM size on a platform, e.g. `1gpu-16vcpu-200gb`, `8gpu-128vcpu-1600gb` ([types](https://docs.nebius.com/compute/virtual-machines/types)). |
| Pricing policy | Caps the spot price for preemptible capacity; alternative is following the current spot price ([pricing-policy](https://docs.nebius.com/signup-billing/pricing-policy)). |
| Project | Regional container for most resources; the unit of quota configuration ([iam/overview](https://docs.nebius.com/iam/overview)). |
| Quota | Per-region, per-project resource ceiling, viewed under Administration → Limits ([quotas](https://docs.nebius.com/overview/quotas)). |
| Region | Location such as `eu-north1` or `us-central1`; a project lives in one, and services, platforms and quotas differ per region ([overview/regions](https://docs.nebius.com/overview/regions)). |
| Recipe (this repo) | A use-case bundle (R1–R16; the README table is the current list): stack or recipe directory, workloads, validation, runbook, evidence slot and upstream citation; listed in the [README](../README.md#recipes). |
| Reservation policy | `AUTO` (reservations first, then common pool, the default), `FORBID`, or `STRICT` (reservations only) ([node-groups/reservations](https://docs.nebius.com/kubernetes/node-groups/reservations)). |
| Service account | Non-human IAM identity for CLI, SDK and Terraform ([service-accounts/manage](https://docs.nebius.com/iam/service-accounts/manage)). |
| Shared filesystem | File storage attached to many VMs of one project at once; mounted over virtiofs ([storage/types](https://docs.nebius.com/compute/storage/types)). |
| Stack (this repo) | `terraform/stacks/<network\|data\|inference\|training\|soperator\|gpu-vm\|ml-services\|governance\|nvl>` (the nine directories under `terraform/stacks/`): the root module a stage promotes. |
| Stage (this repo) | `sandbox`, `staging` or `prod`; each its own project, state bucket and identities ([`platform/stages.yaml`](../platform/stages.yaml)). |
| Tenant | Top-level workspace holding projects, users, groups, quotas and billing ([iam/overview](https://docs.nebius.com/iam/overview)). |
| Topology labels | `topology.nebius.com/gpu-cluster-id` and `tier-0/1/2` node labels for topology-aware scheduling ([topology-aware-scheduling](https://docs.nebius.com/kubernetes/gpu/topology-aware-scheduling)). |

## 6. Gotchas worth knowing before the first apply

- **A user token overrides service-account credentials.** If both are present, the Terraform
  provider authenticates as the user ([terraform-provider/authentication](https://docs.nebius.com/terraform-provider/authentication)).
  [`scripts/ci-token.sh`](../scripts/ci-token.sh) refuses to run while `NEBIUS_IAM_TOKEN` is set.
- **Any node-group template change rolls every node**, including a drivers-preset change; a
  node-group version upgrade also replaces nodes. Each node is cordoned, drained (10 min default
  timeout, then forced) and replaced; scaling recreates nothing
  ([node-groups/manage](https://docs.nebius.com/kubernetes/node-groups/manage), [versions](https://docs.nebius.com/kubernetes/versions)).
  Platform, preset and GPU cluster cannot change at all: create a new node group and move the
  workload ([gpu/set-up](https://docs.nebius.com/kubernetes/gpu/set-up)).
- **Only 8-GPU presets on H100, H200, B200 and B300 join a GPU cluster**, and a cluster accepts
  only its fabric's platform; L40S has none ([types](https://docs.nebius.com/compute/virtual-machines/types),
  [`platform/regions.yaml`](../platform/regions.yaml)).
- **Keep a CPU node group of at least two nodes.** Otherwise CoreDNS and Cilium keep an
  autoscaled GPU group from scaling down ([node-groups/autoscaling](https://docs.nebius.com/kubernetes/node-groups/autoscaling)).
  The non-GPU vCPU quota defaults to 0 in `eu-north1` (this repository's default region) and
  `us-central1` (`.cache/nebius-docs/compute/resources/quotas-limits.md:41`), so request it before
  the first apply; until then the GPU-only path (`cpu_node_count = 0`, [`runbooks/deploy.md`](../runbooks/deploy.md))
  is what ran on 2026-10-11 ([evidence](evidence/2026-10-11-sandbox-inference-populate.md)).
- **Do not run the NVIDIA operators and a drivers preset together, and expect autoscaler
  over-provisioning with the operators.** With both operators installed the autoscaler can add more
  GPU nodes than needed; the docs' fix is a preset-based node group ([node-groups/autoscaling](https://docs.nebius.com/kubernetes/node-groups/autoscaling),
  [ADR-0003](decisions/0003-gpu-driver-ownership.md)).
- **Stopped VMs still bill their volumes**, and a VM shut down from inside the OS is rebooted and
  keeps billing; stop it through the API ([compute/resources/pricing](https://docs.nebius.com/compute/resources/pricing),
  [stopped-with-linux-commands](https://docs.nebius.com/compute/virtual-machines/stopped-with-linux-commands)).
- **New clusters default to Kubernetes 1.36; Soperator 4.1.13 supports 1.32–1.35.** Pin the version
  ([kubernetes/versions](https://docs.nebius.com/kubernetes/versions), [`terraform/stacks/soperator/README.md`](../terraform/stacks/soperator/README.md)).
- **CSI-created disks are outside Terraform state.** A disk created for a PVC is deleted with the
  claim ([disk-over-csi](https://docs.nebius.com/kubernetes/storage/disk-over-csi)); delete PVCs
  before destroying a cluster and run [`scripts/leftovers.sh`](../scripts/leftovers.sh)
  ([`runbooks/teardown.md`](../runbooks/teardown.md)).
- **Mount shared filesystems with `nofail`.** Without it a node whose filesystem is gone does not
  boot ([filesystem-over-csi](https://docs.nebius.com/kubernetes/storage/filesystem-over-csi)).
- **Reservations apply only to regular GPU node groups.** Preemptible and CPU node groups cannot use
  them; reserved GPUs do not count toward GPU quota ([node-groups/reservations](https://docs.nebius.com/kubernetes/node-groups/reservations)).
- **Check quotas per region first.** MK8s defaults to 2 clusters per region (0 in `me-west1` and
  `eu-north2`); GPU clusters default to 5 (0 in `eu-north2`)
  ([kubernetes quotas](https://docs.nebius.com/kubernetes/resources/quotas-limits),
  [compute quotas](https://docs.nebius.com/compute/resources/quotas-limits), [`docs/capacity.md` (quotas per stack)](capacity.md#quotas-per-stack)).
- **`ubuntu22.04-*` boot image families are deprecated.** Existing disks keep working, new disks
  cannot be created from them; R7's VMs use `ubuntu24.04-driverless`
  ([boot-disk-images](https://docs.nebius.com/compute/storage/boot-disk-images)).
- **Choose the subnet up front.** A resource cannot move to another network or subnet after
  creation ([vpc/networking/isolation](https://docs.nebius.com/vpc/networking/isolation)).

## 7. Where to go next

The [README](../README.md#recipes) for the recipe table, [architecture](architecture.md) for layers and
ownership, and [`runbooks/deploy.md`](../runbooks/deploy.md) for the first deploy.
