# Building blocks

What the recipes are made of, and the documented Nebius building blocks they deliberately leave out.
Recipe IDs (R1–R16) are listed in the [README](../README.md#recipes).

## Terraform modules and the roots that compose them

A module has one owning layer ([architecture](architecture.md#layers)). Stacks compose modules; live
roots (`terraform/live/<stage>/<stack>`) call one stack with a stage's sizing. R7, R8, R9, R10, R12 and R15
declare their resources directly in the stack rather than through a module, because nothing else reuses them.

| Module | Builds | Layer | R1 inference | R3 training | R7 network | R8 data | R10 gpu-vm | R12 ml-services | R2/R13 foundation | Mirrors |
|---|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|
| [`stage-policy`](../terraform/modules/stage-policy/) | resolves `platform/stages.yaml` for a stage and returns violations; each stack asserts none (also R15 `nvl`) | policy | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | (this repo) |
| [`network`](../terraform/modules/network/) | looks up the project's subnet by ID or name; creates nothing | 1 | ✓ | ✓ | | | | ✓ | | `k8s-training` subnet lookup |
| [`mk8s-cluster`](../terraform/modules/mk8s-cluster/) | Managed Kubernetes control plane, endpoint exposure, etcd size | 1 | ✓ | ✓ | | | | | | `k8s-training/main.tf` |
| [`node-group`](../terraform/modules/node-group/) | one CPU or GPU node group: preset, drivers preset, filesystem mount, taints, reservation, preemptible pricing, optional autoscaling | 1 | ✓ ×2 | ✓ ×2 | | | | | | `k8s-training/main.tf` |
| [`gpu-cluster`](../terraform/modules/gpu-cluster/) | InfiniBand GPU cluster on the region's fabric, only when GPU nodes > 0 | 1 | | ✓ | | | | | | `k8s-training/gpu_cluster.tf` |
| [`filestore`](../terraform/modules/filestore/) | shared filesystem, `forbid_deletion` per stage | 1 | ✓ | ✓ | | ✓ | | | | `k8s-training/filesystem.tf` |
| [`filestore-csi`](../terraform/modules/filestore-csi/) | `csi-mounted-fs-path` chart: RWX StorageClass over the mounted filesystem | 2 | ✓ | ✓ | | | | | | [filesystem over CSI](https://docs.nebius.com/kubernetes/storage/filesystem-over-csi) |
| [`device-plugin`](../terraform/modules/device-plugin/) | NVIDIA device plugin + DCGM exporter (Marketplace), for drivers-preset nodes | 2 | ✓ | ✓ | | | | | | `modules/device-plugin` |
| [`network-operator`](../terraform/modules/network-operator/) | NVIDIA Network Operator (Marketplace), opt-in operator path | 2 | | opt-in | | | | | | `modules/network-operator` |
| [`gpu-operator`](../terraform/modules/gpu-operator/) | NVIDIA GPU Operator (Marketplace), after `state-OFED`; MIG/CDI | 2 | | opt-in | | | | | | `modules/gpu-operator` |
| [`o11y`](../terraform/modules/o11y/) | Prometheus + Grafana and the Nebius observability agent (Marketplace), alert rules | 4 | ✓ | ✓ | | | | | | `modules/o11y` |
| [`foundation/state-bucket`](../terraform/modules/foundation/state-bucket/) | versioned state bucket, non-current retention, `prevent_destroy` | 1 | | | | | | | ✓ | `environment.sh` |
| [`foundation/state-identity`](../terraform/modules/foundation/state-identity/) | project group + service account with `storage.object-editor` (or, for the plan job, `storage.object-viewer`) on the state bucket only | 1 | | | | | | | ✓ | `environment.sh`, narrowed ([R2-1](upstream-findings.md#r2-terraform-lifecycle)) |
| [`foundation/ci-service-account`](../terraform/modules/foundation/ci-service-account/) | CI service account per stage and job: `editor` (apply) or `viewer` (plan) on the stage project; keys registered with the CLI ([credentials](credentials.md#ci-service-account-keys)) | 1 | | | | | | | ✓ | (this repo) |
| [`foundation/ci-federation`](../terraform/modules/foundation/ci-federation/) | R13: GitHub OIDC federated credentials for the CI accounts (no private key) and project-scoped team groups; off by default (`ci_federation`, `team_groups`) | 1 | | | | | | | ✓ | (this repo) |

"Mirrors" paths are in [`nebius-solutions-library`](https://github.com/nebius/nebius-solutions-library) at
the tag pinned in [`platform/versions.yaml`](../platform/versions.yaml). Not in the table:

- **R4** wraps the upstream `soperator/` recipe as-is and uses none of these modules
  ([`stacks/soperator`](../terraform/stacks/soperator/README.md), [ADR-0008](decisions/0008-slurm-scheduler-and-soperator.md)).
- **R5 and R6** have no Terraform: R5 is Kubernetes manifests on an R1 cluster, R6 is CLI scripts.
- **R7 → R1/R3:** the network stack's `subnet_id` and `security_group_ids` outputs feed the existing inputs
  of the inference and training stacks. **R8 → R1/R3:** its filesystem attaches through
  `existing_filesystem_id`, so staged data outlives any one cluster.
- **R9 governance** uses none of these modules: it reads `platform/stages.yaml` directly for the TTL
  label and the project-limit ceiling. Its `pricing_policy_ids[<platform>]` feed R1/R3
  `gpu_spot_pricing_policy_id`; budgets and the periodic FOCUS export are console steps in
  [`recipes/finance`](../recipes/finance/README.md).
- **R10 → R7/R8:** the GPU VM takes R7's `subnet_id` and `security_group_ids` and R8's
  `existing_filesystem_id`. **R12 → R1/R3:** `node_service_account_id` lets node groups pull from the
  stage's Container Registry without pull secrets.
- **R11** (Token Factory) has no Terraform: an OpenAI-compatible client against a hosted API
  ([`recipes/token-factory`](../recipes/token-factory/README.md)).
- **R14** (observability) adds no module: `o11y` above is its in-cluster half (agent, Prometheus,
  Alertmanager in R1/R3); [`recipes/observability`](../recipes/observability/README.md) is the read side
  (read-only clients for Monitoring and Logging, Grafana provisioning, which signal lives where).
- **R15 → R3:** the NVL72 stack ([`stacks/nvl`](../terraform/stacks/nvl/README.md)) declares its
  NVLink instance groups and rack node groups directly (no `node-group` module: an NVLink node group is
  fixed-size, never surges and has no 8-GPU-preset GPU-cluster rule) and joins R3's `cluster_id`;
  `stage-policy` caps it with `max_gpu_nodes.nvl`.
- **R16 → R3/R5:** Kueue queues ([`workloads/kueue`](../workloads/kueue/README.md)) are Kubernetes
  objects on R3's InfiniBand GPU nodes (selected by `nip.nebius.io/infiniband`); no Terraform. R5's
  team namespaces join through a LocalQueue per team.

## Documented building blocks not wired into a recipe

Each is a Nebius capability a customer may ask for. None is built or tested here; the row says where it
would plug in, so it can be added to an existing recipe instead of becoming a new one.

| Building block | What it is | Where it would fit | Docs |
|---|---|---|---|
| GPU slicing (MIG, MPS, time-slicing) | split one GPU between several pods; MIG gives hardware isolation, time-slicing none, MPS the most throughput | R1 for small models; needs the operator path of R3 (`enable_gpu_operator`, `mig_strategy`) ([ADR-0003](decisions/0003-gpu-driver-ownership.md)) | [`gpu_slicing/`](https://github.com/nebius/nebius-solutions-library/tree/main/gpu_slicing) |
| Ray (KubeRay cluster, Ray Serve) | Ray clusters and Ray Serve deployments as Marketplace applications on MK8s | R1 cluster as an alternative serving runtime; a Terraform-owned release like `modules/o11y` ([ADR-0006](decisions/0006-reconciler-ownership.md)) | [`ray-cluster`](https://github.com/nebius/nebius-k8s-applications/tree/main/ray-cluster), [`ray-serve`](https://github.com/nebius/nebius-k8s-applications/tree/main/ray-serve) |
| Reservations and capacity block groups | GPUs reserved on one platform and fabric for dated intervals | already wired: `gpu_reservation` in R1/R3 and STRICT `capacity_reservation_ids` in R15; how to obtain them is [`runbooks/capacity-request.md`](../runbooks/capacity-request.md) | [node-group reservations](https://docs.nebius.com/kubernetes/node-groups/reservations), [capacity block groups](https://docs.nebius.com/overview/limits/capacity-block-groups) |
| SecretStash (formerly MysteryBox) and an external-secrets controller | versioned project secrets; still `mysterybox` in API, CLI and provider; `editor` can create secrets but reading payloads needs `mysterybox.payload-viewer` ([roles](https://docs.nebius.com/iam/authorization/roles#secretstash)) | already wired: optional `grafana_admin_secret_id` (R1/R3 o11y), `transfer_secret_id` (R8), `secret_id` (R12 MLflow and PostgreSQL passwords) and foundation `ci_secret_ids` read payloads at apply so they reach neither plan nor state ([SecretStash](credentials.md#secretstash)); an external-secrets controller for in-cluster Secrets is not built | [SecretStash](https://docs.nebius.com/mysterybox/overview) |
| Key Management Service | symmetric and asymmetric keys for application-level encryption | client-side envelope encryption of R8 objects or checkpoints. Buckets, disks and filesystems cannot use a customer key: Nebius-managed keys only. Network SSD disks and shared filesystems are encrypted by default; Network SSD Non-replicated and IO M3 disks (the Soperator spool) only if encryption is enabled on the disk (`.cache/nebius-docs/security/encryption.md:24`; [encryption](https://docs.nebius.com/security/encryption#key-management)) | [KMS](https://docs.nebius.com/kms), [envelope encryption](https://docs.nebius.com/kms/cryptography/symmetric#how-to-use-envelope-encryption) |
| Token Factory dedicated endpoints | hosted model endpoints on dedicated capacity, no cluster or container to operate | documented, not scripted, in R11 [`recipes/token-factory`](../recipes/token-factory/README.md) (the public endpoints are R11's scripts); the "no cluster at all" end of R6's comparison | [dedicated endpoints](https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/overview) |
| Observability services | Nebius Monitoring, Logging and Tracing; the observability agent ships cluster metrics and logs | wired in R14 ([`recipes/observability`](../recipes/observability/README.md)): R1/R3 install the agent through `modules/o11y`; read clients and Grafana provisioning in the recipe. Console alerts on VM and bucket metrics stay console steps (no API) | [observability](https://docs.nebius.com/observability), [agent](https://docs.nebius.com/observability/agents/nebius-o11y-agent) |
| Budgets | per-project spend notifications; no provider resource, so set in the console | spend control 9 in [cost](cost.md#spend-controls); console steps in R9 [`recipes/finance`](../recipes/finance/README.md#budgets) | [budgets](https://docs.nebius.com/signup-billing/budgets) |
| Audit Logs | control-plane events per service, exportable to Object Storage | complements the MK8s audit logs the stage policy turns on ([security](security.md)) | [Audit Logs](https://docs.nebius.com/audit-logs) |
| VPN Gateway | managed site-to-site VPN | the documented variant of R7; R7 builds the WireGuard bastion instead | [VPN Gateway](https://docs.nebius.com/vpc/nebius-vpn-gateway) |
| Alternative orchestrators (dstack, Run:ai, Kubeflow) | job orchestration above MK8s; R3 already uses the Kubeflow Training Operator for MPIJob/PyTorchJob | R5's team platform (SkyPilot today); queueing and quotas are R16 (Kueue) | [dstack](https://docs.nebius.com/3p-integrations/dstack), [Run:ai](https://docs.nebius.com/3p-integrations/run-ai), [NCCL test (Kubeflow)](https://docs.nebius.com/kubernetes/gpu/nccl-test) |

Out of scope on purpose: managed Spark (deprecated upstream) and an NVIDIA OSMO recipe
([design note](design/2026-10-10-harden-and-align.md)).
