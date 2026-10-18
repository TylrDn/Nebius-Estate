# Sandbox inference root without CPU nodes, to populate the portal — 2026-10-11

- **Kind:** run of this repository (`terraform/live/sandbox/inference`, R1), the second apply of a
  live root. Approved scope: 1 preemptible L40S node, 3 h, $5 cap, automatic destroy at the TTL.
- **Date / region / platform:** 2026-10-11, apply 07:45:12 UTC, destroy 10:47:12–10:57:52 UTC (TTL
  10:44:28 UTC; see "Teardown" for why it started 3 minutes late), `eu-north1`. `gpu-l40s-a` / `1gpu-8vcpu-32gb` × 1, preemptible; **no CPU node
  group** (`cpu_node_count = 0`: the project's non-GPU vCPU quota is 0); 64 GiB shared filesystem.
- **Versions:** provider `nebius/nebius` 0.6.67, Managed Kubernetes 1.36 (node v1.36.3, Ubuntu 24.04,
  kernel 6.11 nvidia, containerd 2.3.3), vLLM `v0.31.0` (digest-pinned in
  `workloads/inference/base/deployment.yaml`), model `Qwen/Qwen2.5-1.5B-Instruct` at a pinned revision.
- **Method:** `make init plan apply` with a git-ignored run override (`cpu_node_count = 0`, the L40S
  preset, preemptible, labels `nip-run=portal-populate-2026-10-11`, `nip-ttl-expires`); the plan was
  checked for 12 creates, no CPU group and an untainted GPU group before apply. Workload:
  `kubectl apply -k workloads/inference/overlays/qwen2.5-1.5b` (run by the owner).
- **Cost:** live calculator before the run: ≈ $0.78/h (preemptible GPU $0.7492/h + disk + filesystem),
  ≈ $2.35 for 3 h; billed figure recorded below once the FOCUS export carries it.

## Results

| Check | Result |
|---|---|
| Apply | `Apply complete! Resources: 12 added`: cluster 5 min 22 s, GPU node group 1 min 30 s, CSI 27 s, device plugin 56 s, Prometheus 1 min 10 s, observability agent 5 s |
| GPU visible to Kubernetes | **`nvidia.com/gpu` allocatable = 1** on the only node, taints 0. The 2026-10-11 morning run showed 0 with a tainted GPU node and no CPU node; with the taint removed when there are no CPU nodes, the add-ons schedule and the device plugin advertises the GPU |
| System pods | 25 running (kube-system, o11y, nvidia-device-plugin); 1 pending: the second `cilium-operator` replica, which needs a second node for its host ports (expected on one node) |
| Model cache | `model-cache` PVC bound in seconds on the shared filesystem (`csi-mounted-fs-path-sc`, RWX, 64 GiB) |
| vLLM | weights loaded onto the L40S (2.98 GiB in 18 s), then the engine **failed to start**: Triton/Inductor wrote to `/root/.triton` on the read-only root filesystem (`OSError: [Errno 30] Read-only file system`). Fixed in the base manifest (`TRITON_HOME`, `TRITON_CACHE_DIR`, `VLLM_CONFIG_ROOT`, `XDG_CONFIG_HOME` on the writable cache emptyDir; usage stats off). The fixed manifest was not re-applied in this run (cluster writes need the owner) |
| Portal | cluster discovered automatically and read as `nebius:viewer`; Workloads listed 12 deployments including `vllm` with its scheduler and crash state; GPU telemetry (0 %, 26 °C, 34 W) and the node group rendered on Capacity |
| Billing export | the periodic FOCUS export created during the run delivered its first files within minutes; the portal imported 261 rows, $8.75, equal to the console; after the `NULL` parsing fix the re-import accepts the one $0 Tax row too (262 rows, still $8.75) |

| Teardown | `Plan: 0 to add, 0 to change, 12 to destroy.` then `Apply complete! Resources: 0 added, 0 changed, 12 destroyed.`; `scripts/leftovers.sh --stage sandbox` (now also listing MLflow, PostgreSQL, registries and every disk) reports nothing; direct lists show 0 instances, disks, filesystems, clusters and allocations, and only the state bucket. Two defects found by a destroy dry run at 10:15 and fixed before it: the Kubernetes-side providers dialled `localhost` in the destroy plan (the plan treats the cluster as already gone), worked around with a git-ignored provider override and now automated by `scripts/destroy-providers-override.sh` in `make destroy-plan`; and two bootstraps in one minute collided on the state-key name (now second resolution). The scheduled job itself computed its start in local time instead of UTC (macOS `date -j -f`) and was stopped and replaced by a manual run of the same approved commands at 10:47 |

## Findings fixed from this run

- `terraform/stacks/inference`: `cpu_node_count = 0` now creates no CPU node group and leaves the GPU
  node untainted (tests `zero_cpus_create_no_cpu_node_group_and_untaint_gpu`,
  `cpu_nodes_keep_the_gpu_taint`, `no_nodes_at_all_refuses_add_ons_that_need_nodes`).
- `workloads/inference/base/deployment.yaml`: every cache and config home points at the writable
  cache volume; without it no inference overlay could start on vLLM 0.31.
- `docs/evidence/costs.md`: per-run figures were lab-harness estimates, about 1.6× the bill; the
  billed totals now come from the FOCUS export.

## What this does and does not show

- Shows: a GPU-only MK8s cluster works end to end up to the model load; the portal's discovery,
  viewer access, telemetry and billing import on real data.
- Does not show: a serving model, throughput or latency (the fixed manifest was not re-applied), CPU
  nodes (quota 0), or the billed cost of this run (pending the export; about 3 h 13 min of resources at
  ≈ $0.78/h list ≈ $2.50 estimated, not billed).
