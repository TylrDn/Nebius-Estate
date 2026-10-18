# Solutions

Customer scenarios built from the recipes. A recipe (`R<n>`) is one small, testable building block; a
solution (`S<n>`) says how to combine several for one customer, with sizing, quotas, a priced cost
model, risks, delivery steps, a portal demo path and an honest account of what is proven. The layer
and its definition of done are in the [design note](../docs/design/2026-10-11-solutions-and-recipes.md#layers);
the problem-first field guide behind them is [`docs/solutions/`](../docs/solutions/README.md).

Every solution is dated **2026-10-11**. Every price is a live billing-calculator list or spot price
read that day, **an estimate, not a quote**: re-price on the day before using one with a customer.
Nothing here has been deployed as a whole; section 10 of each solution separates what the evidence
shows from what it does not.

## Index

| Id | Scenario | Recipes composed | Worked example | Headline estimate (list, 2026-10-11) | Status |
|---|---|---|---|---|---|
| [S1](S1-private-llm-serving-vpn/README.md) | Private LLM serving with VPN to on-prem | [R7](../terraform/stacks/network/README.md), [R8](../terraform/stacks/data/README.md), [R12](../terraform/stacks/ml-services/README.md), [R1](../terraform/stacks/inference/README.md), [R14](../recipes/observability/README.md), [R9](../recipes/finance/README.md) (budget) | 70B FP8, 2 × H200 1-GPU replicas, VPN Gateway, `eu-north1` | $9,127.34 a month on-demand (+ MLflow ≈ $364) | designed; not deployed; VPN Gateway not built here |
| [S2](S2-fine-tune-70b-two-weeks/README.md) | Multi-node fine-tune of a 70B model for two weeks | [R3](../terraform/stacks/training/README.md), [R8](../terraform/stacks/data/README.md), [R9](../recipes/finance/README.md), [R14](../recipes/observability/README.md) | 2 × 8 H200, 336 h, `eu-north1`; B300 alternative | $29,434.65 per run on-demand; reserved via addendum | designed; multi-node IB never measured |
| [S3](S3-llm-api-token-factory/README.md) | LLM API without managing GPUs | [R11](../recipes/token-factory/README.md), [R9](../recipes/finance/README.md); [R10](../terraform/stacks/gpu-vm/README.md) (alt.) | 300 M in + 60 M out tokens a month | $32.40–$1,800 a month by model; self-host counterpart $4,056.10 | designed; R11 measured 2026-10-12: 600/600 answered, E2E p99 passes at 8 and 32 concurrent, fails at 1 |
| [S4](S4-burst-training-preemptible/README.md) | Burst training on preemptible capacity | [R3](../terraform/stacks/training/README.md), [R8](../terraform/stacks/data/README.md), [R9](../recipes/finance/README.md) | 4 × 8 H100 preemptible, 72 h, sandbox | $1,920.93 per burst at spot vs $10,468.77 on-demand | designed; preemption handling not exercised |
| [S5](S5-slurm-migration/README.md) | Slurm migration | [R4](../terraform/stacks/soperator/README.md), [R8](../terraform/stacks/data/README.md), [R13](../terraform/modules/foundation/ci-federation/README.md) | Soperator 4.1.13, 4 × 8 H200 workers | $127,919.73 a month on-demand; reserved expected | designed; `sbatch` proven on a CPU worker only |
| [S6](S6-multi-region-dr/README.md) | Multi-region serving and disaster recovery | [R7](../terraform/stacks/network/README.md), [R8](../terraform/stacks/data/README.md), [R1](../terraform/stacks/inference/README.md), [R14](../recipes/observability/README.md) | `eu-north1` primary + `eu-west1` warm standby | $8,743.92 + $4,765.58 (pilot light $787.24) a month | designed; needs an ADR and a second-region live root |
| [S7](S7-eu-data-residency/README.md) | EU data residency | [R7](../terraform/stacks/network/README.md), [R8](../terraform/stacks/data/README.md), [R2](../terraform/README.md) | perimeter + data plane + 1 GPU, `eu-north1` / `eu-west2` | perimeter $363.66 a month; with 1 GPU $4,305.66 / $7,298.66 | designed; Nebius-side metadata location open |
| [S8](S8-batch-inference/README.md) | Batch inference | [R8](../terraform/stacks/data/README.md), [R6](../recipes/serverless/README.md) or [R10](../terraform/stacks/gpu-vm/README.md), [R9](../recipes/finance/README.md) (budget); [R11](../recipes/token-factory/README.md) (alt.) | 4 × H100 1-GPU workers, 24 h | $80.40 per run at spot vs $436.56 on-demand | designed; throughput not measured |
| [S9](S9-data-science-notebooks/README.md) | Notebooks for a data-science team | [R12](../terraform/stacks/ml-services/README.md), [R8](../terraform/stacks/data/README.md), [R3](../terraform/stacks/training/README.md), [R16](../workloads/kueue/README.md), [R5](../recipes/team-platform/README.md), [R14](../recipes/observability/README.md) | 6 Devlabs (L40S) + 2 × 8 H100 shared pool | $55,194.74 a month on-demand (pool is 95 %) | designed; R8, R12, R14 run live in sandbox; R3 planned only; R5, R16 not run |

"(alt.)" marks an alternative path the solution compares against; each recipe README's "Used by" line
matches this column.

"Designed" means the solution meets every item of the definition of done on paper: customer problem,
first-call questions, the nine design sections of the project policy ([`AGENTS.md`](../AGENTS.md)),
sizing, quota checklist, cost model, risks, delivery steps, portal demo path and proven vs not.

Proof rows (the Status column above, each README's Status row and its section 10) are checked against
[`docs/evidence/`](../docs/evidence/README.md) in CI
([`solutions.test.ts`](../portal/plugins/nebius-estate-backend/src/repo/solutions.test.ts)): a row that says a recipe
(`R<n>`) was not run while an evidence file records a live run of it, or not measured while it is measured, fails the
build, and the portal's Solutions page shows the same disagreement on the card. Update the row with the evidence file.

## Layout of every solution

| § | Section | Source of truth |
|---|---|---|
| 1 | Customer problem | discovery |
| 2 | First-call questions | [field guide checklist](../docs/solutions/README.md#first-call-checklist) |
| 3 | Design: the nine sections (requirements and assumptions, Mermaid diagram, components, alternatives, security, implementation plan, PoC acceptance, cost assumptions, handoff and rollback) | `.claude/skills/nebius-reference-architecture` |
| 4 | Sizing worked example | [sizing arithmetic](../docs/solutions/compute-and-capacity.md#sizing-arithmetic) |
| 5 | Quota checklist | names below; defaults from [regions](../docs/solutions/regions.md#default-quotas-that-change-the-first-day-plan) |
| 6 | Cost model | `recipes/finance/price.py` against `footprint*.json` beside the README |
| 7 | Risks and mitigations | — |
| 8 | Delivery steps | [runbooks](../runbooks/README.md) |
| 9 | Portal demo path | [Nebius Estate](../portal/README.md) |
| 10 | Proven vs not | [evidence](../docs/evidence/README.md) |

## How the prices were read

```bash
nebius iam get-access-token >/dev/null      # read-only: the calculator prices a would-be create request
for f in solutions/*/footprint*.json; do
  python3 recipes/finance/price.py "$f" --project <a project in the footprint's region> \
    --contract --advice --tenant "$NEBIUS_TENANT_ID"
done
python3 recipes/finance/price.py solutions/S1-private-llm-serving-vpn/footprint.json \
  --project project-e00example --dry-run   # requests only, no calls (what CI can run)
```

- Runs: 2026-10-11 between 09:09:19Z and 09:12:20Z, `POST /billing/v1/calculator/estimate-batch`, one
  project per region (`eu-north1`, `eu-west1`, `eu-west2`), with tenant-level capacity advice
  ([evidence](../docs/evidence/2026-10-11-solutions-pricing.md)).
- `--contract` returned the list price on every line: the pricing account has no commitment, so every
  "reserved" figure is an open question for the account team, never a number from this page.
- Preemptible figures are the spot price at that moment; it can change every 15 minutes
  ([spot pricing](https://docs.nebius.com/signup-billing/pricing-policy)).
- Lines the calculator does not price (Managed MLflow, PostgreSQL, Object Storage, Token Factory) cite
  their pricing page or the live model listing, and say so.
- Footprint files hold no project or resource IDs; the project is passed on the command line.

## Quota names observed live

Read-only `quotas` listing (`nebius quotas quota-allowance list --parent-id <project>`), nine projects in
nine regions, **2026-10-11 ~09:05Z**. The API returns names and usage but omits every limit
([evidence](../docs/evidence/2026-10-11-portal-live-read-only.md#quotas)): read limits in the console
(**Administration → Limits → Quotas**) and treat an omitted limit as 0.

| Area | Names (as the API returns them) | Regions where listed |
|---|---|---|
| GPU per platform | `compute.instance.gpu.h100`, `compute.instance.gpu.l40s` | `eu-north1` |
| | `compute.instance.gpu.h200` | `eu-north1`, `eu-west1`, `us-central1` |
| | `compute.instance.gpu.b300` | `eu-west2`, `uk-south1`, `us-north1` |
| | `compute.instance.gpu.b200` | `us-central1`, `me-west1` |
| | `compute.instance.gpu.rtx6000` | `us-central1`, `uk-south2`, `eu-south1` |
| VMs and CPU | `compute.instance.count`, `compute.instance.preemptible.count`, `compute.instance.non-gpu.vcpu` | all nine |
| InfiniBand | `compute.gpucluster.count` | all nine |
| Disks | `compute.disk.count`, `compute.disk.size.network-ssd`, `compute.disk.size.network-ssd-non-replicated`, `compute.disk.size.network-ssd-io-m3`, `compute.disk.snapshot.count`, `compute.disk.snapshot.size` | all nine (`compute.disk.size.network-hdd` in `eu-north1` only) |
| Filesystems, images | `compute.filesystem.count`, `compute.filesystem.size.network-ssd`, `compute.image.count`, `compute.image.size` | all nine |
| Kubernetes | `mk8s.cluster.count` | all nine |
| Object Storage | `storage.bucket.count`, `storage.bucket.size.enhanced-throughput`, `storage.transfer.count` | all nine |
| | `storage.bucket.size.standard`, `storage.bucket.size.intelligent` | four regions (absent where the class is not offered) |
| Networking | `vpc.network.count`, `vpc.subnet.count`, `vpc.pool.count`, `vpc.allocation.count`, `vpc.ipv4-address.public.count`, `vpc.routetable.count`, `vpc.route.count`, `dns.zone.count` | all nine |
| Managed services | `msp.mlflow.count`, `msp.mlflow.cpu`, `msp.mlflow.ram`, `msp.mlflow.disk.size.network-ssd` | five regions (where MLflow is offered) |
| | `msp.postgres.count`, `msp.postgres.cpu`, `msp.postgres.ram`, `msp.postgres.disk.size.network-ssd` | six regions |
| | `msp.cloudapps.count`, `msp.cloudapps.cpu`, `msp.cloudapps.ram`, `msp.cloudapps.disk.size.network-ssd`, `msp.cloudapps.filesystem.size.network-ssd`, `msp.cloudapps.gpu.<platform>` | six regions |
| Other | `registry.count`, `mysterybox.secret.count`, `kms.symmetrickey.count`, `iam.storageaccesspolicy.count` | all nine |

No separate name for "regular GPU VMs" vs "non-GPU VMs" appeared (the docs list both rows with a
default of 12): `compute.instance.count` is the only VM count, so which docs row it maps to is checked
in the console before a plan that is close to 12 VMs.

## Rules for every solution

- Do not invent quotas, prices, availability or API names; anything unknown is an open question for the
  account team, listed at the end of each solution.
- Every docs.nebius.com link exists in [`docs/reference/nebius-docs.json`](../docs/reference/nebius-docs.json)
  (`make docs-links`); Token Factory is cited at `docs.tokenfactory.nebius.com` as in R11.
- No performance claim without an evidence file in [`docs/evidence/`](../docs/evidence/README.md).
- Names and labels follow [`docs/naming.md`](../docs/naming.md); stage caps live in
  [`platform/stages.yaml`](../platform/stages.yaml).
