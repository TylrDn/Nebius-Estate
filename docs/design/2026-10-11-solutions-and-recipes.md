# Solutions layer and recipe expansion

Date: 2026-10-11. Status: approved (scope "two layers + all gap recipes").

> **Historical design record (docs audit, 2026-10-11).** This file describes the plan as approved; the
> recipe count (now R1–R16) and the status rows below are not kept current. Current status: the
> [README recipe table](../../README.md#recipes) and [`solutions/README.md`](../../solutions/README.md).
> Since this was written, R11's `smoke.py --yes` ran live once
> ([evidence](../evidence/2026-10-11-token-factory-smoke.md)) and R9's `price.py` ran live on every
> S1–S9 footprint ([evidence](../evidence/2026-10-11-solutions-pricing.md)).

## Why

The cookbook covers eight building blocks (R1–R8). A Solutions Architect works from customer
scenarios, which compose several blocks with sizing, quotas, prices and a delivery plan. Two layers
keep both honest: recipes stay small and testable; solutions say how to combine them for a customer.
One repository keeps one naming standard ([naming](../naming.md)), one stage policy, one set of pins,
one toolbox, one portal and one docs catalog.

## Layers

| Layer | Id | Lives in | Definition of done |
|---|---|---|---|
| Recipe | `R<n>` | `terraform/stacks/<name>` (Terraform) or `recipes/<name>` (scripts/manifests) | README to the stack template; every claim cited to docs.nebius.com (catalog anchors); mocked plan tests or a static check in `make ci`; runbook section; cost shape priced with the live calculator where it applies; quota needs; evidence row ("not yet run" until a live run) |
| Solution | `S<n>` | `solutions/S<n>-<slug>/README.md` | customer problem; first-call questions; architecture (recipes composed, with diagram); sizing worked example; quota checklist; cost model (on-demand / preemptible / reserved, from the calculator and capacity advisor, dated, "not a quote"); risks and mitigations; delivery steps linking runbooks; portal demo path; what is proven vs not |

Nothing is shipped as a draft: an item is either done to its definition or listed in the backlog
table of this document with its blocking reason.

## New recipes

| Id | Recipe | Shape | Primary docs |
|---|---|---|---|
| R9 | Finance and governance | budgets, FOCUS periodic export, cost allocation labels, pricing policies (spot cap), project limits, commitments — `recipes/finance` + portal | signup-billing/*, overview/limits/* |
| R10 | GPU VM quickstart | one GPU VM serving a model, containers on VMs — `terraform/stacks/gpu-vm` | compute/quickstart-host-model, compute/virtual-machines/containers |
| R11 | Token Factory | hosted models and dedicated endpoints, client configuration — `recipes/token-factory` | docs.tokenfactory.nebius.com, serverless/* |
| R12 | ML platform services | Managed MLflow, Managed PostgreSQL, Container Registry with node-group service-account pulls — `terraform/stacks/ml-services` | mlflow/*, postgresql/*, container-registry/*, kubernetes/workloads/images-container-registry |
| R13 | Identity and CI federation | custom groups, least-privilege service accounts, workload identity federation for CI without static keys — `terraform/modules/foundation/ci-federation`, wired into `terraform/live/foundation` (a module, not a stack: the federated credentials must sit in the admin-applied root beside the CI accounts they bind; module README) | iam/*, iam/wif/* |
| R14 | Observability | Nebius Monitoring, Logging, traces, alerts, Grafana — `recipes/observability` (+ `modules/o11y`) | observability/*, compute/monitoring/* |
| R15 | Rack-scale NVL72 | GB300 NVL72 through NVL instance groups — `terraform/stacks/nvl` (mocked only until capacity is approved) | compute/* (nvl instance groups), terraform-provider reference |
| R16 | Team scheduling | Kueue with topology-aware placement on GPU clusters — `workloads/kueue` | kubernetes/gpu/topology-aware-scheduling, kubernetes/skypilot |

## Solutions

| Id | Scenario | Composes |
|---|---|---|
| S1 | Private LLM serving with VPN to on-prem | R7, R1, R8, R12, R14 |
| S2 | Multi-node fine-tune of a 70B model for two weeks | R3, R8, R9, R14 |
| S3 | LLM API without managing GPUs | R11, R9 |
| S4 | Burst training on preemptible capacity | R3, R8, R9 |
| S5 | Slurm migration | R4, R8, R13 |
| S6 | Multi-region serving and disaster recovery | R1, R8, R7 |
| S7 | EU data residency | R7, R8, R2 |
| S8 | Batch inference | R6, R10, R8 |
| S9 | Notebooks for a data-science team | R5, R12, R16 |

## Waves

1. Structure: `solutions/` template and index, portal Solutions tab, recipe ↔ solution links.
2. Recipes R9–R16, one owner per recipe directory; shared files (README table, CHANGELOG,
   `platform/*`, catalog) edited only by the integrator.
3. Solutions S1–S9, after the recipes they compose exist.
4. Integration: portal registry, docs catalog task index, `make ci`, evidence rows, CHANGELOG.

## Backlog (not done, with reason)

Filled in as waves complete; empty means everything in scope is done. Status 2026-10-11, after the
wave-2 integration of R9–R13 and of R14–R16 and the wave-3 integration of S1–S9:

| Item | State | Blocking reason |
|---|---|---|
| R9, R10, R12, R13 | done to the recipe definition except live evidence (rows read "not yet run") | a live run needs a spend approval (R10, R12) or a tenant admin (R9 project limits, R13) |
| R11 | done; `list-models.sh` run live (read-only); `smoke.py --yes` run live once on 2026-10-11 ([evidence](../evidence/2026-10-11-token-factory-smoke.md)) | — |
| R9 / R12 cost rows | R10 priced with the live calculator; R12 from the pricing pages only | the calculator has not been run for MLflow and PostgreSQL |
| R14 Observability (`recipes/observability`) | **done** to the recipe definition; scripts run live read-only 2026-10-11 ([evidence](../evidence/2026-10-11-observability-read-only.md)); evidence row for Grafana, traces and journald "not yet run" | a live Grafana and a trace need a running cluster with the agent (spend approval); `modules/o11y` unchanged (it already is the in-cluster half) |
| R15 Rack-scale NVL72 (`terraform/stacks/nvl`) | **done** to the recipe definition, mocked plan tests only; `max_gpu_nodes.nvl` 0 in every stage, no live root; evidence row "not yet run" | capacity is not approved: no plan against the real API, no calculator price (GB300 has no list price) |
| R16 Team scheduling (`workloads/kueue`) | **done** to the recipe definition: manifests build, `policy/kueue.rego` in `make policy`; evidence row "not yet run" | a live run needs an R3 cluster with two 8-GPU InfiniBand nodes (spend approval) |
| S1–S9 (`solutions/S<n>-<slug>/`) | **done** to the solution definition ([index](../../solutions/README.md)); every cost model priced with the live calculator and capacity advisor on 2026-10-11 ([evidence](../evidence/2026-10-11-solutions-pricing.md)); live evidence of each solution "not yet run". R14 and R16, which S1, S2 and S9 compose, exist | a live run of any solution needs the spend approvals of the recipes it composes; the variants below are not built |
| S6 multi-region serving and DR | designed; the standby region has no live roots | needs an ADR (multi-region topology, beyond the single-region scope of [`docs/dr.md`](../dr.md)) and second-region live roots: `scripts/render-live-roots.py` renders one region per stage, so a second region needs its own stage name or a region axis (integrator change) |
| S4 burst training on preemptible | designed for sandbox (preemptible GPU nodes are sandbox-only) | option E, preemptible training outside sandbox, needs an ADR amending [ADR-0007](../decisions/0007-capacity-on-demand-vs-preemptible.md) and a stage-policy change |
| S9 notebooks for a data-science team | designed; the SkyPilot path to the shared pool is not wired | R5's SkyPilot config does not yet target the R3 context and R16's Kueue queues (`kueue.x-k8s.io/queue-name`); a change to `recipes/team-platform` |
| S7 EU data residency | designed; residency is enforced by review of `region` only | a conftest rule refusing non-EU regions in every live root is proposed, not built |
| S1 private LLM serving with VPN | designed; R1 and R7 carry no VPN or internal-LB option | a VPN Gateway variant (Professional Services VMs, not built here) and an internal load-balancer annotation option on R1 (`nebius.com/load-balancer-type: internal`); whether a VPN VM in another subnet reaches an internal load balancer is an open question |
| Portal Solutions tab and registry entries for R9–R16 | not done here | `portal/**` is owned separately (waves 1 and 4) |
