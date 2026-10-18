# 15-minute customer walkthrough

Order: problem → architecture → Terraform → platform readiness →
results → recovery → cost and teardown. Each section names the file to open and the proof
to show. Where a number is required, it comes from `results/` or `docs/evidence/`; if those
are empty the honest line is "not measured yet". To pick the recipe for a customer's problem first, use
[`docs/solutions/`](solutions/README.md); to deploy what you showed, [`runbooks/deploy.md`](../runbooks/deploy.md).

| Min | Section | Open | Proof |
|---|---|---|---|
| 0–2 | **Customer problem and success criteria** | `docs/decisions/0001-kubernetes-vs-serverless.md` | the control-vs-scope decision table; what result would *reject* Kubernetes |
| 2–4 | **Architecture and rejected alternatives** | `docs/architecture.md` (layers, stage × stack, request path) · the recipe pages (`terraform/stacks/*/README.md`, `recipes/*/README.md`) | four layers with one owner each; serverless (R6) and plain-VM Slurm (ADR-0008) rejected and why |
| 4–6 | **Terraform plan and resource ownership** | `terraform/stacks/inference`, `make plan` output, `docs/decisions/0005-*`, `0006-*` | one state per stage × stack (`stages/<stage>/<stack>.tfstate`), bucket + 1-day key; who reconciles what |
| 6–8 | **GPU / platform readiness** | `tests/validate/00..03`, `results/0*.json` | nodes → GPU (device plugin + DCGM) → NCCL single node → virtiofs on every node |
| 8–11 | **Inference or training results with method** | `tests/load/README.md`, `results/05-load.json` · `results/03-nccl-*.json` | p50/p99 with the exact generator flags; busbw with `NET/IB …/IB` (not `/RoCE`) |
| 11–13 | **Failure, rollback, recovery** | `runbooks/rollback.md` drill, `runbooks/incident.md` | hashed ConfigMap → `rollout undo` restores the model pin; kill-pod recovery time |
| 13–15 | **Cost assumptions, limitations, teardown proof** | `docs/cost.md`, `docs/soperator-compatibility.md`, `runbooks/teardown.md` | residue check empty after `make destroy`; doc conflicts you refused to paper over |

## The 60-second version

1. **Problem in their numbers**: latency/throughput/budget/timeline.
2. **Four layers**: Terraform provisions → Marketplace/Helm enables → kubectl runs → runbooks operate.
3. **One rejected alternative**: serverless when they need runtime control; Kubernetes when they don't.
4. **Proof plan**: `tests/validate` bottom-up, `vllm bench serve` with recorded flags, NCCL before training.
5. **Ownership and cost**: one owner per layer; GPU per second; every sandbox run ends in `make destroy`.

## Pushback you will get

| Pushback | Answer, with the file |
|---|---|
| "Just give us the fastest config." | baseline + one controlled change, `tests/load/README.md` |
| "Kubernetes is too complex." | `recipes/serverless` measures the alternative on the same model |
| "Can we use the sample config as-is?" | `docs/security.md` demo defaults; the stage sizing lives in `terraform/live/<stage>/<stack>/<stage>.auto.tfvars`, not in the stack examples |
| "Our security team will not accept public IPs on nodes." | R7 `terraform/stacks/network`: private workload subnet, NAT egress, WireGuard bastion behind an allowlist; prod's cluster endpoint is private |
| "Will you guarantee the GPUs?" | no: quotas and reservations are requested per project (`runbooks/capacity-request.md`); nothing in this repository is a capacity or price commitment |
| "What will it cost?" | `docs/cost.md` cost shape and worksheet; no number without their presets and hours |
