# Runbooks

Which runbook to open for which moment. Durations are planning estimates for the sandbox sizing
(the prior validation runs took 30 min for an MK8s + 1-GPU smoke test and 43 min for a Soperator
apply → `sbatch` → destroy); record actuals in `docs/evidence/`. Risk: **spend** = creates
billable resources; **disruptive** = replaces nodes or interrupts serving; **read-only** = changes
nothing.

## Day 0/1: build and remove

| Situation | Runbook | Duration | Risk |
|---|---|---|---|
| First deploy of a stack in a stage; staging and prod promotion | [`deploy.md`](deploy.md) | 45–90 min (sandbox inference incl. validation) | spend; needs a written approval |
| Private network, NAT egress, WireGuard peers (R7) | [`network.md`](network.md) | 20–30 min to apply; 10 min per peer | spend |
| Buckets, transfer, staging data, checkpoint restore (R8) | [`data.md`](data.md) | 15 min to apply; copy time depends on size | spend |
| One GPU VM serving a model, no Kubernetes (R10): deploy, reach the API, preemption, teardown | [`gpu-vm.md`](gpu-vm.md) | 15 min to apply; minutes more for the image and model download | spend (GPU-hours); sandbox and staging only |
| Container Registry and node pull identity, Managed MLflow and PostgreSQL (R12): deploy, passwords, restore | [`ml-services.md`](ml-services.md) | 15 min (registry); MLflow and PostgreSQL provision for longer | spend; the node identity needs project `admin` |
| Hosted models through Token Factory (R11): API key, list models, smoke test, dedicated endpoints | [`token-factory.md`](token-factory.md) | 5 min | read-only, except the smoke test (a fraction of a cent, owner's approval) and dedicated endpoints (per GPU-hour) |
| Rack-scale GB300 NVL72 (R15): capacity request, stage-policy unlock, add racks to a training cluster, validate, remove | [`nvl.md`](nvl.md) | days to weeks for the reservation; about 1 h per rack once reserved | spend (a reservation bills for its term); mocked only, no capacity yet |
| An owner-run live session on the sandbox (runs 1-3 of the live-runs plan): step scripts, one-command batch, from a phone, abort | [`live-session.md`](live-session.md) | 4-6 h (run 2 batch about 4 h) | spend (run 2: about $2.91-$5.04 + R6); the owner starts every paid step |
| A run is finished, a stage is retired, or a prod stack is decommissioned | [`teardown.md`](teardown.md) | 20–40 min incl. residue check; prod: a release | destructive (refused for prod by `make`) |

## Day 2: operate

| Situation | Runbook | Duration | Risk |
|---|---|---|---|
| New Kubernetes version, chart or Marketplace release, Soperator tag | [`upgrade.md`](upgrade.md) | 1–2 h per stage | disruptive (rolls every node) |
| `plan` shows changes nobody made in git | [`drift.md`](drift.md) | 15–30 min | read-only until you decide |
| A change made things worse: workload, platform or infrastructure | [`rollback.md`](rollback.md) | 10–30 min (workload); a node-group revert is a full replace | disruptive |
| Weekly, monthly and quarterly chores; pre-release checks | [`maintenance.md`](maintenance.md) | per task | mostly read-only |
| A stage needs more GPUs: quota, reservation, GPU cluster | [`capacity-request.md`](capacity-request.md) | days for quota and reservations; 30–60 min to apply | spend (commits capacity) |
| A key or token expires, leaks, or is due | [`credential-rotation.md`](credential-rotation.md) | 15–30 min | low; a missed step blocks the pipeline |
| Wiring a real alert receiver for staging or prod | [`alerting.md`](alerting.md) | 30 min | low |
| Reading metrics, logs and traces of a project; Grafana on Nebius Observability; journald on a node group; console alerts (R14) | [`observability.md`](observability.md) | 5 min to read; 30 min for Grafana | read-only, except journald (recreates the group's nodes) |
| Team queues on a GPU cluster: install Kueue, team shares, topology-aware placement, add a team (R16) | [`team-scheduling.md`](team-scheduling.md) | 15 min to install; validation as long as its jobs | low; the sample and reclaim jobs use GPUs (approval) |
| Monthly close, budgets, FOCUS export, spot caps, project limits; pricing a run before approval (R9) | [`finance.md`](finance.md) | 45–60 min per month | read-only, except changing a cap or a limit |
| CI without static keys (GitHub OIDC federation), team groups, revoking CI access (R13) | [`identity.md`](identity.md) | 20–30 min per stage | low (IAM; admin apply); plan side run live on sandbox |

## Incidents and recovery

| Situation | Runbook | Duration | Risk |
|---|---|---|---|
| GPU not visible, vLLM Pending or crashing, NCCL failing, Terraform run interrupted or stuck | [`incident.md`](incident.md) | until resolved | varies; work bottom-up |
| An alert from `platform/alerts/` fires (Nebius Estate Alerts page or a cluster's Alertmanager): GPU idle, hot, Xid/ECC, metrics missing, a portal connector failing | [`fleet-alerts.md`](fleet-alerts.md) | 10–30 min to diagnose | read-only; fixes go through Terraform |
| Lost or corrupted state, filesystem data, Soperator jail; DR drill | [`backup-restore.md`](backup-restore.md) | 30 min (state) to hours (rebuild) | disruptive |
| Submit, inspect, break or scale a Soperator cluster | [`soperator-jobs.md`](soperator-jobs.md) | 15–60 min | spend; scale-down is unverified |

Before any runbook that changes resources: a fresh login (`nebius iam get-access-token
--no-browser --auth-timeout 90s`), `make preflight STAGE=<stage> STACK=<stack> [PROFILE=<name>]` printing
`GO` ([`deploy.md` → Preflight](deploy.md#preflight)), and the rules in [`incident.md` → Terraform run safety](incident.md#terraform-run-safety).
For a sandbox apply, arm the safety-net teardown at the TTL with `make ttl-teardown` before the apply, so a failed apply is guarded too ([`teardown.md`](teardown.md#safety-net-teardown-at-the-ttl)).
Change kinds and their blast radius: [`docs/change-management.md`](../docs/change-management.md#kinds-of-change-and-their-blast-radius).
