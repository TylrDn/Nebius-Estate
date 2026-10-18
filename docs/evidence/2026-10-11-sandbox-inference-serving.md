# Sandbox inference root serving a model (R1) — 2026-10-11

- **Kind:** run of this repository (`terraform/live/sandbox/inference` + `workloads/inference/overlays/qwen2.5-1.5b`),
  the fifth apply of a live root; the first in which a model served requests. Approved within the
  owner's overnight budget; the workload apply was run by the owner (cluster writes need the owner).
- **Date / region / platform:** 2026-10-11, apply 14:21–14:31 UTC, destroy 15:21:29–15:31:53 UTC,
  `eu-north1`. `gpu-l40s-a` / `1gpu-8vcpu-32gb` × 1, preemptible; `cpu_node_count = 0`.
- **Versions:** provider `nebius/nebius` 0.6.67, Managed Kubernetes 1.36, vLLM `v0.31.0` (digest-pinned),
  `Qwen/Qwen2.5-1.5B-Instruct` at the revision pinned in the overlay.
- **Method:** `make init plan apply`; owner: `kubectl apply -k workloads/inference/overlays/qwen2.5-1.5b`;
  readiness polled; five sequential chat completions through a temporary `kubectl port-forward`
  (`max_tokens` 64, temperature 0, one fixed prompt); portal read through its API; `make destroy-plan`,
  `make destroy CONFIRM=yes`, `scripts/leftovers.sh --stage sandbox`.
- **Cost:** about 1 h 10 min of resources at ≈ $0.78/h list ≈ $0.90 estimated (not billed).

## Results

| Check | Result |
|---|---|
| Start-up, first attempt | engine failed: `ValueError: VLLM_PORT 'tcp://<ip>:8000' appears to be a URI`. The Service is named `vllm`, so Kubernetes service links injected `VLLM_PORT`, which vLLM reads as its own setting. Fixed with `enableServiceLinks: false` in the base deployment |
| Start-up, with both fixes | **Ready in 110 s, 0 restarts** (image and weights already cached on the node and the shared filesystem). The earlier fix for the Triton cache on a read-only root filesystem held |
| Serving | `/v1/models` lists `Qwen/Qwen2.5-1.5B-Instruct`; 5 sequential requests: 0.77 s, then 0.55 s each (whole request through the port-forward, one client); 38 prompt + 28 completion tokens, `finish_reason` stop |
| Portal | Workloads: `vllm` 1/1 ready, 0 restarts, no pod issues, 1 GPU; Fleet: 1 GPU running, `live` |
| Teardown | `make destroy-plan` wrote the provider override itself; `12 destroyed`; override removed; no leftovers |

## What this does and does not show

- Shows: R1's inference overlay serves on a single L40S after two manifest fixes found only by running
  it live; the portal reports the healthy workload.
- Does not show: throughput, latency percentiles or behaviour under concurrency (one client, five
  requests, not `tests/validate/05-load.sh`); serving with CPU system nodes (quota 0 in eu-north1).
