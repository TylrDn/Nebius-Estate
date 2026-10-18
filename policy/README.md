# Policy as code (conftest / OPA)

Declarative checks that run in CI without credentials (`make policy`), next to the plan-time
preconditions the stacks enforce. The stacks are the real gate; these rules make the prod
contract reviewable in one place and catch a weakening edit to `platform/stages.yaml` before
any plan runs.

| Package | Input | What it guards |
|---|---|---|
| `stages` | `platform/stages.yaml` | the stage policy itself: prod etcd 3, private endpoint, no preemptible serving, deletion protection, audit logs, Alertmanager, pinned K8s, STRICT training reservations; staging mirrors prod's capacity type; sandbox requires TTL labels; an R15 `nvl` cap only with STRICT reservations and in whole 18-node racks |
| `prod` | `terraform/live/prod/*/prod.auto.tfvars` | prod sizing cannot flip a protection flag off (filestore and R8 filesystem deletion protection, audit logs, Alertmanager), leave a cluster's `k8s_version` unpinned (R1/R3 files only), or drop the R7 NAT gateway |
| `soperator_prod` | `terraform/live/prod/soperator/stage.tfvars` | `production = true`, deletion-protected jails, backups on |
| `allowlists` | every `terraform/live/*/*/*.tfvars` | no committed `allowed_cidrs` entry (cluster endpoint or R7 bastion) inside an RFC 5737 documentation range or wider than /8 (the stacks refuse both at plan time too) |
| `sizing` | every `terraform/live/*/*/*.tfvars` | the CPU node group never carries GPUs (`cpu_platform` is `cpu-*`, `cpu_preset` is not `<n>gpu-*`) and stays at most 16 nodes: no stage GPU cap counts it (the inference and training stacks refuse the same values) |
| `kueue` | `kubectl kustomize workloads/kueue/overlays/<stage>` + `workloads/kueue/sample-job` + `platform/stages.yaml`, combined (`conftest test --combine`) | R16: Kueue objects are `v1beta2`; Topology levels are Nebius topology labels ending at `kubernetes.io/hostname`; flavors, queues and the job reference objects in the build; flavors select nodes and tolerate the GPU taint; queues select team namespaces only; the job requests a topology level that exists and GPUs equal to its limits; the cohort's nominal GPUs fit `max_gpu_nodes.training` × 8 of the stage |

Run locally with the pinned conftest version in `platform/versions.yaml`:

```bash
make policy
```

Adding a rule: write it as `deny contains msg if { ... }` (Rego v1), name the document that
explains the rule in the message, add a line to the table above, and add a `<package>_test.rego`
case that proves it refuses a bad input (`conftest verify --policy policy`, the first step of
`make policy`).
