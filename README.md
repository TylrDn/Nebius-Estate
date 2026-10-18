# Nebius Estate

> Independent project, not affiliated with or endorsed by Nebius.

An experimental reference cookbook for GPU workloads on **Nebius AI Cloud**: model serving, multi-node training, Slurm,
serverless, team platforms, a private network perimeter, a data plane and cost control. Each recipe is
Terraform (or scripts) plus workload manifests, a validation step, a runbook and a link to the Nebius doc
or upstream repository it follows. Coverage ranges from mocked wiring to historical sandbox measurements;
this is not a production platform or a claim that every recipe has been deployed. CI checks do not
provision cloud resources, and the deploy pipeline ships disabled.

[v0.1.0 experimental source](docs/releases/v0.1.0.md) includes the verification scope,
known advisory risks and maintenance responsibilities.

**Start here**

1. [Three flagship paths](docs/portfolio.md): synthetic portal demo, measured R1 inference, and R2 foundation lifecycle.
2. [Architecture](docs/architecture.md): ownership, stage × stack boundaries, and the inference request path.
3. [What is proven](#what-is-proven): dated results, measurement limits, and mocked coverage.
4. [Recipes](#recipes) and [solutions](solutions/README.md): explore the wider reference collection.
5. [Run the checks](#run-the-checks): no cloud credentials needed.

The local contribution is the integration around the recipes: stage and ownership policy, guarded
lifecycle tooling, acceptance/benchmark methods, evidence records, and the Nebius Estate plugins.
Nebius examples and the Backstage scaffold remain upstream contributions; adapted source, refs,
modifications and retained licenses are recorded in [source provenance](docs/source-provenance.md).

With **Node.js 24.22.0 and Yarn** available (`portal/.nvmrc`; `corepack enable`), run these commands from the repository root:

```bash
make portal-install  # downloads locked dependencies; no cloud access
make doctor          # checks prerequisites and available local ports
make portal-demo     # serves the synthetic estate at http://localhost:3100
```

Open `http://localhost:3100`, then expand **Explore this demo** below the running metrics or follow the
[five-step walkthrough](docs/portfolio.md#five-step-demo-tour). Ctrl-C stops the services. The demo
discards operator credentials and private configuration; see [portal setup](portal/README.md) for prerequisites.
For your first billable sandbox run, start with the
[serving-only path](runbooks/deploy.md#first-serving-only-sandbox) and its stated limitations.
The portal has [three disclosed dependency advisories](docs/dependency-security.md) and incomplete
served authentication. Use the local synthetic demo to evaluate it; shared deployment needs further work.
Before redistribution, review [source provenance](docs/source-provenance.md) and the
[release checklist](docs/release-readiness.md); publishing source does not clear built images.

## Recipes

| ID | Problem it solves | Path | Mirrors upstream |
|---|---|---|---|
| **R1** | Serve a model on GPUs you control (vLLM, private networking, own observability) | [`terraform/stacks/inference`](terraform/stacks/inference/README.md) + [`workloads/inference`](workloads/inference/README.md) | [MK8s GPU set-up](https://docs.nebius.com/kubernetes/gpu/set-up); [`vllm` application](https://github.com/nebius/nebius-k8s-applications/tree/main/vllm) |
| **R2** | Foundation & lifecycle: per-stage projects, state buckets, CI identities, plan → review → apply | [`terraform/`](terraform/README.md) (`live/foundation`, `modules/stage-policy`) | [Terraform state in Object Storage](https://docs.nebius.com/terraform-provider/store-terraform-state); `k8s-training/environment.sh` |
| **R3** | Train across nodes on InfiniBand (PyTorch DDP, NCCL MPIJob) | [`terraform/stacks/training`](terraform/stacks/training/README.md) + [`workloads/training`](workloads/training/README.md) | [`k8s-training`](https://github.com/nebius/nebius-solutions-library/tree/main/k8s-training); [NCCL test](https://docs.nebius.com/kubernetes/gpu/nccl-test) |
| **R4** | Give researchers Slurm (`sbatch`, partitions) on managed Kubernetes (Soperator) | [`terraform/stacks/soperator`](terraform/stacks/soperator/README.md) | [`soperator/`](https://github.com/nebius/nebius-solutions-library/tree/soperator-v4.1.13-2/soperator) @ `soperator-v4.1.13-2` |
| **R5** | Share one GPU cluster across teams with quotas and SkyPilot | [`recipes/team-platform`](recipes/team-platform/README.md) | [`nebius-physical-ai`](https://github.com/nebius/nebius-physical-ai); [SkyPilot on MK8s](https://docs.nebius.com/kubernetes/skypilot) |
| **R6** | Serve or batch with no cluster to run, measured against R1 | [`recipes/serverless`](recipes/serverless/README.md) | [`serverless-ai-cookbook`](https://github.com/nebius/serverless-ai-cookbook); [Serverless AI](https://docs.nebius.com/serverless/overview) |
| **R7** | Private network perimeter: no public IPs on nodes, NAT egress, WireGuard bastion | [`terraform/stacks/network`](terraform/stacks/network/README.md) | [Custom NAT gateway](https://docs.nebius.com/vpc/routing/custom-nat-gateway); [`wireguard/`](https://github.com/nebius/nebius-solutions-library/tree/main/wireguard), [`bastion/`](https://github.com/nebius/nebius-solutions-library/tree/main/bastion) |
| **R8** | Dataset and checkpoint data plane: buckets, shared filesystem, transfer, copy job | [`terraform/stacks/data`](terraform/stacks/data/README.md) + [`workloads/data/copy-job`](workloads/data/copy-job/) | [Object Storage transfers](https://docs.nebius.com/object-storage/transfer/overview); [`data-transfer/`](https://github.com/nebius/nebius-solutions-library/tree/main/data-transfer) |
| **R9** | Price a stage before it is applied, cap preemptible spend, keep stages off each other's reserved GPUs, attribute every billed hour (budgets, FOCUS export, labels) | [`recipes/finance`](recipes/finance/README.md) + [`terraform/stacks/governance`](terraform/stacks/governance/README.md) | [Budgets](https://docs.nebius.com/signup-billing/budgets); [pricing policies](https://docs.nebius.com/signup-billing/manage-pricing-policy); [project limits](https://docs.nebius.com/overview/limits/project-limits) |
| **R10** | Serve a model on one GPU VM, no Kubernetes: the shortest path to an OpenAI-compatible API (sandbox and staging) | [`terraform/stacks/gpu-vm`](terraform/stacks/gpu-vm/README.md) | [Host a model on a VM](https://docs.nebius.com/compute/quickstart-host-model); [container VMs](https://docs.nebius.com/compute/virtual-machines/containers) |
| **R11** | Call hosted open models through an OpenAI-compatible API, no GPUs to run; dedicated endpoints for fixed region and capacity | [`recipes/token-factory`](recipes/token-factory/README.md) | [Token Factory quickstart](https://docs.tokenfactory.nebius.com/quickstart) |
| **R12** | Registry, experiment tracking and a database next to the clusters: nodes pull images without pull secrets; Managed MLflow and PostgreSQL in the stage network | [`terraform/stacks/ml-services`](terraform/stacks/ml-services/README.md) | [images in MK8s](https://docs.nebius.com/kubernetes/workloads/images-container-registry); [MLflow](https://docs.nebius.com/mlflow/quickstart); [PostgreSQL](https://docs.nebius.com/postgresql/quickstart) |
| **R13** | CI acts as the stage service accounts without a static key (GitHub OIDC federation); least-privilege, project-scoped team groups | [`terraform/modules/foundation/ci-federation`](terraform/modules/foundation/ci-federation/README.md) (foundation `ci_federation`, off by default) | [workload identity federation](https://docs.nebius.com/iam/wif); [custom groups](https://docs.nebius.com/iam/authorization/groups#custom-groups) |
| **R14** | Know which signal lives where (metrics, logs, traces, alerts) and read it with a read-only identity; Grafana on every Nebius signal without a secret in git | [`recipes/observability`](recipes/observability/README.md) (+ [`terraform/modules/o11y`](terraform/modules/o11y/main.tf) in R1/R3) | [Observability](https://docs.nebius.com/observability); [Grafana data source](https://docs.nebius.com/observability/metrics/grafana#how-to-connect-grafana-data-source); [logs CLI](https://docs.nebius.com/observability/logs/nebius-cli) |
| **R15** | Rack-scale GB300 NVL72: 72 GPUs in one NVLink domain per rack, as NVLink instance groups joined by fixed MK8s node groups on a reservation | [`terraform/stacks/nvl`](terraform/stacks/nvl/README.md) | [`nvl_instance_group`](https://docs.nebius.com/terraform-provider/reference/resources/compute_v1_nvl_instance_group); [`k8s-training/gb300.tf`](https://github.com/nebius/nebius-solutions-library/blob/main/k8s-training/gb300.tf) |
| **R16** | Teams share one InfiniBand GPU cluster through queues with guaranteed, borrowable GPU shares; multi-node jobs land in one GPU cluster (Kueue topology-aware scheduling) | [`workloads/kueue`](workloads/kueue/README.md) | [topology-aware scheduling](https://docs.nebius.com/kubernetes/gpu/topology-aware-scheduling#how-to-enable-topology-aware-scheduling); [Kueue TAS](https://kueue.sigs.k8s.io/docs/concepts/topology_aware_scheduling/) |

How far each recipe is proven: [What is proven](#what-is-proven). A mocked test (`terraform test` with
mocked providers) proves wiring and policy, not that Nebius accepts the request. The upstream solutions library is
[`nebius/nebius-solutions-library`](https://github.com/nebius/nebius-solutions-library), pinned by tag and
sha in [`platform/versions.yaml`](platform/versions.yaml). For hand-offs, the problem-first entry point is
[`docs/solutions/`](docs/solutions/README.md); the Nebius services the recipes build on, and the documented
ones they leave out, are in the [primer](docs/nebius-primer.md) and [building blocks](docs/building-blocks.md).

## What is proven

As of 2026-10-13: R1 (vLLM serving) and R11 (Token Factory) are measured against a pass bar; R2, R8, R9, R10,
R12, R13 and R14 have run live in a sandbox, with every stack torn down afterwards; R3, R4 and R7 are planned
against the real API; the rest are tested offline or with mocked providers.

One row per recipe. The level comes only from files in [`docs/evidence/`](docs/evidence/README.md); the next live
run is from the [live-run plan](docs/plans/2026-10-12-live-runs.md) (2026-10-12; its runs 1 and 2 ran that day; prices there are
estimates, not quotes).

| Level | Means |
|---|---|
| **Measured** | a figure judged against a pass bar, with its method, versions and evidence file. R11 and R1 so far |
| **Live run** | this repository's root or script ran on Nebius (an apply, or a paid request) and the result was read back |
| **Live read / plan** | ran against the real API without creating anything: read-only calls or `make plan` |
| **Offline-ready** | the acceptance or bench harness for the next live run exists and passes its fixture or stub tests in `make ci`; no live result |
| **Mocked only** | mocked `terraform test`, builds and policy checks |

A recipe also listed with a harness is offline-ready for its next step. Prior runs of the *upstream*
recipes (2026-10-08, `uk-south1`) back the R1, R3 and R4 patterns; they are not runs of this repository.

| ID | Level | What the evidence shows, and what it does not | Evidence | Next live run |
|---|---|---|---|---|
| **R1** | Measured | **measured 2026-10-13** (retry, `R14=0`): vLLM serving Qwen2.5-1.5B on 1 preemptible L40S, 200/200 answered at 1, 8 and 32 concurrent, E2E p99 0.85, 1.15 and 1.47 s (pass, bar 10 s), 153, 1,145 and 3,696 output tok/s, $1.36, $0.18 and $0.056 per 1M output tokens (list, full utilisation). Operator-host vantage through a port-forward (latency includes the tunnel); the in-cluster bench was blocked by the load generator's egress to Hugging Face ([R1-21](docs/upstream-findings.md#2026-10-13-findings-from-this-repositorys-own-runs)), so no in-cluster figure. Same retry: apply 8 min, 01-gpu L40S 46,068 MiB on driver 580.173.02, NCCL plumbing pass, filestore fio 2,228 / 2,423 MiB/s. Earlier in the day the apply stuck on the Alertmanager PVC ([R1-20](docs/upstream-findings.md#2026-10-13-findings-from-this-repositorys-own-runs)). Eight applies in all, each torn down; one model, one GPU, no multi-GPU | [R1 session](docs/evidence/2026-10-13-sandbox-r1-session.md), [validate](docs/evidence/2026-10-12-sandbox-inference-validate.md), [serving](docs/evidence/2026-10-11-sandbox-inference-serving.md), [populate](docs/evidence/2026-10-11-sandbox-inference-populate.md), [teardown](docs/evidence/2026-10-11-sandbox-inference-teardown-verify.md), [connectors](docs/evidence/2026-10-11-sandbox-inference-portal-connectors.md); prior [B300 smoke](docs/evidence/2026-10-08-mk8s-b300-gpu-smoke.md) | in-cluster sweep once R1-21 is fixed; a larger model (`04-workload.sh`, `05-load.sh`, `PROFILE=l40s-gpu-only`) |
| **R2** | Live run | the foundation applied for sandbox (IAM only); every apply of a stack used the bootstrap → plan → apply → `make destroy-plan` → destroy → `scripts/leftovers.sh` lifecycle. 2026-10-12: preflight judged each plan's own quota demand (GO after a tenant-wide NO-GO was fixed), TTL jobs armed before three real applies, a teardown that stopped safely before a destroy it knew would fail and finished clean on rerun, stage gate clean. No TTL job has fired; staging, prod and a pipeline apply not run | [session](docs/evidence/2026-10-12-sandbox-session-lifecycle.md), [foundation](docs/evidence/2026-10-11-foundation-ci-federation-live.md), [teardown](docs/evidence/2026-10-11-sandbox-inference-teardown-verify.md) | Z2 key expiry; a TTL job left to fire on a sandbox root |
| **R3** | Live read / plan | `make plan` against the real API (12 to add, no GPU nodes); the apply is blocked by the non-GPU vCPU quota of 0. Harness: DDP samples/s, per-platform NCCL bars. Multi-node InfiniBand not measured | [live plans](docs/evidence/2026-10-11-sandbox-live-plans.md); prior [B300 smoke](docs/evidence/2026-10-08-mk8s-b300-gpu-smoke.md) (single-GPU NCCL init) | blocked: vCPU quota |
| **R4** | Live read / plan | plan of 44 to add after two plan-path fixes; not applied (vCPU quota). Prior upstream run: `sbatch` end to end on Soperator 4.1.13 with a CPU worker | [live plans](docs/evidence/2026-10-11-sandbox-live-plans.md); prior [Soperator](docs/evidence/2026-10-08-soperator-4.1.13-cpu.md) | blocked: vCPU quota; Soperator re-pin check (Z3, weekly): a tag without both deprecated data sources means re-pin and drop `patches/0001` |
| **R5** | Mocked only | manifests build in CI | — | run 2, step 7: the first run (team namespace, SkyPilot task on the L40S); on 2026-10-12 it stopped on its precondition (it scales the vLLM Deployment, which was not deployed) |
| **R6** | Offline-ready | scripts checked in CI; in-region measurement (`MEASURE_FROM=cluster`) and the like-for-like label of `compare.py` tested on stubs. A prior serverless bench attempt left no figure that may be quoted | [costs](docs/evidence/costs.md) | run 2, step 8 (optional; the endpoint price is unknown) |
| **R7** | Live read / plan | plans against the real API (18 to add); its NAT VM is blocked at apply by the vCPU quota | [live plans](docs/evidence/2026-10-11-sandbox-live-plans.md) | blocked: vCPU quota |
| **R8** | Live run | two applies (two buckets and a 256 GiB filesystem), each torn down. 2026-10-12: the filesystem from one L40S node, 4 fio jobs, 2,066 MiB/s write and 1,757 MiB/s read, above the 450 MiB/s floor in one short run (a baseline, not a planning figure). Restore drill not run (a run-harness defect); no transfer | [acceptance](docs/evidence/2026-10-12-sandbox-data-acceptance.md), [data](docs/evidence/2026-10-11-sandbox-data-live-recipe.md) | restore drill (`checkpoint-restore.sh`), a sustained fio run |
| **R9** | Live run | one H100 spot price cap applied, read back and destroyed (L40S takes none); `price.py --contract --advice` on every S1–S9 footprint (list and spot, no contract rate; an estimate, not a quote); re-priced on 2026-10-12 before run 2 (preemptible L40S $0.7492/h). Monthly close not run | [governance](docs/evidence/2026-10-11-sandbox-governance-live.md), [pricing](docs/evidence/2026-10-11-solutions-pricing.md), [session](docs/evidence/2026-10-12-sandbox-session-lifecycle.md) | monthly close against the FOCUS export |
| **R10** | Live run | 1 preemptible L40S VM; vLLM answered 401 without the key 8 min after the apply; torn down after 17 min. No completion with the key. Harness: `tests/load/bench.sh --target r10` | [GPU VM](docs/evidence/2026-10-11-sandbox-gpu-vm-live-recipe.md) | run 3: first completion with the key, then the sweep (on 2026-10-13 its plan failed in an R1-only session: no `subnet_id`) |
| **R11** | Measured | concurrency sweep on 2026-10-12, `Qwen/Qwen3-30B-A3B-Instruct-2507` from the operator host: 600/600 answered; E2E p99 3.9 s at 8 and 4.4 s at 32 concurrent (pass, bar 10 s) but 14.1 s at 1 (fail); 463 and 1,195 output tok/s; $0.30 per 1M output (list). One vantage, one model; plus the model listing and one smoke request (2026-10-11) | [bench](docs/evidence/2026-10-12-token-factory-bench.md), [smoke](docs/evidence/2026-10-11-token-factory-smoke.md) | the sweep from inside a Nebius region; the c=1 tail |
| **R12** | Live run | two applies, each torn down. 2026-10-12, with the node identity: one-pass (the second plan printed No changes), registry push and pull by IAM, a node pulled the image with no pull secret, PostgreSQL 16 `select 1` over `verify-full`; the MLflow client check failed (cause unknown). Registry image ids are at `.id` ([R12-1](docs/upstream-findings.md#2026-10-12-findings-from-this-repositorys-own-runs)) | [acceptance](docs/evidence/2026-10-12-sandbox-ml-services-acceptance.md), [ML services](docs/evidence/2026-10-11-sandbox-ml-services-live-recipe.md) | the MLflow client check |
| **R13** | Live run | the foundation's sandbox federation applied (GitHub's immutable subject); the first federated CI plan green once the token asked for audience `sts.nebius.com`, the only one of seven audiences tried that STS accepted ([R13-3](docs/upstream-findings.md#2026-10-11-findings-from-this-repositorys-own-runs)). Apply side not run; CI keys not retired | [federation](docs/evidence/2026-10-11-foundation-ci-federation-live.md), [federated plan](docs/evidence/2026-10-11-sandbox-ci-federated-plan.md) | Z5: the apply environment exists (2026-10-12); dispatch the federated apply, then retire the keys |
| **R14** | Live run | metric names and log labels read with a read-only identity (2026-10-11). 2026-10-12, `acceptance.sh` on the R1 cluster: Grafana and Alertmanager answer and a test alert routes (to the sandbox `null` receiver), but no Nebius data source was provisioned into Grafana; the rules check read the Grafana service, so whether the rules load is unknown. Traces, journald and alert delivery not run. 2026-10-13: Alertmanager's PVC took the filestore default class and never bound, holding the R1 apply ([R1-20](docs/upstream-findings.md#2026-10-13-findings-from-this-repositorys-own-runs)); R1 sessions run with `R14=0` until it is fixed | [R1 session](docs/evidence/2026-10-13-sandbox-r1-session.md), [acceptance](docs/evidence/2026-10-12-sandbox-inference-o11y-acceptance.md), [observability](docs/evidence/2026-10-11-observability-read-only.md) | R1-20 fixed (Alertmanager on `compute-csi-default-sc`, release timeouts), then data sources provisioned, the rules read from Prometheus, a real receiver |
| **R15** | Mocked only | no stage may plan a rack (`max_gpu_nodes.nvl` 0) | — | blocked: GB300 reservation |
| **R16** | Offline-ready | manifests build and pass `policy/kueue.rego`; `tests/validate/kueue.sh` (admission, borrow, reclaim) tested on stub Kueue objects | — | blocked: vCPU quota (runs on R3's InfiniBand nodes) |

## Solutions

Customer scenarios that compose the recipes: sizing, quota checklist, a cost model priced with the live
billing calculator on 2026-10-11 (an estimate, not a quote), risks, delivery steps, a portal demo path and
what is proven vs not. None has been deployed as a whole. Index, headline estimates and status:
[`solutions/`](solutions/README.md).

| ID | Scenario | Recipes composed | Path |
|---|---|---|---|
| **S1** | Private LLM serving with VPN to on-prem | R7, R8, R12, R1, R14, R9 (budget) | [`solutions/S1-private-llm-serving-vpn`](solutions/S1-private-llm-serving-vpn/README.md) |
| **S2** | Multi-node fine-tune of a 70B model for two weeks | R3, R8, R9, R14 | [`solutions/S2-fine-tune-70b-two-weeks`](solutions/S2-fine-tune-70b-two-weeks/README.md) |
| **S3** | LLM API without managing GPUs | R11, R9; R10 (alt.) | [`solutions/S3-llm-api-token-factory`](solutions/S3-llm-api-token-factory/README.md) |
| **S4** | Burst training on preemptible capacity | R3, R8, R9 | [`solutions/S4-burst-training-preemptible`](solutions/S4-burst-training-preemptible/README.md) |
| **S5** | Slurm migration | R4, R8, R13 | [`solutions/S5-slurm-migration`](solutions/S5-slurm-migration/README.md) |
| **S6** | Multi-region serving and disaster recovery | R7, R8, R1, R14 | [`solutions/S6-multi-region-dr`](solutions/S6-multi-region-dr/README.md) |
| **S7** | EU data residency | R7, R8, R2 | [`solutions/S7-eu-data-residency`](solutions/S7-eu-data-residency/README.md) |
| **S8** | Batch inference | R8, R6 or R10, R9 (budget); R11 (alt.) | [`solutions/S8-batch-inference`](solutions/S8-batch-inference/README.md) |
| **S9** | Notebooks for a data-science team | R12, R8, R3, R16, R5, R14 | [`solutions/S9-data-science-notebooks`](solutions/S9-data-science-notebooks/README.md) |

Recipes are listed from each solution's "Composes" row and delivery steps; "(alt.)" marks an alternative
path the solution compares against. Every recipe README's "Used by" line matches this table.

## Repository map

```
terraform/   modules/ (building blocks) · stacks/ (one root per recipe) · live/<stage>/<stack> + foundation
solutions/   S1–S9: customer scenarios composed from the recipes, each with footprint*.json for price.py
recipes/     team-platform (R5) · serverless (R6) · finance (R9) · token-factory (R11) · observability (R14): recipes that are not Terraform stacks
workloads/   Kubernetes manifests: inference (vLLM) · training (NCCL, DDP) · data (copy job) · kueue (R16 team queues)
platform/    stages.yaml (policy) · regions.yaml · versions.yaml (every pin) · alerts/
policy/      conftest rules over stage policy, sizing files and the R16 Kueue manifests
tests/       validate/ (bottom-up checks → results/) · load/ (benchmark method)
runbooks/    operator procedures, one per lifecycle step; start at runbooks/README.md
scripts/     state bootstrap, kubeconfig, guarded apply, residue report, generators and pin/docs checks
tools/       toolbox/: the pinned tool image every check runs in
portal/      Nebius Estate: Backstage portal over this repository and a Nebius estate
docs/        primer · architecture · building blocks · decisions/ · evidence/ · solutions/ · reference/
             (docs.nebius.com catalog) · cost · capacity · security · credentials
```

## Deploy

One sequence, from prerequisites to teardown: [`runbooks/deploy.md`](runbooks/deploy.md). Every
apply needs quota in the target project, a written spend approval and a run TTL
([cost](docs/cost.md), [capacity](docs/capacity.md)). A sandbox run is a committed **run profile**
(`platform/profiles/<stack>/<name>.json`, `PROFILE=<name>`) that renders the shape and its TTL labels;
`make preflight` checks key expiry, quotas, capacity, region and platform, spot caps, stage caps and the
TTL and prints `GO` before `make plan`; `make ttl-teardown` arms the safety-net teardown at the TTL
([deploy](runbooks/deploy.md#preflight)). Which runbook for which moment:
[`runbooks/README.md`](runbooks/README.md). How a change reaches prod: [change management](docs/change-management.md).
Every credential and identifier, and where it is kept: [`docs/credentials.md`](docs/credentials.md)
(`cp .env.example .env`, then `make env-status`).

## Run the checks

No credentials needed. The toolbox image carries every tool at the version in `platform/versions.yaml`
(linux/amd64; Docker Desktop on Apple silicon runs it under emulation):

```bash
make toolbox && make ci-docker                           # make ci inside the pinned toolbox
make ci-docker TARGETS="ci soperator-check scan links"   # infrastructure, Soperator, scans and links (network required)
make ci                                                  # the same checks with locally installed tools (CONTRIBUTING.md)
```

Portal, browser, demo-script and dependency verification run separately; see the
[verification record and commands](docs/release-readiness.md).

`make ci` covers pins, fmt, the generated-file checks (live roots, compatibility matrix), docs.nebius.com
links and anchors against the committed catalog, every relative Markdown link and `#anchor` (`make md-links`), validate, tflint, mocked tests, conftest, shellcheck, the
NCCL parser self-test, the offline checks of the script recipes (R9 `price.py --dry-run`, R11 smoke
dry run and refusals, R14 dry runs and refusals, R16 Kueue install dry run) and kustomize builds. `make help` lists every target by section.

## Nebius Estate portal

A self-hosted Backstage workspace over this repository and a Nebius estate: inventory and GPU capacity,
policy-aware provisioning previews (a patch and run sheet; nothing is applied), FOCUS cost reporting,
evidence and solutions, and a Nebius documentation page. It is **Read-only to Nebius**: it reads your real projects through a read-only
identity and never applies (it saves only its own budgets, scenarios, rate books and imports).
`make portal-demo` shows synthetic test data at `http://localhost:3100`. For the operator path,
`make portal-install portal-dev` serves `http://localhost:3000`; without credentials its live connectors
show as not configured. Served authentication still requires backend and frontend integration;
see the [identity limitations](docs/portal/security.md#identity).
Start at [`portal/README.md`](portal/README.md); design and operations: [`docs/portal/`](docs/portal/architecture.md).

## Design principles

| | Principle | In practice |
|---|---|---|
| P1 | Layered ownership | every resource has one owning layer and team ([architecture](docs/architecture.md)) |
| P2 | One reconciler per resource | a release is owned by Terraform *or* GitOps, never both ([ADR-0006](docs/decisions/0006-reconciler-ownership.md)) |
| P3 | State is a security boundary | one state per stage × stack, locked, bucket-scoped identity ([ADR-0005](docs/decisions/0005-terraform-state-boundaries.md)) |
| P4 | Validate bottom-up | node → GPU → interconnect → storage → workload ([tests](tests/README.md)) |
| P5 | Change one layer at a time | platform and application rollouts are separate changes ([change management](docs/change-management.md)) |
| P6 | Measure before you claim | a number needs a method, exact versions and an evidence file ([evidence](docs/evidence/README.md)) |
| P7 | Right-size and tear down | GPU counts capped per stage; sandbox runs carry a TTL and end in `make destroy` |

## Further reading

- [`docs/architecture.md`](docs/architecture.md): layers, stage × stack × foundation, request path, ownership.
- [`docs/decisions/`](docs/decisions/README.md): ADRs, what was chosen and what was rejected.
- [`docs/security.md`](docs/security.md) · [`docs/dr.md`](docs/dr.md) · [`docs/slo.md`](docs/slo.md): security checklist, recovery objectives, SLOs.
- [`docs/upstream-findings.md`](docs/upstream-findings.md): where the upstream recipes or docs differ from observed behaviour, and how each case is handled.
- [`docs/compatibility-matrix.md`](docs/compatibility-matrix.md): every pinned version (generated).
- [`docs/naming.md`](docs/naming.md): naming and labelling standard: official ID prefixes, name and label constraints, the `nip-<stage>-<stack>` convention.
- [`docs/walkthrough.md`](docs/walkthrough.md): a 15-minute walkthrough of a recipe for a customer.
- [`docs/rescoping.md`](docs/rescoping.md): per recipe, the inputs to change for a client (workload, scale, region, budget), what each costs and what proves it.
- [Live-run plan](docs/plans/2026-10-12-live-runs.md) and the [overnight hardening brief](docs/plans/2026-10-12-overnight-hardening.md) (2026-10-12): the next approved live runs, and the findings and gates behind v0.3.0.
- [Wave 1 backlog](docs/plans/2026-10-13-wave1-backlog.md) (2026-10-13): every portal item behind v0.4.0, with its commit, root cause and gates.
- [CONTRIBUTING](CONTRIBUTING.md) and [CHANGELOG](CHANGELOG.md). Never commit state, plans, kubeconfigs,
  credentials or real tenant, project or resource IDs.

[Nebius documentation](https://docs.nebius.com/) is the authority for every claim here; where a live run
disagreed with it, the conflict is recorded rather than smoothed over.

## License

Apache License 2.0: see [`LICENSE`](LICENSE). Third-party attributions are in [`NOTICE`](NOTICE).
