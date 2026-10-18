# ADR 0001: Kubernetes inference vs. managed (serverless) endpoints

- **Status:** accepted (default for this reference); revisit per customer
- **Date:** 2026-10-09
- **Owner:** platform
- **Note (2026-10-11):** `recipes/serverless` measures options 1 and 2 side by side on the same model; it
  does not build the gateway of option 3.

## Context
Customers ask either "serve models on GPUs with control over runtime, scaling and
observability" (Recipe 1) or "just give us an endpoint / batch job" (Recipe 6).
Nebius offers both: managed Kubernetes with GPU node groups, and serverless AI
jobs/endpoints driven by the `nebius ai` CLI (`serverless-ai-cookbook`).

## Options considered
1. Managed Kubernetes + vLLM (this repo's `stacks/inference` + `workloads/inference`).
2. Nebius serverless endpoint for the same model.
3. Both, behind one gateway, with Kubernetes only for models that need custom runtimes.

## Decision and rationale
Lead with option 1 **when the customer needs** any of: a specific serving runtime or
version, custom scheduling (MIG, multi-model packing), private networking, their own
observability stack, or an existing Kubernetes platform team. Lead with option 2 when
they need none of those and want the smallest operating scope. Option 3 is the usual
end state for platform teams and is what `recipes/serverless` demonstrates.

Default here is Kubernetes because the reference architecture must show the full
Provision → Enable → Run → Operate stack; the serverless comparison is measured, not assumed.

## Evidence
Pinned in `workloads/inference/README.md`; measurements land in `docs/evidence/` after the
lab run. No throughput, latency or cost claim is made before then.

## Security and cost consequences
Kubernetes: customer owns patching, RBAC, exposure; GPU billed per second while the
node exists, whether or not it serves traffic. Serverless: smaller surface, billed per job
or endpoint usage; less control over data path. Neither is "cheaper" without a
workload-specific quote (P6).

## Failure modes and recovery
Kubernetes failure modes are enumerated in `runbooks/incident.md`. Serverless failures are
opaque by design; recovery is redeploy.

## Portability constraints
vLLM + Kubernetes manifests port to any CUDA cluster; serverless job specs are Nebius-specific.

## Review trigger
Customer's platform team ownership changes, or Nebius serverless gains runtime/VPC controls.
