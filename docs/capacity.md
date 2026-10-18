# Capacity and quotas

What capacity each stage can get, the quota each stack needs, when a reservation is required,
and how the Kubernetes-version window is kept open. Sources:
[reservations](https://docs.nebius.com/compute/virtual-machines/reservations), [quotas](https://docs.nebius.com/overview/quotas),
[Compute quotas](https://docs.nebius.com/compute/resources/quotas-limits),
[MK8s quotas](https://docs.nebius.com/kubernetes/resources/quotas-limits),
[Kubernetes versions](https://docs.nebius.com/kubernetes/versions) (verified 2026-10-10),
[project limits](https://docs.nebius.com/overview/limits/project-limits) (verified 2026-10-11).
Prices are never written here ([`docs/cost.md`](cost.md)).

## Capacity types

| Type | Mechanism in the stacks | Allowed where | Use it for |
|---|---|---|---|
| On-demand | default node group (`gpu_reservation = null`): the API's default policy is `AUTO`, so the group still uses a matching capacity block group if the tenant has one; only `FORBID` keeps it in the common pool | every stage | serving and training without a commitment |
| Preemptible | `gpu_preemptible = true` (+ `follows_spot_price`, or `gpu_spot_pricing_policy_id`) | stages with `allow_preemptible_serving: true` | sandbox smoke tests; never a run whose numbers are recorded ([ADR-0007](decisions/0007-capacity-on-demand-vs-preemptible.md)) |
| `AUTO` reservation | `gpu_reservation = { policy = "AUTO", reservation_ids = [...] }` | every stage | prod serving: reserved first, on-demand burst |
| `STRICT` reservation | `gpu_reservation = { policy = "STRICT", reservation_ids = [...] }` | every stage; **required** where `require_strict_reservation.<stack>` is true and `gpu_node_count > 0` | prod training (committed capacity) |

`gpu_reservation` maps to the node group's `reservation_policy` (`AUTO`, `STRICT` or `FORBID`;
[add reservations to node groups](https://docs.nebius.com/kubernetes/node-groups/reservations#how-to-add-reservations-to-node-groups)).
Reservations are capacity block groups requested from a Nebius manager, not created in the
console; GPUs taken from them do not count towards GPU quotas. A STRICT group cannot be
preemptible (module precondition). Which stage sets which flag:
[Stage policy](../platform/README.md#stage-policy).

Reserved GPUs come from a tenant's capacity block groups (CBGs), which every project in the
tenant can draw from up to the CBG size. A **project limit** caps one project's share; `0`
disables CBG use for that project
([how project limits work](https://docs.nebius.com/overview/limits/project-limits#how-project-limits-work)).
Set one per stage project so sandbox or staging cannot consume prod's reserved GPUs; lowering a
limit below current use does not stop running nodes, but blocks new allocations and restarts.

## Quotas are the only hard cap

Budgets notify; quotas stop. Each stage is its own project, so its quotas are its ceiling
([`docs/cost.md`](cost.md#spend-controls), control 1). Provider 0.6.67 runs server-side preflight
checks during `terraform plan` (provider attribute `disable_preflight_checks`, default off), but
the docs do not say they cover quotas: treat quotas as unchecked until apply. An apply that
exceeds one fails mid-way, leaving a half-built cluster to pay for and tear down.
Request quota **before** the first apply. GPUs from a reservation do not count towards GPU
quotas, but the vCPU, disk, cluster and GPU-cluster quotas of the same apply still do. Only users in a group with the `admin` role can change quotas (console:
**Administration → Limits → Quotas**); they are per project and per region
([change quotas](https://docs.nebius.com/overview/quotas#change-quotas)).

Quota that stays largely unused can be **reduced automatically** back toward the defaults (never
below them): an email names the quotas and the date, and the reduction is cancelled if usage rises
during the grace period, usually two days
([automatic quota reduction](https://docs.nebius.com/overview/quotas#automatic-quota-reduction)).
Training stages idle at `gpu_node_count = 0` are exactly the case, so re-check quota right before
every apply that adds GPU nodes ([`runbooks/capacity-request.md`](../runbooks/capacity-request.md)).

Defaults that matter (per region; private regions marked):

| Quota | Default | Exceptions |
|---|---|---|
| Managed Kubernetes clusters | 2 per region; a stage running inference + training + Soperator needs 3, so request it first ([MK8s quotas](https://docs.nebius.com/kubernetes/resources/quotas-limits#clusters)) | **0 in `me-west1` and `eu-north2`** |
| Total vCPUs across non-GPU VMs | 200 | **0 in `eu-north1`, `us-central1`** and `eu-north2`: request it before any stack |
| Regular / preemptible GPU VMs | 12 / 8 | 0 in `eu-north2` |
| GPUs for regular VMs without reservations | H100 32, H200 32 (`eu-north1`); B300 32 (`uk-south1`, `eu-west2`, `us-north1`) | B200 0 in `us-central1`, `me-west1`; H200 8 in `eu-west1`, 0 in `us-central1` |
| Network SSD / IO_M3 / shared filesystem capacity | 4 TiB each (`eu-north1`), 5 TiB (most others) | 2 TiB in `eu-west1`; 0 in `eu-north2` |
| GPU clusters | 5 | 0 in `eu-north2` |

## Project allowances vs tenant quotas

Quotas are listed at two levels, per region, by `nebius quotas quota-allowance list --parent-id
<tenant or project ID>` (CLI 0.12.285). What each entry means was verified live on 2026-10-11
([connectors evidence, Quota semantics](evidence/2026-10-11-sandbox-inference-portal-connectors.md)):

| Entry | Reads as | Effect |
|---|---|---|
| Tenant allowance with `spec.limit` | the tenant quota for that region | the ceiling for every project in the tenant |
| Tenant allowance without `spec.limit` | a limit of **0** (proto3 JSON omits zeros) | nothing of that kind can be created in the region (`QuotaFailure … limit "0"`) |
| Project entry without `metadata.id` or status (epoch `created_at`, no limit) | a placeholder, not a cap | the project uses the tenant quota |
| Project entry with `metadata.id` | a real project cap (an absent limit is 0) | the project gets at most this much, and never more than the tenant quota |

A project cap therefore only ever takes something away. Comparing a real cap with the tenant limit of the
same quota and region:

- **Above the tenant limit:** no effect, because the tenant limit always binds.
- **Below it:** the cap limits that project, so check that this is intended.
- **At 0 while the tenant allows more:** nothing of that kind can be created in that project.

`make quota-check` (`scripts/quota-plan.py`, read-only) lists all three cases per region and project. It also
lists the tenant limits of 0 for quotas the stacks below need in their region, with a justification line for
the request. The portal shows the same comparison under GPU & Capacity → Quotas → Allowance check, adds an
Overview row when a cap cuts a project, and raises `ProjectAllowanceBelowTenant`. To align caps, see
[`runbooks/capacity-request.md`](../runbooks/capacity-request.md#project-allowances-below-the-tenant-quota).

**Cautionary example (2026-10-11, eu-west2).** Nebius's console AI assistant was asked about quotas and ran
`nebius quotas quota-allowance create` against project allowances. It created 27 project-level caps,
without warning about either of two problems:

- **Caps above the tenant limit, which had no effect:** for example, `compute.instance.count` 22 against a
  tenant limit of 12.
- **Caps below what the project had inherited, which silently cut its limits:** `vpc.allocation.count` went
  from 1000 to 13, the `kms.*` quotas and `mysterybox.secret.count` from 3000 to 20, and `dns.zone.count`
  from 100 to 20.

Nothing failed at the time; the cuts would only have surfaced as quota errors on a later apply. The owner reset
all 27 to equal the tenant limit, and a read-only `make quota-check` afterwards listed no cap in eu-west2
that differs from it. Treat a project allowance as a deliberate restriction: review any tool's
`quota-allowance create` or `update` before it runs, and run `make quota-check` afterwards
([upstream finding R9-2](upstream-findings.md#2026-10-11-findings-from-this-repositorys-own-runs)).

## Quotas per stack

Arithmetic from the stacks and `terraform/live/<stage>/<stack>/<stage>.auto.tfvars`. CPU nodes
are `cpu-d3 8vcpu-32gb` with 128 GiB boot disks; the Prometheus TSDB volume (`enable_o11y`) is a
25 GiB Network SSD disk created by the CSI driver.

### `stacks/inference`

| Quota | sandbox | staging | prod | Arithmetic |
|---|---|---|---|---|
| non-GPU vCPU | 16 | 16 | 24 | `cpu_node_count` × 8 |
| GPU VMs on the platform (`gpu-h100-sxm` in `eu-north1`) | 1 (preemptible) | 1 | 2 | `gpu_node_count`; preemptible VMs were observed against `compute.instance.preemptible.count` (2026-10-11, usage 1 of 8 while a preemptible L40S ran; not documented) |
| Network SSD | 793 GiB | 793 GiB | 1,433 GiB | CPU × 128 + GPU × 512 (`gpu_boot_disk_size_gib`) + 25 |
| Shared filesystems | 64 GiB | 256 GiB | 1,024 GiB | `filestore_size_gib` |
| Managed Kubernetes clusters | 1 | 1 | 1 | |
| GPU clusters, IO_M3, public IPs | 0 | 0 | 0 | nodes have no public IPs; the control-plane endpoint uses no allocation quota |

The non-GPU vCPU quota defaults to 0 in `eu-north1` and `us-central1`
(`.cache/nebius-docs/compute/resources/quotas-limits.md:41`), so the CPU rows above need a quota request
first. What ran on 2026-10-11 in `eu-north1` was the GPU-only path: `cpu_node_count = 0` (0 non-GPU
vCPU, no CPU node group, the GPU node left untainted) and 1 × `gpu-l40s-a 1gpu-8vcpu-32gb` preemptible,
which drew on `compute.instance.preemptible.count` (observed 2026-10-11: usage 1 of 8 while a
preemptible L40S ran; not documented)
([populate](evidence/2026-10-11-sandbox-inference-populate.md),
[connectors, Quota semantics](evidence/2026-10-11-sandbox-inference-portal-connectors.md)); how to set it:
[`runbooks/deploy.md`](../runbooks/deploy.md).

### `stacks/training`

Every stage plans `gpu_node_count = 0`; the GPU columns are what a 2-node NCCL run adds.

| Quota | sandbox | staging | prod | With 2 × 8-GPU nodes |
|---|---|---|---|---|
| non-GPU vCPU | 16 | 16 | 24 | unchanged |
| GPU VMs (8-GPU preset) | 0 | 0 | 0 | + 2 VMs = 16 GPUs |
| Network SSD | 281 GiB | 281 GiB | 409 GiB | + 2 × 1,023 GiB (`gpu_boot_disk_size_gib`) |
| Shared filesystems | 256 GiB | 1,024 GiB | 4,096 GiB | unchanged |
| Managed Kubernetes clusters | 1 | 1 | 1 | unchanged |
| GPU clusters | 0 | 0 | 0 | **1** (created only when `gpu_node_count > 0`) |

### `stacks/soperator` (lab profile, every stage)

| Quota | Needed | Arithmetic |
|---|---|---|
| non-GPU vCPU | **52** | 3 × 8 system + 4 controller + 16 login + 8 worker |
| Network SSD (boot disks) | **1,280 GiB** | 3 × 128 + 128 + 256 + 512 |
| Network SSD IO_M3 | **~280 GiB** | controller spool PVC (`93 × 3` GiB), created by the CSI driver; with an IO_M3 quota of 0 the apply fails |
| Shared filesystems | **448 GiB** | jail 256 + `/data` 64 + controller spool 128 (prod: jail and `/data` 2,048 GiB each) |
| Managed Kubernetes clusters | 1 | |
| Virtual machines / public IPs | 6 / 1 | the login node's load-balancer IP |
| GPU clusters | **0** | 1 once a GPU nodeset with a fabric is enabled |

### `stacks/network` (R7) and `stacks/data` (R8)

| Quota | network sandbox | network staging / prod | data sandbox / staging / prod |
|---|---|---|---|
| non-GPU vCPU | 4 (NAT VM) | 8 (NAT + bastion) | 0 |
| Virtual machines / public IPs | 1 / 1 | 2 / 2 | 0 / 0 |
| Network SSD | 50 GiB | 100 GiB | 0 |
| Shared filesystems | 0 | 0 | 256 / 512 / 2,048 GiB |
| Object Storage buckets | 0 | 0 | 2 |
| Object Storage size (Enhanced Throughput) | — | — | 1 TiB default per region, 10 TiB in `eu-south1` (`.cache/nebius-docs/object-storage/resources/quotas-limits.md:14`); request more before prod or restricted regions (uk-south1, uk-south2, eu-south1, eu-west2, us-north1 offer only ENHANCED_THROUGHPUT) |

A cluster that attaches the R8 filesystem (`existing_filesystem_id`) does not create its own, so its
`filestore_size_gib` row above no longer applies.

### `stacks/gpu-vm` (R10)

One VM per stage where `max_gpu_nodes.gpu-vm` allows it (sandbox 1, staging 1, prod 0: no prod root).

| Quota | sandbox / staging |
|---|---|
| GPU VMs (regular; preemptible in sandbox only) | 1 (defaults 12 regular, 8 preemptible per region; 0 in `eu-north2`) |
| GPUs of the platform | the preset's count, 1 by default; B200 and RTX PRO 6000 default to 0 in some regions |
| Network SSD | 200 GiB boot disk |
| Public IPs | 0, or 1 with `public_ip` |
| non-GPU vCPU | 0 for the VM itself; R7's NAT VM (its egress) needs 4 |

Defaults and the per-region GPU table: [Compute quotas](https://docs.nebius.com/compute/resources/quotas-limits#gpu-virtual-machines);
details in the [stack README](../terraform/stacks/gpu-vm/README.md#quotas-and-cost).

### `stacks/ml-services` (R12) and `stacks/governance` (R9)

| Quota (per region) | ml-services default (registry + node identity) | with MLflow | with PostgreSQL (sandbox sizing) | governance |
|---|---|---|---|---|
| Container registries | 1 of 10 (0 in `eu-north2`) | — | — | — |
| Managed service clusters | — | 1 of 10 | 1 of 10 | — |
| Managed service vCPU / RAM | — | 8 / 32 GiB of 80 / 320 GiB | 2 / 8 GiB of 80 / 320 GiB per host | — |
| Managed service Network SSD | — | 200 GiB of 1.95 TiB | 96 GiB of 2 TiB | — |
| GPUs, VMs, buckets | 0 (MLflow may create its artifact bucket) | | | 0: pricing policies, project limits and quota reads only |

Sources: [MLflow](https://docs.nebius.com/mlflow/resources/quotas-limits#clusters),
[PostgreSQL](https://docs.nebius.com/postgresql/resources/quotas-limits),
[Container Registry](https://docs.nebius.com/container-registry/resources/quotas-limits). GPUs taken
from a capacity block group do not count towards GPU quotas, so R9's project limits
(`capacity_limits`) are the cap on reserved GPUs per stage
([capacity block groups](https://docs.nebius.com/overview/limits/capacity-block-groups)).

### `recipes/token-factory` (R11)

No Nebius AI Cloud project quota: public endpoints are limited by Token Factory's per-user rate
limits (HTTP 429 when exceeded; https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits),
and dedicated endpoints run on on-demand capacity that Token Factory allocates
(https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/capacity-and-scaling).
Details: [recipe](../recipes/token-factory/README.md#quotas).

### `stacks/nvl` (R15)

No stage may plan a rack today (`max_gpu_nodes.nvl` 0 everywhere). Per GB300 NVL72 rack once a
reservation exists, at the eu-north1 defaults:

| Quota | One rack | Note |
|---|---|---|
| GPUs | 72 (18 × `4gpu-112vcpu-800gb`; preset and rack shape from the upstream `k8s-training/locals.tf`, not in the cached docs, [regions](solutions/regions.md)) | from the reservation: GPUs of a capacity block group do not count towards GPU quotas ([capacity block groups](https://docs.nebius.com/overview/limits/capacity-block-groups)) |
| Regular GPU VMs | **18** of 12 | raise first; only the GPU-count quotas are exempt |
| Network SSD | **18 TiB** of 4 TiB | 18 × 1,024 GiB boot disks (`boot_disk_size_gib`, ≥ 256) |
| Disks | 18 of 32 | two racks need 36 |
| GPU clusters | 0; 1 shared for two or more racks | |
| NVLink instance groups | 1 | no documented quota; confirm with the reservation |

Details: [stack README](../terraform/stacks/nvl/README.md#quotas-and-cost).

### `recipes/observability` (R14) and `workloads/kueue` (R16)

No quota of their own. R14 reads Monitoring, Logging and Tracing (free, in preview); its read
limits are per request (3000 series, 1000 log rows) and a log export uses the logs quotas (3 pending
exports, 1 TiB per region) ([Observability quotas](https://docs.nebius.com/observability/resources/quotas-limits#logs-quotas)).
R16's queues divide the GPUs R3 already runs: the sum of the team shares in each stage overlay stays
at or below `max_gpu_nodes.training` × 8 (checked by `policy/kueue.rego`).

### Checking

```bash
nebius quotas quota-allowance list --parent-id "$NEBIUS_TENANT_ID" --all --format json \
  | jq -r '.items[] | "\(.metadata.name)\t\(.spec.region)\t\(.status.usage // 0)/\(.spec.limit // 0)"'
make quota-check     # project caps vs the tenant quota, and tenant zeros the stacks need (read-only)
```

The command path is the one CLI 0.12.285 has; an older CLI may differ. Read the tenant list for the
limits in force: an omitted tenant limit is 0, while a project entry without a limit is a placeholder
([above](#project-allowances-vs-tenant-quotas)). The console's Quotas page shows the same numbers.
Requesting more: [`runbooks/capacity-request.md`](../runbooks/capacity-request.md).

## When to grow

| Signal | Source | Action |
|---|---|---|
| `GpuCapacityExhausted` for 30 min (info) | `platform/alerts/scheduling-and-storage.yaml` | plan the next step below; not an incident |
| `PodsPendingOnGpu` for 15 min (warning) | same | check quota and the `gpu_node_count` cap first; raise by a reviewed tfvars change |
| p95 latency SLO at risk with the queue growing | `VllmHighE2eLatency`, `VllmRequestsQueueing` | add a replica while under the cap; then a node |
| training jobs wait for nodes | Slurm/Kueue queue, `kubectl get pods -n <job ns>` | request reserved capacity ([`runbooks/capacity-request.md`](../runbooks/capacity-request.md)) |

Raising `max_gpu_nodes` in `platform/stages.yaml` is a policy change (`make policy` refuses
training caps above 32 without this document being revisited).

## Kubernetes-version window

Managed Kubernetes supports 1.34–1.36 for new clusters (1.36 is the default and recommended;
1.30–1.33 are end of life). `k8s_version_offset` in `platform/stages.yaml` sets how far behind the
newest accepted version (`platform/regions.yaml` `kubernetes_versions`) each stage may run, and
`k8s_version_pinned` whether the version must be explicit; the stacks enforce both at plan time.
The weekly drift job (`.github/workflows/version-refresh.yml`) flags a new version;
[`runbooks/upgrade.md`](../runbooks/upgrade.md) walks staging then prod through it. Soperator
narrows the window further (1.32–1.35 at 4.1.13, [`docs/soperator-compatibility.md`](soperator-compatibility.md)).

## Capacity calendar (fill in per tenant)

| Item | Owner | Review cadence |
|---|---|---|
| reservations (ids, term, expiry) | platform | monthly; 30 days before expiry |
| quota per stage project | platform | with every sizing change |
| Kubernetes version per stage | platform | monthly, on the drift issue |
| Soperator release vs. K8s window | platform | every Soperator tag bump |
