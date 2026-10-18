---
name: nebius-gpu-workload-triage
description: This skill should be used when the user reports a GPU workload problem on Nebius, e.g. "pods can't get the GPU", "0 allocatable GPUs", "node group not scaling", "NCCL is slow", "vLLM won't start", "GPU utilisation is low", "quota failure", or asks to triage a Managed Kubernetes GPU cluster.
---

# Nebius GPU workload triage

Find the root cause of a GPU workload problem bottom-up with read-only evidence, before proposing any
fix.

## Procedure

Work from the lowest layer up and stop at the first layer that fails. Record each command and its
output with the time.

1. **Capacity and quota.** Node group observed count vs configured count. A creation failure with
   `QuotaFailure` names the quota. Tenant quota-allowances with no limit mean 0; project placeholders
   without id or limit draw on the tenant quota (`docs/evidence/2026-10-11-sandbox-inference-portal-connectors.md`, row "Quota semantics"). Preemptible VMs count against
   `compute.instance.preemptible.count`: observed 2026-10-11 (usage 1 of 8 while a preemptible L40S
   ran; limit 8 in the same row); not documented, and whether they also draw on the per-GPU quotas
   is an assumption to confirm. Availability level per
   region/fabric/platform/preset: portal `/capacity` or `capacity/v1/resource-advice`.
2. **Node.** `tests/validate/00-nodes.sh`. Nodes Ready, GPU node labels, taints.
3. **Driver and device plugin.** `tests/validate/01-gpu.sh`. `nvidia.com/gpu` allocatable > 0; the
   node group's drivers preset (`terraform/stacks/inference` `gpu_drivers_preset`,
   `platform/regions.yaml`) and the device plugin release (ADR-0003). See
   `docs/solutions/troubleshooting.md`.
4. **Interconnect.** `tests/validate/02-interconnect.sh`, `03-nccl.sh` only on a GPU cluster with
   InfiniBand; a single node cannot measure bus bandwidth.
5. **Storage.** `tests/validate/03-storage.sh`; shared filesystem mounted and writable.
6. **Workload.** `tests/validate/04-workload.sh`, `05-load.sh`; events, image pulls, OOM, readiness.
7. **Telemetry and logs.** `recipes/observability/metrics.sh` (`names`, `query`, `series`, `coverage`)
   and `logs.sh` (`buckets`, `labels`, `query`; serial console in `sp_serial`, control plane in
   `sp_mk8s_control_plane`) read them with `NEBIUS_PROFILE=nip-portal-viewer`. DCGM series at
   `read.monitoring.api.nebius.cloud/projects/<p>/service-provider/prometheus` (labels
   `instance_id`, `mk8s_cluster_id`, `mk8s_node_group_id`).

## Tools

- The portal's Fleet, Alerts and Logs pages show the same signals with history; an alert's guided fix
  links the runbook section.

- Kubernetes MCP in read-only mode (`tools/mcp/kubernetes-readonly.toml`) with a viewer kubeconfig
  (`scripts/get-kubeconfig.sh`). Secrets are denied.
- `kubectl get/describe/logs` only. Runbooks: `runbooks/incident.md`, `runbooks/alerting.md`.

## Never without explicit approval of the exact target and action

`kubectl exec`, `debug`, `delete`, `scale`, `apply`, `cordon/drain`; resizing node groups; submitting
GPU jobs; changing quotas or IAM. Propose them with the evidence instead.

## Output

Symptom, layer that failed, evidence (commands and outputs), root cause (or ranked hypotheses with
the check that separates them), proposed fix with blast radius, and how to verify the fix.
