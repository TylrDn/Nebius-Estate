# ADR 0006: Who reconciles what (Terraform vs. GitOps vs. kubectl)

- **Status:** accepted
- **Date:** 2026-10-09
- **Owner:** platform

## Context
Pattern P2: a Helm release is owned by Terraform *or* a GitOps controller, never
both. Production-shape requirement: follow the Nebius solution library, so a
customer already using it sees nothing new; the split below copies what the
library does rather than what we might prefer.

## Options considered
1. Terraform owns infrastructure and platform; workloads applied with kubectl/Kustomize.
2. Terraform stops at the cluster; Argo CD or Flux owns platform and workloads.
3. Terraform owns everything including workloads.

## Decision and rationale
Option 1, with one exception for Soperator:

| Layer | Reconciled by | How |
|---|---|---|
| Infrastructure (network, cluster, node groups, Filestore, GPU cluster) | Terraform | `nebius_*` resources |
| Platform: NVIDIA device plugin (+ DCGM), GPU Operator and Network Operator (opt-in), Prometheus + Grafana (`nebius/grafana-and-prometheus`), Nebius observability agent | Terraform | `nebius_applications_v1alpha1_k8s_release` (Marketplace); `modules/device-plugin`, `gpu-operator`, `network-operator`, `o11y` |
| Platform: Filestore CSI (`csi-mounted-fs-path`) | Terraform | `helm_release` with a pinned chart version (`modules/filestore-csi`) |
| Soperator (R4) | Flux, bootstrapped by Terraform | Terraform installs Flux and the `soperator-fluxcd` bootstrap chart; Flux owns the Soperator `HelmRelease`s |
| Workloads (vLLM, NCCL/DDP jobs) | `kubectl apply -k` from `workloads/` | Separate rollout from platform changes (P5) |

Loki is not installed (`modules/o11y/main.tf`: upstream's Loki path needs a MysteryBox-delivered
S3 key and three buckets).

This is exactly how `k8s-training` and `soperator/installations/example`
work upstream. Argo CD appears nowhere in Nebius's recipes, so adopting it would
be a divergence a customer would have to justify, not us.

## Evidence
- `nebius-solutions-library/k8s-training/helm.tf`, `modules/gpu-operator`, `modules/network-operator` @ `soperator-v4.1.13-2` (`d1c15ca`).
- `nebius/soperator` `fluxcd/` directory and `soperator/modules/fluxcd` in the solution library.

## Security and cost consequences
- Terraform's IAM token is the only credential that can change platform releases; it is short-lived (`runbooks/credential-rotation.md`).
- Flux needs cluster-admin inside the Soperator cluster only.

## Failure modes and recovery
- Two reconcilers fighting shows up as perpetual Terraform diffs or Flux `HelmRelease` reverts; the fix is to delete the duplicate owner, never to `ignore_changes` it away.
- A failed Marketplace release surfaces in `status.state` / `status.error_message` of the `k8s_release` resource.

## Portability constraints
Marketplace releases are Nebius-specific. On another cloud the same two components install from the NVIDIA Helm charts; the ownership split stays the same.

## Review trigger
A customer already running Argo CD/Flux for everything, or Nebius publishing a GitOps-first recipe.

## Note 2026-10-11 (docs sweep)
The decision is unchanged. Correction to the Loki remark above: the Nebius observability agent,
installed by default (`nebius_agent_enabled = true`), ships container logs to Nebius Logging and
keeps them 14 days, so logs do outlive `kubectl logs` without Loki. Loki is needed only for longer
retention. The module now sets the agent's `config.logs.enabled`, `config.traces.enabled` and a
node-label allowlist explicitly (`modules/o11y/variables.tf`); Terraform still owns that release.
Sources: https://docs.nebius.com/observability/agents/nebius-o11y-agent#configuration-parameters,
https://docs.nebius.com/observability/resources/quotas-limits#logs-constraints.
