# platform/ — shared configuration read by the stacks

Data files, not Terraform. The stacks, scripts and CI read them, so a value changes in one place.
The platform *components* themselves (device plugin, CSI driver, Prometheus/Grafana, the opt-in
GPU and Network Operators) are Terraform modules under `terraform/modules/`; who reconciles each
one is [ADR-0006](../docs/decisions/0006-reconciler-ownership.md), and the driver path (managed
driver image by default, operators opt-in) is [ADR-0003](../docs/decisions/0003-gpu-driver-ownership.md).

| File | What it holds | Read by |
|---|---|---|
| [`stages.yaml`](stages.yaml) | Per-stage policy (`sandbox`, `staging`, `prod`): etcd size, endpoint exposure, TTL label, preemptible serving, GPU node caps, Kubernetes version offset, audit logs, Alertmanager, `forbid_deletion`, reservation rules; plus the promotion order ([ADR-0009](../docs/decisions/0009-environment-and-promotion-model.md)) | `modules/stage-policy`, asserted at plan time by `terraform/stacks/{network,data,inference,training}`; `scripts/render-live-roots.py` (renders `terraform/live/`), `policy/stages.rego` (`make policy`) |
| [`regions.yaml`](regions.yaml) | Region → GPU platform → single-GPU preset, 8-GPU InfiniBand preset, drivers preset and fabric; the accepted Kubernetes versions; the Object Storage classes per region | `terraform/stacks/{inference,training}` (defaults and validation), `terraform/stacks/{network,data}` (region validation, storage class) |
| [`versions.yaml`](versions.yaml) | Every pinned version (Terraform, providers, tooling, upstream tag + sha, charts, images) with its source and verification date | `scripts/render-compat-matrix.py` → [`docs/compatibility-matrix.md`](../docs/compatibility-matrix.md), `scripts/check-upstream-versions.py` (weekly drift check); the deploy workflow copies its Nebius CLI pin from here |
| [`alerts/`](alerts/) | Prometheus rule groups: GPU health (DCGM Xid/ECC/throttling, GPU node NotReady, metrics missing), inference (vLLM availability, latency, queueing, restarts), scheduling and storage (pods pending on GPU, capacity exhausted, filesystem and TSDB usage) | `terraform/stacks/{inference,training}` → `modules/o11y` when Alertmanager is on; objectives in [`docs/slo.md`](../docs/slo.md) |

After editing `stages.yaml` or a stack's variables run `make render-live`; after editing
`versions.yaml` run `make compat-matrix`. CI fails when either output is stale.

## Stage policy

The values each stage imposes, rendered from [`stages.yaml`](stages.yaml) by `make render-live`.
This is the only copy: other pages link here. Why each stage is shaped this way:
[ADR-0009](../docs/decisions/0009-environment-and-promotion-model.md); how a value is enforced:
`terraform_data.stage_policy` in each stack and [`policy/`](../policy/README.md) (`make policy`).

<!-- BEGIN GENERATED stage-policy: scripts/render-live-roots.py from platform/stages.yaml; do not edit -->
| Policy (`platform/stages.yaml`) | sandbox | staging | prod | lab |
|---|---|---|---|---|
| `etcd_cluster_size` | 1 | 3 | 3 | 1 |
| `public_endpoint` | yes | yes | no | yes |
| `require_ttl_label` | yes | no | no | yes |
| `allow_preemptible_serving` | yes | no | no | no |
| `forbid_deletion` | no | no | yes | no |
| `max_gpu_nodes` | inference 2 · training 4 · gpu-vm 1 · nvl 0 | inference 2 · training 8 · gpu-vm 1 · nvl 0 | inference 8 · training 32 · gpu-vm 0 · nvl 0 | inference 0 · training 0 · gpu-vm 0 · nvl 0 |
| `k8s_version_offset` | 0 | 1 | 1 | 0 |
| `k8s_version_pinned` | no | yes | yes | no |
| `audit_logs` | no | yes | yes | no |
| `alertmanager` | no | yes | yes | no |
| `require_allowed_cidrs` | no | yes | yes | no |
| `require_strict_reservation` | inference no · training no · nvl yes | inference no · training no · nvl yes | inference no · training yes · nvl yes | inference no · training no · nvl yes |
<!-- END GENERATED stage-policy -->

Outside the policy file: `make destroy` refuses `STAGE=prod` (`Makefile`), and the pipeline
accepts sandbox from any ref, staging from `main` and prod from a release tag
([`docs/change-management.md`](../docs/change-management.md)).
