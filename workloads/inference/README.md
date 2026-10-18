# Inference workload — vLLM (Recipe 1, Layer 3)

An OpenAI-compatible vLLM server on one GPU, applied with `kubectl` separately from platform
changes (P5, [ADR-0006](../../docs/decisions/0006-reconciler-ownership.md)). The cluster, GPU
node, StorageClass and o11y underneath are [`stacks/inference`](../../terraform/stacks/inference/README.md).

```
base/              Namespace, Deployment, Service, PVC, PDB, NetworkPolicy
overlays/          each generates the hashed ConfigMap (model + engine args)
  qwen2.5-1.5b/    default: fast download (~3 GB), fits any single GPU
  qwen2.5-7b/      representative size (~15 GB); relies on the shared-filesystem model cache
  qwen2.5-7b-prod/ the 7B overlay at prod shape: one replica per GPU node, RollingUpdate, PDB minAvailable 1
```

| Pin | Value |
|---|---|
| Image | `vllm/vllm-openai:v0.31.0@sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3` |
| Model (default) | `Qwen/Qwen2.5-1.5B-Instruct` @ `989aa7980e4cf806f80c7fef2b1adb7bc71aa306` (Apache-2.0) |
| Model (7B) | `Qwen/Qwen2.5-7B-Instruct` @ `a09a35458c702b33eeacc393d103063234e8bc28` (Apache-2.0) |

Every other version: [`docs/compatibility-matrix.md`](../../docs/compatibility-matrix.md).

| Workload contract | Value |
|---|---|
| GPU request | `nvidia.com/gpu: 1`, tolerates `nvidia.com/gpu=present:NoSchedule` |
| Model cache | PVC `model-cache` on `csi-mounted-fs-path-sc`, so a restart does not re-download |
| Exposure | Service `vllm` (ClusterIP, port 8000); **no** LoadBalancer or Ingress: exposing it is a customer decision with auth in front ([`docs/security.md`](../../docs/security.md)) |
| Writable paths | root filesystem read-only; `TRITON_HOME`, `TRITON_CACHE_DIR`, `VLLM_CONFIG_ROOT` and `XDG_CONFIG_HOME` point at the cache emptyDir (`base/deployment.yaml`). vLLM 0.31 failed to start without them on 2026-10-11 (`OSError: [Errno 30] Read-only file system` from the Triton cache); with the fix it started and served on 2026-10-11 ([evidence](../../docs/evidence/2026-10-11-sandbox-inference-serving.md)). `enableServiceLinks: false` keeps Kubernetes from injecting `VLLM_PORT=tcp://…` from the `vllm` Service, which vLLM rejects |
| Rollout | `Recreate` (prod overlay: `RollingUpdate`, `maxSurge: 0`); the ConfigMap is hash-suffixed, so every model or engine change is a new ReplicaSet and `rollout undo` restores image, model pin and engine args together ([`runbooks/rollback.md`](../../runbooks/rollback.md)) |

## Deploy and call it

```bash
make kubeconfig STAGE=sandbox STACK=inference   # then run the export line it prints
kubectl apply -k workloads/inference/overlays/qwen2.5-1.5b
kubectl -n inference rollout status deploy/vllm --timeout=15m   # first start downloads the model
kubectl -n inference port-forward svc/vllm 8000:8000 &
curl -s localhost:8000/v1/chat/completions -H 'content-type: application/json' -d '{
  "model": "Qwen/Qwen2.5-1.5B-Instruct",
  "messages": [{"role":"user","content":"One sentence on why NCCL tests come before training."}],
  "max_tokens": 64}'
```

### Another model (per client)

The model and engine args are inputs to [`render.sh`](render.sh); unset inputs keep the overlay's
values, so with none set it renders the overlay unchanged.

| Input | Default (overlay `qwen2.5-1.5b`) | Notes |
|---|---|---|
| `OVERLAY` | `qwen2.5-1.5b` | the shape: `qwen2.5-7b`, `qwen2.5-7b-prod` (2 replicas, PDB) |
| `MODEL` | `Qwen/Qwen2.5-1.5B-Instruct` | Hugging Face repo id; refused without `MODEL_REVISION` |
| `MODEL_REVISION` | `989aa7980e4cf806f80c7fef2b1adb7bc71aa306` | the commit the weights are pinned to |
| `MAX_MODEL_LEN` | `8192` | context length; KV cache memory grows with it |
| `GPU_MEMORY_UTILIZATION` | `0.85` (`0.90` on the 7B overlays) | 0 < x ≤ 1 |

```bash
MODEL=<org>/<name> MODEL_REVISION=<commit> MAX_MODEL_LEN=16384 workloads/inference/render.sh | kubectl apply -f -
```

The weights must fit the GPU of the node group (`terraform/stacks/inference`); what to change for a
client and what proves it: [`docs/rescoping.md`](../../docs/rescoping.md).

Validation of this layer is `tests/validate/04-workload.sh` and `05-load.sh`
([`tests/README.md`](../../tests/README.md)); the full sequence is [`runbooks/deploy.md`](../../runbooks/deploy.md).
No run of this repository has served a request from this manifest yet: the 2026-10-11 run loaded the
weights onto an L40S and then failed at engine start, before the fix above
([evidence](../../docs/evidence/2026-10-11-sandbox-inference-populate.md)).
