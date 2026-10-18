# sandbox/inference validation run (R1) — 2026-10-12

- **Kind:** run of this repository (`terraform/live/sandbox/inference`, R1, run profile `l40s-gpu-only`), the
  sixth apply of this root; run 2, steps 2c and 3, of the
  [live-run plan](../plans/2026-10-12-live-runs.md), approved by the owner.
- **Date / region / platform:** 2026-10-12, apply 19:20:11–19:29:12 UTC, validation 19:29–19:39 UTC,
  destroy 19:39:28–19:51 UTC, `eu-north1`. `gpu-l40s-a` / `1gpu-8vcpu-32gb` × 1, preemptible,
  `cpu_node_count = 0`, drivers preset `cuda13.0`; the R8 filesystem of the same session attached; nodes
  run as the R12 node service account; Alertmanager enabled. R1 TTL 22:20:29Z, job armed before apply.
- **Versions:** provider `nebius/nebius` 0.6.67; kubelet `v1.36.3`, containerd 2.3.3, Ubuntu 24.04.4 LTS,
  kernel `6.11.0-1016-nvidia`; NVIDIA driver `580.173.02`; probe image `nvidia/cuda:13.0.1-base-ubuntu24.04`
  and `nccl-tests:2.23.4` (digest-pinned in `platform/versions.yaml`).
- **Method:** `make preflight PROFILE=l40s-gpu-only` (GO: quota demand within limits, capacity `HIGH 8/8`
  for the preset as a tenant view), `make plan` (11 to add), `make ttl-teardown`, `make apply`;
  `make kubeconfig`; `tests/validate/00-nodes.sh`, `01-gpu.sh`, `02-interconnect.sh`, `03-storage.sh`; the
  node headroom check; then [`runbooks/teardown.md`](../../runbooks/teardown.md): o11y scaled to 0 and its
  PVCs deleted, `make destroy-plan`, `make destroy CONFIRM=yes`, `make leftovers STACK=inference`.
- **Cost:** $0.827/h list (preemptible L40S $0.7492/h + 512 GiB boot disk, re-priced on the day) for
  about 31 min ≈ $0.43 estimated; billed figure not yet in the FOCUS export (unknown).

## Results

Raw: [`00-nodes.json`](../../results/2026-10-12/00-nodes.json), [`01-gpu.json`](../../results/2026-10-12/01-gpu.json),
[`02-interconnect.json`](../../results/2026-10-12/02-interconnect.json), [`03-storage.json`](../../results/2026-10-12/03-storage.json) (scrubbed).

| Check | Result |
|---|---|
| Apply | 11 added in **9 min**: cluster 5 min 12 s, GPU node group 1 min 31 s, Prometheus release 1 min 32 s |
| 00-nodes | pass: 1 node, Ready, GPU-labelled |
| Headroom | allocatable 7.9 CPU, 27.6 GiB, 1 `nvidia.com/gpu`; system pods request 0.67 CPU and 1.32 GiB; 7.23 CPU and 26.3 GiB free for vLLM (needs ≥ 2 CPU, 4 GiB): OK |
| 01-gpu, first run | **false positive**: `fail` because DaemonSet `nebius-node-problem-detector-cpu` (desired 0) did not cover the GPU node. It targets CPU nodes by a required node affinity; the check now leaves out DaemonSets that select a node subset that way |
| 01-gpu, rerun 19:38 | pass: 1 allocatable GPU, device plugin and DCGM exporter Ready, `nvidia-smi`: **NVIDIA L40S, driver 580.173.02, 46,068 MiB** (printed twice in the rerun's capture for one GPU; why is unknown) |
| 02-interconnect | **fail**: `kubectl wait` timed out (`timed out waiting for the condition`), no NCCL version read. On one GPU the step can only prove NCCL plumbing (busbw is 0 by definition, [R1-7](../upstream-findings.md#r1-inference-and-managed-kubernetes)); the cause of the timeout is unknown (not diagnosed before teardown) |
| 03-storage | rate above the floor (write 2,066, read 1,757 MiB/s; [R8 acceptance](2026-10-12-sandbox-data-acceptance.md)); step `fail` only on its PVC check (no workload) |
| 04-workload, 05-load | **not run**: no vLLM Deployment existed (namespace `inference` absent), so there was nothing to serve or benchmark. R5's step 7 stopped on the same precondition (it scales `deploy/vllm`) |
| Teardown | o11y PVCs (`prometheus-server`, Alertmanager) deleted first, no PV left; `make destroy-plan` wrote and removed the provider override itself; **11 destroyed** (node group 7 min 1 s, cluster 2 min 36 s); `make leftovers STACK=inference` listed only the R12 MLflow cluster (unlabelled by the API, still up at that point), clean after the R12 destroy |

## What this does and does not show

- Shows: the cluster and one L40S node up from `make apply` in 9 min with the R8 filesystem and the R12
  node identity wired in; the GPU, driver and device plugin as Kubernetes sees them; a sixth clean teardown.
- Does not show: serving, throughput or latency (no vLLM in this session; the only serving evidence is
  still [2026-10-11](2026-10-11-sandbox-inference-serving.md), one client); NCCL on this node (timed out);
  anything multi-GPU. R1 stays at Live run.
