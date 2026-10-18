# Solutions field guide

Scenarios a Nebius AI Cloud Solutions Architect meets, mapped to official documentation and to
the recipes in this repository (R1–R16) and to the priced solutions built from them
([`solutions/`](../../solutions/README.md), S1–S9). Every fact links to its source; every link in this
directory was read on **2026-10-11**. Where the docs are silent, the page says so. No capacity,
price, SLA or availability is stated here unless a linked official page states it.

| File | Use it for |
|---|---|
| [regions.md](regions.md) | Which region has which GPU platform, service, fabric, default quota, storage class and default CIDR |
| [compute-and-capacity.md](compute-and-capacity.md) | GPU platforms and presets, InfiniBand, capacity options (on-demand, preemptible, reservations, commitments), quotas, sizing arithmetic |
| [storage-and-data.md](storage-and-data.md) | Disks, local SSD, shared filesystems, Object Storage classes, transfers; datasets vs checkpoints vs weights; R8 |
| [networking-and-security.md](networking-and-security.md) | VPC, subnets, pools, security groups, routing, NAT, VPN, IAM, secrets, KMS, audit logs; R7, R2 |
| [platforms.md](platforms.md) | Managed Kubernetes, Soperator, Serverless AI, Token Factory, MLflow, PostgreSQL, Container Registry, Observability |
| [use-cases.md](use-cases.md) | Scenario playbooks: architecture, recipe, capacity option, risks, questions |
| [pricing-and-billing.md](pricing-and-billing.md) | Billing units, PAYG vs commitments, spot pricing, budgets, FOCUS export, list prices with caveats |
| [troubleshooting.md](troubleshooting.md) | Failure modes from the docs with pointers into `runbooks/` |
| [gaps-and-discrepancies.md](gaps-and-discrepancies.md) | What the docs do not say, where official sources disagree, and what to confirm with Nebius |
| [../naming.md](../naming.md) | Naming and labelling standard: official ID prefixes, name and label constraints, Nebius-created defaults, cost allocation labels |

## First call checklist

Ask these before proposing anything. Each answer selects a row in the decision table below.

| # | Question | Why it matters | Where the answer lands |
|---|---|---|---|
| 1 | Workload: serving, fine-tuning, pre-training, batch inference, notebooks, HPC? | Picks the platform (MK8s, Soperator, Serverless AI, Token Factory) | [platforms.md](platforms.md) |
| 2 | Model(s) and size; precision (FP16/BF16, FP8, FP4); context length; concurrency | GPU memory per replica and GPUs per replica | [compute-and-capacity.md § Sizing](compute-and-capacity.md#sizing-arithmetic) |
| 3 | GPU type preference or constraint (H100, H200, B200, B300, RTX PRO 6000, L40S) | Narrows regions; only 1- and 8-GPU presets exist on most platforms | [regions.md](regions.md), [compute-and-capacity.md](compute-and-capacity.md#gpu-platforms) |
| 4 | GPU count and duration (peak and steady state); start date | On-demand vs preemptible vs capacity block group (reservation) | [compute-and-capacity.md § Capacity options](compute-and-capacity.md#capacity-options) |
| 5 | Multi-node? Needs InfiniBand / GPUDirect RDMA? | Requires a GPU cluster on a fabric; 8-GPU presets only | [compute-and-capacity.md § InfiniBand](compute-and-capacity.md#infiniband-gpu-clusters) |
| 6 | Data: size, object count, current location (other cloud, on-prem), read pattern | Object Storage class, shared filesystem size (performance scales with size), transfer plan | [storage-and-data.md](storage-and-data.md) |
| 7 | Compliance and residency: which countries, which certifications, PII/PHI | Region choice; Token Factory public endpoints are not region-pinned | [regions.md § Residency](regions.md#data-residency-notes), [networking-and-security.md](networking-and-security.md) |
| 8 | Network: public internet allowed? VPN to on-prem/other cloud? Private API endpoints? | R7 perimeter, VPN Gateway (Professional Services), private MK8s endpoint | [networking-and-security.md](networking-and-security.md) |
| 9 | Budget model: PAYG, prepaid commitment, spend cap? Who receives alerts? | Commitment discounts are company-only; budgets notify but do not cap | [pricing-and-billing.md](pricing-and-billing.md) |
| 10 | Team skills: Kubernetes, Slurm, neither? | MK8s (R1/R3/R5) vs Soperator (R4) vs Serverless AI (R6) vs Token Factory (R11) vs one GPU VM (R10) | [platforms.md](platforms.md) |
| 11 | Uptime expectation and who operates day 2 | Published service levels differ per service; preview services have none | [platforms.md § Service levels](platforms.md#published-service-levels) |
| 12 | Existing tooling: Terraform, SkyPilot, Run:ai, dstack, MLflow, W&B | Reuse integrations rather than build | [platforms.md § Integrations](platforms.md#third-party-integrations) |

## Scenario → recipe

| Scenario | Recipe(s) | Platform | Capacity option to discuss | Playbook | Solution |
|---|---|---|---|---|---|
| Serve an open model on GPUs the customer controls | R1 (`terraform/stacks/inference`), R7, R8 | Managed Kubernetes | on-demand; AUTO reservation for steady prod | [use-cases.md § Private serving](use-cases.md#3-enterprise-private-serving-with-vpn-to-on-prem) | [S1](../../solutions/S1-private-llm-serving-vpn/README.md) |
| Call an LLM API without managing GPUs | R11 (`recipes/token-factory`), R9; R10 (`terraform/stacks/gpu-vm`) as the self-host counterpart | Token Factory or Serverless AI endpoint | per token (public) or per GPU-hour (dedicated) | [use-cases.md § LLM API](use-cases.md#5-llm-api-without-managing-gpus) | [S3](../../solutions/S3-llm-api-token-factory/README.md) |
| Fine-tune a 7B–70B model for days to weeks | R3 (`terraform/stacks/training`), R8, R2 | MK8s + GPU cluster, or Token Factory post-training | capacity block group for a fixed window | [use-cases.md § Fine-tune](use-cases.md#1-startup-fine-tunes-a-70b-model-for-two-weeks) | [S2](../../solutions/S2-fine-tune-70b-two-weeks/README.md) |
| Multi-node pre-training on InfiniBand | R3 or R4, R8 | MK8s + GPU cluster, or Soperator | capacity block group (Managed Soperator GPU workers require one) | [use-cases.md § Slurm migration](use-cases.md#4-research-lab-migrates-a-slurm-cluster) | [S2](../../solutions/S2-fine-tune-70b-two-weeks/README.md), [S5](../../solutions/S5-slurm-migration/README.md) |
| Researchers want `sbatch` | R4 (`terraform/stacks/soperator`) | Managed Soperator / self-deployed Soperator | capacity block group | [use-cases.md § Slurm migration](use-cases.md#4-research-lab-migrates-a-slurm-cluster) | [S5](../../solutions/S5-slurm-migration/README.md) |
| Interruptible burst training or batch jobs | R3 with preemptible node group, or Serverless AI jobs | MK8s / Serverless AI | preemptible (spot price, 60 s SIGTERM) | [use-cases.md § Burst](use-cases.md#2-burst-training-on-preemptible-capacity) | [S4](../../solutions/S4-burst-training-preemptible/README.md), [S8](../../solutions/S8-batch-inference/README.md) |
| Several teams share one cluster | R5 (`recipes/team-platform`) + R16 (`workloads/kueue`) on R3 | MK8s namespaces + quotas | per-project limits on capacity block groups | [use-cases.md § Shared platform](use-cases.md#8-several-teams-share-one-gpu-estate) | [S9](../../solutions/S9-data-science-notebooks/README.md) |
| No public IPs on workloads, egress via controlled NAT, admin via VPN | R7 (`terraform/stacks/network`) | VPC | n/a | [networking-and-security.md](networking-and-security.md#how-r7-maps) | [S1](../../solutions/S1-private-llm-serving-vpn/README.md), [S7](../../solutions/S7-eu-data-residency/README.md) |
| Datasets and checkpoints that outlive a cluster | R8 (`terraform/stacks/data`, `workloads/data/copy-job`) | Object Storage + shared filesystem | n/a | [storage-and-data.md](storage-and-data.md#how-r8-maps) | every solution but S3 |
| Serving that survives a region loss | R1 per region, R2 per stage, R8 transfers | MK8s in two regions | on-demand + reservation per region | [use-cases.md § DR](use-cases.md#6-multi-region-dr-for-serving) | [S6](../../solutions/S6-multi-region-dr/README.md) |
| Data must stay in the EU | any recipe pinned to an EU region | per recipe | per recipe | [use-cases.md § EU residency](use-cases.md#7-data-residency-in-the-eu) | [S7](../../solutions/S7-eu-data-residency/README.md) |

## Conventions in this directory

| Convention | Meaning |
|---|---|
| "Docs silent" | No official page found that states it; ask Nebius, do not assume |
| "List price" | The PAYG price on the linked page on the verification date; never a quote, never a capacity or terms commitment |
| Platform IDs, preset names | Exactly as the API takes them (`gpu-h200-sxm`, `8gpu-128vcpu-1600gb`) |
| Repository terms | stage = sandbox/staging/prod ([`platform/stages.yaml`](../../platform/stages.yaml)); stack = `terraform/stacks/<name>`; region table = [`platform/regions.yaml`](../../platform/regions.yaml) |

Looking up an official page: the generated catalog of docs.nebius.com pages and sections is
[`docs/reference/nebius-docs.md`](../reference/nebius-docs.md).

Related repository docs: [capacity](../capacity.md), [cost](../cost.md), [primer](../nebius-primer.md),
[architecture](../architecture.md), [DR](../dr.md), [security](../security.md), [runbooks](../../runbooks/README.md).
