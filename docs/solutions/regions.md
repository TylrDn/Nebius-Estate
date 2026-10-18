# Regions

What each Nebius AI Cloud region offers, per the official docs. All links read on **2026-10-11**.
The live answer for a given project is always `nebius compute platform list` and the capacity
advisor ([list platforms](https://docs.nebius.com/compute/virtual-machines/list-platforms),
[capacity advisor](https://docs.nebius.com/compute/virtual-machines/capacity-advisor)).

## Regions and locations

Source: [Regions](https://docs.nebius.com/overview/regions), default pools from
[private address ranges](https://docs.nebius.com/vpc/addressing/available-addresses).

| Region | Location | Access | `default-network-pool` CIDR | In `platform/regions.yaml` |
|---|---|---|---|---|
| `eu-north1` | Finland | public | 10.0.0.0/13 | yes |
| `eu-north2` | Iceland | **private**: only for users who already have deployments there | 10.24.0.0/13 | yes |
| `eu-south1` | Madrid, Spain | public | 10.88.0.0/13 | **no** |
| `eu-west1` | France | public | 10.48.0.0/13 | yes |
| `eu-west2` | France | public | 10.72.0.0/13 | yes |
| `me-west1` | Israel | public | 10.144.0.0/13 | yes |
| `uk-south1` | United Kingdom | public | 10.64.0.0/13 | yes |
| `uk-south2` | United Kingdom | public | 10.80.0.0/13 | **no** |
| `us-central1` | Kansas City, Missouri, US | public | 10.96.0.0/13 | yes |
| `us-north1` | Woodbury, Minnesota, US | public | 10.104.0.0/13 | yes |

A project is created per region at signup ([regions](https://docs.nebius.com/overview/regions)).
Plan non-overlapping CIDRs before connecting regions or on-prem: default pools above do not
overlap each other, but a custom network (R7 default `10.40.0.0/16`) must not overlap the peer.

## GPU platforms per region

Sources: [VM types](https://docs.nebius.com/compute/virtual-machines/types),
[Regions → platforms](https://docs.nebius.com/overview/regions#availability-of-platforms-per-region),
[InfiniBand fabrics](https://docs.nebius.com/compute/clusters/gpu#infiniband-fabrics).

| Region | B300 `gpu-b300-sxm` | B200 `gpu-b200-sxm` / `-a` | H200 `gpu-h200-sxm` | H100 `gpu-h100-sxm` | RTX PRO 6000 `gpu-rtx6000` / `-a` | L40S `gpu-l40s-a` / `-d` | InfiniBand fabrics |
|---|---|---|---|---|---|---|---|
| `eu-north1` | — | — | ✓ | ✓ | — | ✓ / ✓ | `fabric-2`, `-3`, `-4`, `-6` (H100); `fabric-7` (H200) |
| `eu-north2`* | — | — | ✓ | — | — | — | `eu-north2-a` (H200) |
| `eu-south1` | — | — | — | — | `-a` | — | none listed |
| `eu-west1` | — | — | ✓ | — | — | — | `fabric-5` (H200) |
| `eu-west2` | ✓ | — | — | — | — | — | `eu-west2-a` (B300) |
| `me-west1` | — | `-a` | — | — | — | — | `me-west1-a` (B200 `-a`) |
| `uk-south1` | ✓ | — | — | — | — | — | `uk-south1-a` (B300) |
| `uk-south2` | — | — | — | — | `-a` | — | none listed |
| `us-central1` | — | `gpu-b200-sxm` | ✓ | — | `gpu-rtx6000` | — | `us-central1-a` (H200), `us-central1-b` (B200) |
| `us-north1` | ✓ | — | — | — | — | — | `us-north1-a` (B300) |

`*` private region. Non-GPU `cpu-d3` (AMD EPYC Genoa) is in every region; `cpu-e2` (Intel Ice
Lake) only in `eu-north1`. `cpu-d3` presets above 128 vCPU are not offered in `eu-north1` and
`eu-south1` ([VM types](https://docs.nebius.com/compute/virtual-machines/types#presets-for-non-gpu-platforms)).

GB200/GB300 NVL72 are **not** listed on the VM types or regions pages. They appear only in the
Compute service level ([SLA levels](https://docs.nebius.com/legal/sla-levels/compute), GB300 NVL72 and
Vera Rubin NVL72 as "Rack-Scale GPU System"), the Terraform resource
[`nebius_compute_v1_nvl_instance_group`](https://docs.nebius.com/terraform-provider/reference/resources/compute_v1_nvl_instance_group)
(types `GB200`, `GB300`), and the upstream recipe
([`k8s-training/locals.tf`](https://github.com/nebius/nebius-solutions-library/blob/main/k8s-training/locals.tf):
`gpu-gb300`, `4gpu-112vcpu-800gb`, 18 nodes per rack). Region availability for GB300 is not
documented on docs.nebius.com; the upstream Soperator module lists `eu-north1`
([`platform.tf`](https://github.com/nebius/nebius-solutions-library/blob/main/soperator/modules/available_resources/platform.tf)).
Treat rack-scale systems as a sales conversation.

## Services per region

Source: [Regions → services](https://docs.nebius.com/overview/regions#availability-of-services-per-region),
cross-checked with [Services](https://docs.nebius.com/overview/services). ✓ = available, — = not.

| Service | eu-north1 | eu-north2* | eu-south1 | eu-west1 | eu-west2 | me-west1 | uk-south1 | uk-south2 | us-central1 | us-north1 |
|---|---|---|---|---|---|---|---|---|---|---|
| Compute, MK8s, Object Storage, VPC, Container Registry, IAM, Audit Logs, KMS, SecretStash, Monitoring, Logging | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Managed Service for Soperator | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | — |
| Serverless AI | ✓ | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Managed PostgreSQL | ✓ | — | — | ✓ | ✓ | ✓ | ✓ | — | ✓ | — |
| Managed MLflow | ✓ | — | — | — | ✓ | ✓ | ✓ | — | ✓ | — |
| Standalone Applications | ✓ | — | — | — | — | — | — | — | ✓ | — |
| Nebius Tunnels (preview) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | — |

A missing service can be requested per region through support
([regions note](https://docs.nebius.com/overview/regions#availability-of-services-per-region)).
Token Factory is not part of this table; see [platforms.md](platforms.md#token-factory).

## Default quotas that change the first-day plan

Sources: [Compute quotas](https://docs.nebius.com/compute/resources/quotas-limits),
[MK8s quotas](https://docs.nebius.com/kubernetes/resources/quotas-limits),
[Object Storage quotas](https://docs.nebius.com/object-storage/resources/quotas-limits). "N/A" means
the platform does not exist in that region.

| Region | MK8s clusters | Non-GPU vCPUs | GPU quota without reservation (per GPU type) | Network SSD / IO M3 / filesystems | GPU clusters |
|---|---|---|---|---|---|
| `eu-north1` | 2 | **0** | H100 32, H200 32, L40S 32 | 4 TiB each | 5 |
| `eu-north2`* | **0** | **0** | H200 0; regular and preemptible GPU VMs 0 | 0 | 0 |
| `eu-south1` | 2 | 200 | RTX PRO 6000 32 | 5 TiB each | not listed |
| `eu-west1` | 2 | 200 | H200 **8** | **2 TiB** each | 5 |
| `eu-west2` | 2 | 200 | B300 32 | 5 TiB each | 5 |
| `me-west1` | **0** | 200 | B200 **0** | 5 TiB each | 5 |
| `uk-south1` | 2 | 200 | B300 32 | 5 TiB each | 5 |
| `uk-south2` | 2 | 200 | RTX PRO 6000 32 | 5 TiB each | not listed |
| `us-central1` | 2 | **0** | H200 **0**, B200 **0**, RTX PRO 6000 **0** | 5 TiB each | 5 |
| `us-north1` | 2 | 200 | B300 32 | 5 TiB each | 5 |

Also per region, all public regions: 12 regular GPU VMs, 8 preemptible GPU VMs, 12 non-GPU VMs, 3
public IPv4 addresses, 1000 allocations ([VPC quotas](https://docs.nebius.com/vpc/resources/quotas-limits)).
GPUs drawn from a capacity block group do not count against GPU quotas
([capacity block groups](https://docs.nebius.com/overview/limits/capacity-block-groups)).
Quotas can be lowered automatically after prolonged low usage, never below defaults, with an
email and a grace period ([Quotas](https://docs.nebius.com/overview/quotas#automatic-quota-reduction)).

## Storage-class and storage-feature availability

| Feature | Where | Source |
|---|---|---|
| Object Storage Enhanced Throughput class | all regions | [Storage classes](https://docs.nebius.com/object-storage/storage-classes) |
| Object Storage Standard and Intelligent classes | all regions **except** `uk-south1`, `uk-south2`, `eu-south1`, `eu-west2`, `us-north1` | same |
| Enhanced Throughput quota | 1 TiB per region by default; 10 TiB in `eu-south1` | [Object Storage quotas](https://docs.nebius.com/object-storage/resources/quotas-limits) |
| Local SSD disks | `uk-south1`, `eu-west2`, `us-north1`, only `gpu-b300-sxm` `8gpu-192vcpu-2768gb` | [Local disks](https://docs.nebius.com/compute/storage/local-disks#availability) |

Consequence for R8: the data stack defaults `dataset_storage_class = null`, the region's first offered
class: `STANDARD`, or `ENHANCED_THROUGHPUT` where Standard is not offered, which covers every B300 region
(`terraform/stacks/data/variables.tf:55-58`). Set the class explicitly to choose another.

## Data residency notes

| Topic | What the docs say | Source |
|---|---|---|
| Where resources live | Each resource is hosted in a region, "the geographical location of the underlying physical infrastructure" | [Regions](https://docs.nebius.com/overview/regions) |
| Cross-region access to secrets | A SecretStash secret is in a project; accounts of different regions cannot access it | [SecretStash](https://docs.nebius.com/mysterybox/overview) |
| Shared filesystem scope | Attachable only to VMs in the same project; no cross-project sharing even in one region | [Storage types](https://docs.nebius.com/compute/storage/types#shared-filesystems) |
| Object Storage egress | Egress to the internet or another region is charged per class; same-region egress free | [Object Storage pricing](https://docs.nebius.com/object-storage/resources/pricing#egress-traffic) |
| Token Factory public endpoints | Region shows "Global"; processing location can change at any time without notice | [Public serverless](https://docs.tokenfactory.nebius.com/public-serverless) |
| Token Factory dedicated endpoints | Deployment region is fixed and user-selected | [Dedicated endpoints](https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/overview) |
| Deleted data | Disks and filesystems: deleted immediately; objects: physically deleted within 4 days; suspended tenant: deleted after 60 days | [Data deletion](https://docs.nebius.com/overview/data-deletion) |
| Compliance attestations | SOC 2 Type II (with HIPAA), SOC 3, ISO 27001/27018/27701/22301/42001 and others; GDPR, NIS 2, DORA described as alignment | [Trust center](https://nebius.com/trust-center); per-region scope not stated |

Docs silent: per-region scope of each certification, sovereign or in-country support staffing,
and whether control-plane metadata (IAM, billing) stays in the resource region. Ask Nebius.
