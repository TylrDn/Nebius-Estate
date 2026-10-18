# Scenario playbooks

Each playbook: the shape, the recipes, the capacity option, risks, questions to ask, and links.
Facts come from the linked pages (read **2026-10-11**); anything not documented is marked as a
question for Nebius. Numbers are arithmetic, not quotes. The worked, priced version of each playbook is the
solution in its **Solution** row ([`solutions/`](../../solutions/README.md)).

## 1. Startup fine-tunes a 70B model for two weeks

| | |
|---|---|
| Solution | [S2](../../solutions/S2-fine-tune-70b-two-weeks/README.md): sizing, quota checklist, priced cost model and delivery steps |
| Shape | Full fine-tune: ~16 B/param × 70B ≈ 1.1 TB before activations → 2 × 8-GPU H200 nodes (2256 GB) or 1–2 × 8-GPU B300 (2304 GB per node) on one GPU cluster. LoRA: often one 8-GPU node ([sizing](compute-and-capacity.md#training-memory-per-parameter)) |
| Recipes | R2 (stage project, state, CI identity) → R8 (dataset + checkpoint buckets, shared filesystem) → R3 (`terraform/stacks/training`, GPU cluster on the region's fabric, NCCL + DDP validation) |
| Alternative | Token Factory post-training (SFT full or LoRA) if the base model is supported and they do not need their own loop ([post-training](https://docs.tokenfactory.nebius.com/post-training/overview)) |
| Capacity | 2 × 8 × 24 × 14 = 5,376 GPU-hours. On-demand fits default quotas in `eu-north1` (H200 32 GPUs, 12 GPU VMs) but has no availability guarantee at start or after a stop. For a fixed two-week window, a capacity block group with STRICT policy ([reservations](https://docs.nebius.com/compute/virtual-machines/reservations)); R2 prod policy already requires STRICT for training |
| Region | H200: `eu-north1` (fabric-7), `eu-west1`, `us-central1` (quota 0 by default); B300: `uk-south1`, `eu-west2`, `us-north1` ([regions.md](regions.md)) |
| Storage | Hot dataset and checkpoints on a shared filesystem sized for bandwidth (each 4 TiB ≈ +3.7 GiB/s read); copy final checkpoints to Object Storage ([storage](storage-and-data.md#choosing-storage-by-data-type)) |
| Risks | Start-date capacity; quota requests take days ([`runbooks/capacity-request.md`](../../runbooks/capacity-request.md)); NCCL misconfiguration; filesystem undersized; preemptible would lose up to a checkpoint interval |
| Ask | Base model and licence; full vs LoRA; tokens in the dataset; target epochs; checkpoint interval and size; start date; budget ceiling; who operates the cluster |
| Validate | `ibstatus`, NCCL all-reduce, then a short DDP run before the long job ([GPU cluster test](https://docs.nebius.com/compute/clusters/gpu/test)) |

## 2. Burst training on preemptible capacity

| | |
|---|---|
| Solution | [S4](../../solutions/S4-burst-training-preemptible/README.md): sizing, quota checklist, priced cost model and delivery steps |
| Shape | Elastic or restartable jobs (hyper-parameter sweeps, data processing, small fine-tunes) |
| Recipes | R3 with a preemptible GPU node group (`gpu_preemptible = true`, `follows_spot_price` or a pricing policy), R8 for checkpoints; or Serverless AI jobs on preemptible VMs ([jobs](https://docs.nebius.com/serverless/jobs/manage)) |
| Capacity | Spot price per GPU-hour, can change every 15 min, capped one cent below PAYG; separate preemptible VM quota (8 per region) ([spot pricing](https://docs.nebius.com/signup-billing/pricing-policy), [Compute quotas](https://docs.nebius.com/compute/resources/quotas-limits)) |
| Behaviour | 60 s `SIGTERM`; VM stopped, volumes kept, dynamic IP lost; cannot convert to regular; no reservations ([preemptible](https://docs.nebius.com/compute/virtual-machines/preemptible)) |
| Risks | No availability guarantee; spot price can exceed a pricing-policy max and stop the job; multi-node IB jobs lose all ranks when one node goes; repo policy forbids preemptible for recorded benchmarks and non-sandbox serving ([ADR-0007](../decisions/0007-capacity-on-demand-vs-preemptible.md), `platform/stages.yaml`) |
| Ask | Can each job checkpoint within 60 s or resume from the last checkpoint? Max acceptable price? Deadline? |

## 3. Enterprise private serving with VPN to on-prem

| | |
|---|---|
| Solution | [S1](../../solutions/S1-private-llm-serving-vpn/README.md): sizing, quota checklist, priced cost model and delivery steps |
| Shape | Open-weight model served from Managed Kubernetes, reachable only from the corporate network |
| Recipes | R7 (private workload subnet without public pool, custom NAT for egress, bastion) → R1 (`terraform/stacks/inference`, `public_endpoint = false` in prod) → R8 (weights on shared filesystem) → R2 (prod stage) |
| Connectivity | Site-to-site IPsec via Nebius VPN Gateway, a VM-based open-source solution from Professional Services ([VPN Gateway](https://docs.nebius.com/vpc/nebius-vpn-gateway)); WireGuard jump host for admins ([WireGuard](https://docs.nebius.com/compute/virtual-machines/wireguard)). Managed interconnect or peering: docs silent |
| Capacity | Serving: on-demand plus an AUTO reservation for the steady floor (falls back to PAYG); keep N+1 replicas because restart after stop is not guaranteed on PAYG |
| Security | Default security group allows all and cannot be removed: add explicit DENY rules at higher priority; SecretStash for tokens; Audit Logs (preview); access permits per resource ([networking](networking-and-security.md)) |
| Risks | CIDR overlap with on-prem (check default pools, [regions.md](regions.md#regions-and-locations)); VPN VM is a single point of failure unless doubled; MK8s 99.90% service level only with HA etcd ([SLA](https://docs.nebius.com/legal/sla-levels/managed-kubernetes)); preview services carry no service level |
| Ask | On-prem CIDRs and VPN device; throughput needed over the tunnel; who manages the VPN VM; authentication in front of the model; logging/retention requirements; certifications required ([trust center](https://nebius.com/trust-center)) |

## 4. Research lab migrates a Slurm cluster

| | |
|---|---|
| Solution | [S5](../../solutions/S5-slurm-migration/README.md): sizing, quota checklist, priced cost model and delivery steps |
| Shape | Users keep `sbatch`/`srun`, shared home, containers (Pyxis/Enroot) |
| Options | Managed Soperator (not in `us-north1`, `uk-south2`; **GPU workers need a capacity block group**), Pro Solution (Nebius-run, reserved capacity contracts), or self-deployed R4 (`terraform/stacks/soperator`, solutions-library tag) on PAYG ([deploy options](https://docs.nebius.com/slurm-soperator/deploy/overview)) |
| Recipes | R4, R8 (datasets via transfer → `/data`), R2 |
| Capacity | Reservation for the steady cluster; ephemeral nodes let reserved GPUs move between Soperator training and an MK8s inference cluster on the same capacity block group (Soperator ≥ 3.0, enabled by Nebius) ([ephemeral nodes](https://docs.nebius.com/slurm-soperator/capacity/ephemeral-nodes)) |
| Health | Soperator runs NCCL checks as jobs, drains slow nodes, replaces nodes on maintenance events ([features](https://docs.nebius.com/slurm-soperator/overview/why-slurm-soperator)) |
| Risks | Kubernetes version window narrower than MK8s's (R4 notes 1.32–1.35 at 4.1.13: [`docs/soperator-compatibility.md`](../soperator-compatibility.md)); jail filesystem sizing; user/UID migration; IO M3 quota for controller spool ([`docs/capacity.md`](../capacity.md#stackssoperator-lab-profile-every-stage)) |
| Ask | Current Slurm version and plugins (accounting, QoS, MIG); partitions and fair-share; dataset size and location; number of users; container runtime; whether they want Nebius to operate it |

## 5. LLM API without managing GPUs

| | |
|---|---|
| Solution | [S3](../../solutions/S3-llm-api-token-factory/README.md): sizing, quota checklist, priced cost model and delivery steps |
| Options | Token Factory public endpoints (per token, shared, region "Global"), Token Factory dedicated endpoints (per GPU-hour, fixed region, min/max replicas), or Serverless AI endpoint with the customer's own container (Compute prices, per second) |
| Recipe | R11 (`recipes/token-factory`) for Token Factory; R10 (`terraform/stacks/gpu-vm`) as the self-host counterpart; R6 (`recipes/serverless`) to measure a Serverless AI endpoint vs R1 on the same image and prompts |
| Capacity | Public: dynamic rate limits (15-min windows, up to 20× base), Batch API for async. Dedicated: minimum replicas held while active; capacity released on any stop; "no formal SLA unless covered by contract" ([capacity](https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/capacity-and-scaling)) |
| Risks | Public endpoint region can change without notice; model deprecations (e.g. 2026-08-31 removals); Serverless AI has no published service level or autoscaling description |
| Ask | Which model(s); tokens per day and peak RPM/TPM; latency target; data residency; fine-tuned weights?; need for private networking |

## 6. Multi-region DR for serving

| | |
|---|---|
| Solution | [S6](../../solutions/S6-multi-region-dr/README.md): sizing, quota checklist, priced cost model and delivery steps |
| Shape | Active/standby or active/active R1 clusters in two regions with the same GPU platform |
| Region pairs by platform | B300: `uk-south1`, `eu-west2`, `us-north1`; H200: `eu-north1`, `eu-west1`, `us-central1`; RTX PRO 6000: `us-central1`, `uk-south2`, `eu-south1` ([regions.md](regions.md#gpu-platforms-per-region)) |
| Recipes | R2 per region (projects are per region), R1 per region, R8 with Object Storage transfers to copy weights between regions ([transfers](https://docs.nebius.com/object-storage/transfer/overview)) |
| Capacity | Standby region: decide whether to reserve (cost) or accept on-demand risk at failover time |
| What the docs do not provide | Global load balancing, cross-region managed replication for buckets or filesystems, cross-region private networking: docs silent; DNS failover must be external |
| Risks | Standard-class egress to another region is charged; Enhanced Throughput egress is free ([pricing](https://docs.nebius.com/object-storage/resources/pricing#egress-traffic)); Standard class missing in B300 regions; per-region quotas start at defaults |
| Repo | Recovery objectives and rebuild order: [`docs/dr.md`](../dr.md), [`runbooks/backup-restore.md`](../../runbooks/backup-restore.md) |
| Ask | RTO/RPO; acceptable cold-start (weight download + warm-up); which region pair is legally acceptable |

## 7. Data residency in the EU

| | |
|---|---|
| Solution | [S7](../../solutions/S7-eu-data-residency/README.md): sizing, quota checklist, priced cost model and delivery steps |
| EU regions | `eu-north1` Finland, `eu-south1` Spain, `eu-west1` France, `eu-west2` France; `eu-north2` Iceland is private (existing deployments only) ([regions](https://docs.nebius.com/overview/regions)) |
| GPU choice | B300 only in `eu-west2` (EU); H100/H200/L40S in `eu-north1`; H200 in `eu-west1`; RTX PRO 6000 in `eu-south1` |
| Service gaps | `eu-south1`: no Serverless AI, PostgreSQL or MLflow; `eu-west1`: no MLflow; Standard/Intelligent Object Storage absent in `eu-south1`, `eu-west2` |
| Inference API | Token Factory public endpoints are not region-bound; use dedicated endpoints in a chosen region ([public serverless](https://docs.tokenfactory.nebius.com/public-serverless)) |
| Controls | Keep buckets, filesystems, secrets and projects in the EU region; SecretStash is region-scoped ([SecretStash](https://docs.nebius.com/mysterybox/overview)); audit export to an EU bucket |
| Ask Nebius | Location of control-plane, IAM, billing and support data; certification scope per region; GDPR DPA terms ([DPA](https://docs.nebius.com/legal/dpa)) |
| UK note | `uk-south1` and `uk-south2` are in the United Kingdom, not the EU |

## 8. Several teams share one GPU estate

| | |
|---|---|
| Solution | [S9](../../solutions/S9-data-science-notebooks/README.md) (its shared GPU pool: R5 namespaces, R16 Kueue queues): sizing, quota checklist, priced cost model and delivery steps |
| Shape | One MK8s cluster (or one capacity block group across projects), per-team quotas and access |
| Recipes | R5 (`recipes/team-platform`: namespace, ResourceQuota, Role, SkyPilot service account) and R16 (`workloads/kueue`: team queues with borrowable GPU shares, topology-aware placement) on R3 |
| Nebius controls | Projects per team with custom groups and access permits ([groups](https://docs.nebius.com/iam/authorization/groups)); project limits on a shared capacity block group ([project limits](https://docs.nebius.com/overview/limits/project-limits)); budgets per project ([budgets](https://docs.nebius.com/signup-billing/budgets)); cost allocation labels on Compute resources ([labels](https://docs.nebius.com/signup-billing/usage/cost-allocation-labels)) |
| Risks | Labels do not reach non-Compute charges; FOCUS conformance still lists "Tags: No" (`.cache/nebius-docs/signup-billing/usage/focus-conformance.md:25`), but the export's `Tags` column carries cost allocation labels for Compute rows (`signup-billing/usage/focus-fields.md:63`, `cost-allocation-labels.md:7`; [gaps](gaps-and-discrepancies.md)); a GPU cluster and its VMs must share one project, so IB jobs cannot span team projects |
| Ask | Isolation level (namespace vs project vs tenant); chargeback granularity; scheduler (Kueue, Run:ai, SkyPilot) |

## 9. Batch inference over a large corpus

| | |
|---|---|
| Solution | [S8](../../solutions/S8-batch-inference/README.md): sizing, quota checklist, priced cost model and delivery steps |
| Options | Token Factory Batch API (higher limits than real-time) ([rate limits](https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits)); Serverless AI jobs; R1 cluster with preemptible node group in sandbox-like stages |
| Data | Input/output in Object Storage; Enhanced Throughput avoids request and egress charges ([pricing](https://docs.nebius.com/object-storage/resources/pricing)) |
| Ask | Corpus size, deadline, model, whether outputs leave the region |

## 10. Notebook and prototyping users

| | |
|---|---|
| Solution | [S9](../../solutions/S9-data-science-notebooks/README.md): sizing, quota checklist, priced cost model and delivery steps |
| Options | Serverless AI Devlabs (stop/start, workspace persists, billed container disk while stopped) ([overview](https://docs.nebius.com/serverless/overview)); Standalone JupyterLab (`eu-north1`, `us-central1`) ([applications](https://docs.nebius.com/applications)) |
| Risk | Idle GPU spend: stop Devlabs; budgets notify only |
