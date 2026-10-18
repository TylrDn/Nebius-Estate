# Platforms and managed services

What each Nebius platform is for, when to pick it, its documented limits, and the recipe that
covers it. All links read on **2026-10-11**.

## Choosing a platform

| Need | First choice | Why | Recipe |
|---|---|---|---|
| Full control of serving stack, private networking, own observability | Managed Kubernetes | nodes are your VMs; control plane free | R1, R5, R7 |
| Multi-node training with Kubernetes-native tooling (Kubeflow, Kueue, Volcano, SkyPilot) | Managed Kubernetes + GPU cluster | InfiniBand node groups, topology labels | R3 |
| Researchers who know Slurm | Soperator (managed, Pro, or self-deployed) | `sbatch`, shared root filesystem, health checks | R4 |
| Containerized job or endpoint without managing VMs | Serverless AI | per-second billing, Compute quotas | R6 |
| LLM tokens through an API, no GPUs to manage | Token Factory public endpoints | per-token pricing | R11 (`recipes/token-factory`); R6 compares a self-run endpoint |
| Dedicated model capacity in a fixed region without operating it | Token Factory dedicated endpoints | per GPU-hour, user-selected region | R11 (documented, not scripted) |
| Plain VMs (custom stack, MPI, dstack) | Compute | full control | R10 (`terraform/stacks/gpu-vm`, one GPU VM) |

## Managed Service for Kubernetes

Sources: [components](https://docs.nebius.com/kubernetes/components),
[versions](https://docs.nebius.com/kubernetes/versions),
[deprecation policy](https://docs.nebius.com/kubernetes/version-deprecation),
[GPU set-up](https://docs.nebius.com/kubernetes/gpu/set-up),
[autoscaling](https://docs.nebius.com/kubernetes/node-groups/autoscaling),
[health checks](https://docs.nebius.com/kubernetes/maintenance/health-checks),
[quotas](https://docs.nebius.com/kubernetes/resources/quotas-limits),
[pricing](https://docs.nebius.com/kubernetes/resources/pricing).

| Topic | Documented behaviour |
|---|---|
| Pricing | Nodes billed as Compute VMs and disks; the pricing page lists no control-plane charge |
| Control plane HA | 3 etcd members by default; HA "does not affect the cost". The 99.90% service level applies only to etcd size 3–5 |
| Versions | 1.36 (recommended, default for new clusters), 1.35, 1.34. 1.30–1.33 are end of life but still listed as supported for clusters created earlier |
| Deprecation | At most 3 supported + 1 deprecated version; deprecated version lasts 2 months, then clusters are force-upgraded (control plane; node groups only as needed for skew, can jump several versions) |
| Upgrades | Manual; control plane first, then node groups; not automatic otherwise. Single-etcd clusters are unavailable during control-plane upgrade |
| Feature gates | Alpha feature gates cannot be enabled |
| CNI | Cilium |
| GPU drivers | Managed images via `drivers_preset`: `cuda12.8` (driver 570.x) or `cuda13.0` (580.x), Ubuntu 24.04. Confirm per platform and version with `nebius mk8s node-group get-compatibility-matrix`. B200 1-GPU (`1gpu-20vcpu-224gb`) needs 580.x (`cuda13.0`) ([GPU images](https://docs.nebius.com/compute/storage/boot-disk-images#images-for-gpu-vms)) |
| Custom drivers / MIG | Disable the managed driver option and install NVIDIA GPU Operator (B300 needs driver `580.95.05`); Network Operator also required for B200 or InfiniBand node groups on non-managed images |
| Autoscaling | Cluster autoscaler per node group (min/max). Docs tip: keep a CPU node group (≥ 2 nodes or autoscaled) so CoreDNS/Cilium do not pin GPU nodes |
| Node health | Node Problem Detector; auto-replace on NRD boot-disk I/O errors (30 s), `Ready=False` > 5 min or `Unknown` > 15 min; GPU/IB/NVLink/Xid checks every 5 min → cordon, wait for GPU workloads, drain (≤ 1 h), stop/start |
| Storage | CSI for disks (one node at a time) and shared filesystems (many nodes); clusters created before 2025-01-07 need CSI enabled ([disk CSI](https://docs.nebius.com/kubernetes/storage/disk-over-csi)) |
| Reservations | Node groups take `reservation_policy` like VMs; preemptible node groups cannot ([MK8s reservations](https://docs.nebius.com/kubernetes/node-groups/reservations)) |
| Quotas | 2 clusters per region (0 in `me-west1`, `eu-north2`); nodes use Compute quotas |
| Integrations | SkyPilot, Run:ai, Anyscale, dstack documented ([3rd-party](https://docs.nebius.com/3p-integrations)) |

Repository mapping: R1 `terraform/stacks/inference`, R3 `terraform/stacks/training`, version
window in `platform/regions.yaml` (`kubernetes_versions`), stage offsets in `platform/stages.yaml`,
driver ownership in [ADR-0003](../decisions/0003-gpu-driver-ownership.md).

## Soperator (Slurm on Kubernetes)

Sources: [Soperator](https://docs.nebius.com/slurm-soperator),
[why Soperator](https://docs.nebius.com/slurm-soperator/overview/why-slurm-soperator),
[deployment options](https://docs.nebius.com/slurm-soperator/deploy/overview),
[quotas](https://docs.nebius.com/slurm-soperator/managed-soperator/resources/quotas),
[pricing](https://docs.nebius.com/slurm-soperator/managed-soperator/resources/pricing),
[ephemeral nodes](https://docs.nebius.com/slurm-soperator/capacity/ephemeral-nodes),
[GitHub soperator](https://github.com/nebius/soperator).

| Option | What it is | Constraints from the docs |
|---|---|---|
| Managed Service for Soperator | Console-deployed Slurm cluster on Nebius-managed infrastructure | All regions except `us-north1`, `uk-south2`. **GPU worker nodes require capacity block groups** (reserved GPUs). Nodes and filesystems billed as Compute; buckets as Object Storage |
| Pro Solution for Soperator | Deployed and assisted by Nebius HPC experts; contracts with reserved capacity and discounted pricing | via sales |
| Self-deployment on Nebius | Terraform recipe in [`nebius-solutions-library/soperator`](https://github.com/nebius/nebius-solutions-library/tree/main/soperator) creating an MK8s cluster with Soperator | your quotas, on-demand or reserved |
| Elsewhere / on-prem | Install on any Kubernetes | "has not been tested on platforms other than Nebius AI Cloud" |

Features documented: shared root filesystem across login and worker nodes ("jail"), Pyxis/Enroot,
Apptainer and Docker containers, NCCL health checks as Slurm jobs that drain nodes below the
benchmark, prolog/epilog GPU checks, replacement of faulty nodes on Compute maintenance events,
DCGM/Slurm metrics. Latest releases on 2026-10-11: Soperator `4.1.13` (2026-10-05); solutions
library tag `soperator-v4.1.13-2` (2026-10-07) ([releases](https://github.com/nebius/soperator/releases),
[library releases](https://github.com/nebius/nebius-solutions-library/releases)).

Repository mapping: R4 `terraform/stacks/soperator` wraps the solutions-library recipe at the
pinned tag ([`docs/soperator-compatibility.md`](../soperator-compatibility.md),
[ADR-0008](../decisions/0008-slurm-scheduler-and-soperator.md)). Note the upstream repository is
now `nebius/nebius-solutions-library` (the old `nebius-solution-library` URL redirects).

## Serverless AI

Sources: [overview](https://docs.nebius.com/serverless/overview),
[endpoints](https://docs.nebius.com/serverless/endpoints/manage),
[jobs](https://docs.nebius.com/serverless/jobs/manage),
[lifecycle](https://docs.nebius.com/serverless/lifecycle),
[pricing and quotas](https://docs.nebius.com/serverless/pricing-quotas),
[debugging](https://docs.nebius.com/serverless/jobs/failure).

| Type | Use | Stop/start | Public URL | Container disk |
|---|---|---|---|---|
| Devlab | browser IDE / notebook | yes | yes | workspace persists across stop |
| Job | training, fine-tuning, batch inference, evaluation; ends on completion or timeout | no | no | removed when the job ends |
| Endpoint | real-time serving | yes | yes | removed on stop/delete |

| Fact | Detail |
|---|---|
| Runtime | Compute container VMs managed by the service; SSH possible, not visible as Compute resources |
| Billing | Compute prices; running = compute + storage; stopped endpoint = nothing; stopped Devlab = container disk; mounted buckets/filesystems billed separately even when stopped |
| Quotas | Compute quotas; SSH key or static public IP consumes the public-IP quota |
| Capacity | Regular or preemptible (spot pricing policy or follow spot price) |
| Endpoint auth | Optional bearer token (`--auth token`), token from flag or SecretStash; off by default |
| Endpoint network | Managed `https://` URL per HTTP port (`tls://host:443` per TCP port) whatever the IP type; a public static IP is optional and spends quota. Managed URLs carry 80 Mbps / 300 connections per endpoint, 400 Mbps / 1,500 per project, 2 Gbps / 2,000 per region ([limits](https://docs.nebius.com/serverless/endpoints/manage#traffic-and-connection-limits)) |
| Job lifecycle | Success is `COMPLETED`; `FAILED` = workload, `ERROR` = service or capacity (`state_details.code`, e.g. `NotEnoughResources` after 30 min of `PROVISIONING`); timeout 1–168 h, default 24 h; `--restart-policy on-failure` opt-in ([lifecycle](https://docs.nebius.com/serverless/lifecycle#job-statuses)) |
| Volumes | `--volume` mounts a bucket or shared filesystem (`ro`/`rw`) into jobs and endpoints; billed separately ([jobs](https://docs.nebius.com/serverless/jobs/manage#how-to-create-a-job)) |
| Failure debugging | Failed custom-image deployments delete the VM; wrap with `sleep` on failure to keep it for SSH |
| Regions | Not in `eu-north2`, `eu-south1`, `us-north1` ([regions](https://docs.nebius.com/overview/regions)) |

Endpoint autoscaling, replica counts and a service level for Serverless AI: **docs silent**.

Repository mapping: R6 `recipes/serverless` runs the same model on an endpoint, a job and R1 for
a measured comparison ([ADR-0001](../decisions/0001-kubernetes-vs-serverless.md)). Examples:
[serverless-ai-cookbook](https://github.com/nebius/serverless-ai-cookbook).

## Token Factory

Separate product with its own docs at [docs.tokenfactory.nebius.com](https://docs.tokenfactory.nebius.com/)
and its own legal terms ([Token Factory terms](https://docs.nebius.com/legal/token-factory)).

| Topic | Public serverless endpoints | Dedicated endpoints |
|---|---|---|
| Capacity | shared, multi-tenant | allocated to your organization while active |
| Region | "Global": processing location can change any time without notice; not for workloads that need a stable region | fixed, user-selected |
| Rate limits | dynamic; evaluated in 15-min windows, +20% at ≥ 80% use, −33% at ≤ 50%, ceiling 20× base; HTTP 429 beyond; Batch API has higher limits | no standard limits; throughput = deployed capacity |
| Scaling | platform-managed | min/max replicas; minimum replicas reserved and non-preemptible while active |
| Weights | base models | custom weights for eligible models |
| Pricing | per token | per GPU-hour, billed per minute; not billed while provisioning/not ready, replica restarts, graceful shutdown |
| Capacity after stop/incident/maintenance | n/a | released to the shared on-demand pool; restart may wait for capacity |
| SLA | not stated | "do not include a formal SLA unless covered by contract"; historical average monthly request success ≈ 99.9% |

Sources: [public serverless](https://docs.tokenfactory.nebius.com/public-serverless),
[dedicated overview](https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/overview),
[capacity and scaling](https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/capacity-and-scaling),
[billing policy](https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/billing-policy),
[rate limits](https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits).

Also documented: OpenAI-compatible API, two model flavors (base and `-fast` with speculative
decoding), post-training (supervised fine-tuning on full weights or LoRA, custom speculator
training; reinforcement fine-tuning by request) ([post-training](https://docs.tokenfactory.nebius.com/post-training/overview)),
Data Lab, Sandboxes, SSO and team access. Models are deprecated on published dates (e.g. ten
serverless models removed 2026-08-31, dedicated endpoints unaffected)
([August 2026 notice](https://docs.tokenfactory.nebius.com/august-2026-deprecation-notice)).
The name "AI Studio" does not appear in current docs; use "Token Factory".

## Other managed services

| Service | What it is for | Regions | Status / price | Source |
|---|---|---|---|---|
| Managed MLflow | experiment tracking, model registry | `eu-north1`, `me-west1`, `us-central1`, `uk-south1`, `eu-west2` | paid; service level 95% | [MLflow](https://docs.nebius.com/mlflow) |
| Managed PostgreSQL | metadata, app databases | `eu-north1`, `eu-west1`, `me-west1`, `us-central1`, `uk-south1`, `eu-west2` | paid; service level 99.50% read and write | [PostgreSQL](https://docs.nebius.com/postgresql) |
| Container Registry | Docker images, Helm charts | all | free; 10 registries per region (0 in `eu-north2`) | [Container Registry](https://docs.nebius.com/container-registry), [quotas](https://docs.nebius.com/container-registry/resources/quotas-limits) |
| Monitoring, Logging, Tracing | metrics (Prometheus-compatible), logs, traces, Grafana access, alerts (Compute, Object Storage) | all | preview, free | [Observability](https://docs.nebius.com/observability), [pricing](https://docs.nebius.com/observability/resources/pricing) |
| Standalone Applications | JupyterLab, ComfyUI, Flowise, Open WebUI, Qdrant | `eu-north1`, `us-central1` | per app | [Applications](https://docs.nebius.com/applications) |
| Nebius Tunnels | expose a local HTTP/TCP service via outbound agent | all except `us-north1`, `uk-south2` | preview | [Tunnels](https://docs.nebius.com/tunnels/overview) |

Reading platform metrics from your own tools: PromQL against
`https://read.monitoring.api.nebius.cloud/projects/<project>/service-provider/prometheus/api/v1/query`
answered with project `viewer` on 2026-10-11 ([evidence](../evidence/2026-10-11-portal-live-read-only.md)). That path holds the provider
metrics behind the console dashboards, including DCGM GPU metrics for GPU VMs
([VM monitoring](https://docs.nebius.com/compute/monitoring/virtual-machines#gpu-monitoring-metrics));
the first 2026-10-11 sandbox apply saw DCGM series for its L40S node at that path, labelled
`instance_id`, `mk8s_cluster_id`, `mk8s_node_group_id`
([evidence](../evidence/2026-10-11-sandbox-inference-portal-connectors.md)), and the R14 run listed 112
`DCGM_*` names there ([evidence](../evidence/2026-10-11-observability-read-only.md)). `…/projects/<project>/prometheus` is for metrics
you ingest and returns 404 until something writes there. For federation scrapes the docs now use
regional hosts ([gaps](gaps-and-discrepancies.md#official-sources-disagree-or-are-ambiguous)).

What a project-scoped read-only identity can inventory (verified 2026-10-11): Compute instances,
disks, filesystems, GPU clusters, snapshots and platforms (25 GPU presets listed), MK8s clusters,
VPC networks/subnets/pools/route tables/security groups/allocations, buckets and transfers, Serverless
AI endpoints/jobs/devlabs, PostgreSQL and MLflow clusters, registries, tunnels, KMS keys, SecretStash
secret metadata, maintenance events, DNS zones and quota usage. The repository's portal uses exactly
this set ([`docs/portal/capability-matrix.md`](../portal/capability-matrix.md)); its credential is set up as in
[`docs/credentials.md`](../credentials.md#portal-read-only-service-account), and the Observability pages are indexed in
[`docs/reference/nebius-docs.md`](../reference/nebius-docs.md).

Preview services: "without guaranteed service levels", not recommended for production, free
while in preview, may become paid at GA ([service stages](https://docs.nebius.com/overview/services#service-and-application-stages)).

## Published service levels

Source: [Service Levels index](https://docs.nebius.com/legal/sla-levels) (published 2026-10-06)
and the general [SLA](https://docs.nebius.com/legal/sla). Read the exclusions before quoting. The
`legal/sla-levels` pages are **not in the cached docs** (`.cache/nebius-docs/legal.md` links the SLA
only), so the levels below, including the 95 % for Standalone Applications, cannot be re-checked
offline: re-read the live page before quoting.

| Service | Level | Measured per | Key condition |
|---|---|---|---|
| Compute VMs | 99.50% | VM | unavailable = a GPU failed, NVLink or fabric connectivity lost, boot disk inaccessible, or no external connectivity; workload slowdowns and benchmark degradation excluded ([Compute](https://docs.nebius.com/legal/sla-levels/compute)) |
| Rack-scale GPU systems (GB300 NVL72, Vera Rubin NVL72) | 99.50% | rack (18 nodes, 16 SLA-covered, 2 maintenance buffer) | same page |
| Managed Kubernetes | 99.90% | service | only HA control plane (etcd 3–5); unavailability = no control-plane access ≥ 5 min ([MK8s](https://docs.nebius.com/legal/sla-levels/managed-kubernetes)) |
| Disks | 99.50% | disk | non-replicated and local disks excluded ([Disks](https://docs.nebius.com/legal/sla-levels/disks)) |
| Shared filesystems | 99.50% | filesystem | performance below published maxima is not unavailability ([Shared filesystem](https://docs.nebius.com/legal/sla-levels/shared-filesystem)) |
| Object Storage | 99.98% | storage class | error-rate based; filesystem buckets excluded ([Storage](https://docs.nebius.com/legal/sla-levels/storage)) |
| VPC | 99.50% | — | external connectivity of resources with Nebius public IPs ([VPC](https://docs.nebius.com/legal/sla-levels/vpc)) |
| Managed PostgreSQL | 99.50% | DB cluster, read and write separately | [PostgreSQL](https://docs.nebius.com/legal/sla-levels/managed-postgresql) |
| Managed MLflow | 95% | service | [MLflow](https://docs.nebius.com/legal/sla-levels/managed-mlflow) |
| Standalone Applications | 95.00% | service | [Standalone](https://docs.nebius.com/legal/sla-levels/applications/standalone) |

Not in the index: Serverless AI, Soperator (managed), Token Factory, Observability, Audit Logs,
KMS, SecretStash. Service credits are a percentage of the affected service fee; read the tiers on
each page.

## Third-party integrations

Documented: SkyPilot (VMs and MK8s), dstack, Run:ai, Anyscale, mpirun on GPU clusters, Wiz
([integrations](https://docs.nebius.com/3p-integrations)). Official example repositories:
[ml-cookbook](https://github.com/nebius/ml-cookbook) (Slurm, SkyPilot, Run:ai, Volcano, DeepEP
samples), [token-factory-cookbook](https://github.com/nebius/token-factory-cookbook),
[nebius-ps-services](https://github.com/nebius/nebius-ps-services) (jump host, NCCL test, VPN
gateway).
