# Capacity request runbook (quota, reservation, GPU cluster)

When a stage needs more GPUs than it has, in this order. Source:
[quotas](https://docs.nebius.com/overview/quotas), [reservations](https://docs.nebius.com/compute/virtual-machines/reservations),
[GPU clusters](https://docs.nebius.com/compute/clusters/gpu) (verified 2026-10-10),
[capacity advisor](https://docs.nebius.com/compute/virtual-machines/capacity-advisor),
[project limits](https://docs.nebius.com/overview/limits/manage-project-limits) (verified 2026-10-11).

## 1. Check the caps that are ours

```bash
grep -A12 "^  <stage>:" platform/stages.yaml          # max_gpu_nodes per stack
grep gpu_node_count terraform/live/<stage>/<stack>/<stage>.auto.tfvars
```

Raising `max_gpu_nodes` is a policy change (`make policy` guards the training cap);
raising `gpu_node_count` is a sizing change with a written spend approval (CONTRIBUTING "Nothing billable without approval").

## 2. Quota in the stage's project

Compute the need with [`docs/capacity.md`](../docs/capacity.md#quotas-per-stack) (GPU VMs on the platform, vCPU, Network SSD, GPU
clusters, public IPs), then request it in the console for the stage's project. A plan does not
reliably check quota; the apply fails midway when one is short (`runbooks/incident.md`).

Quota granted weeks ago may have been **reduced automatically** while the stage sat idle (an email
announces it; [automatic quota reduction](https://docs.nebius.com/overview/quotas#automatic-quota-reduction)).
Re-check the stage project's quotas (console **Administration → Limits → Quotas**, or the command
in [`docs/capacity.md`](../docs/capacity.md#checking)) on the day of the apply.

Expected: the console shows the raised limit for each quota in the request. Tenant
quota-allowances carry `spec.limit` (an omitted limit means 0;
[evidence](../docs/evidence/2026-10-11-sandbox-inference-portal-connectors.md)), so `make quota-check`
or `quota-allowance list --parent-id <tenant ID>` confirms a grant; project placeholders without an
id inherit it. Approval lead time is not documented and has not been observed here: record it in the
ticket.

Before asking for a reservation, check where the platform and preset have capacity now with the
[capacity advisor](https://docs.nebius.com/compute/virtual-machines/capacity-advisor#how-to-get-data-from-the-capacity-advisor)
(console, CLI or SDK); it covers Managed Kubernetes nodes:

```bash
nebius capacity resource-advice list --parent-id <tenant_ID>
```

### Project allowances below the tenant quota

A project allowance with a limit of its own is a cap beneath the tenant quota; a project entry without
one uses the tenant quota ([`docs/capacity.md`](../docs/capacity.md#project-allowances-vs-tenant-quotas)).
Check every listed project read-only (a read-only profile is enough):

```bash
set -a; source .env; set +a                      # NEBIUS_PROJECT_IDS, NEBIUS_TENANT_ID, NEBIUS_REGION
NEBIUS_PROFILE=<read-only profile> make quota-check
```

Expected: per region and project, each real cap that differs from the tenant limit, with one of

| Verdict | Meaning | Action |
|---|---|---|
| no effect | cap above the tenant limit; the tenant limit always binds | none needed; align it to keep the numbers honest |
| caps this project; intended? | cap below the tenant limit; the project gets less than it would inherit | keep it if deliberate (a small lab), else align |
| blocks this project (cap 0) | nothing of that kind can be created in the project | align unless deliberate |

then the tenant limits of 0 that the stacks need in their region, each with "request from Nebius
(console → Administration → Limits → Change quota)" and a pre-filled justification line to paste into
the request. The portal shows the same check under GPU & Capacity → Quotas → Allowance check, and the
`ProjectAllowanceBelowTenant` alert fires for every cap below the tenant limit.

To align chosen caps to the tenant limit (an admin profile; update only, never create or delete):

```bash
scripts/quota-plan.py --plan-align [--quota 'vpc.*'] [--include-no-effect]   # prints the updates, changes nothing
CONFIRM=yes scripts/quota-plan.py --apply [same flags] --rollback-file quota-rollback.json
```

`--apply` re-reads the allowances, writes the rollback file (id, previous and new limit) before the
first update, then runs `nebius quotas quota-allowance update --id <id> --limit <tenant limit> --patch`
per cap. Rollback: the same command with each `previous_limit` from the file. Keep the file out of git
(it carries resource ids) and re-run `make quota-check` to confirm nothing is left.

## 3. Reservation (staging optional, prod training required)

Prod training nodes must run on a STRICT reservation (`platform/stages.yaml`
`require_strict_reservation.training`). Reservations cannot be created in the console: request a
capacity block group (platform, GPU count, period) from your Nebius manager (or ask support to
connect you with one), then note its ID from **Limits → Capacity block groups**
([reservations](https://docs.nebius.com/kubernetes/node-groups/reservations)). GPUs from
reservations do not count towards GPU quotas; the other quotas in step 2 still apply. Then:

```hcl
# terraform/live/prod/training/prod.auto.tfvars
gpu_node_count  = 2
gpu_reservation = { policy = "STRICT", reservation_ids = ["<capacity_block_group_ID>"] }
```

If the reservation draws on a capacity block group shared by several projects, set a project limit
for each stage project so a lower stage cannot use prod's GPUs
([set a project limit](https://docs.nebius.com/overview/limits/manage-project-limits#how-to-set-a-custom-project-limit);
`0` disables CBG use for a project).

`AUTO` (reserved first, then on-demand) is the serving choice in prod when burst is acceptable.
A STRICT group cannot be preemptible; the module refuses the combination.

## 4. GPU cluster (InfiniBand)

Created by the training stack only when `gpu_node_count > 0` and `enable_gpu_cluster = true`,
in the fabric `platform/regions.yaml` names for the region and platform. The fabric must have
free capacity for the whole group; a partial placement is an apply failure, not a smaller
cluster. One fabric accepts one platform.

## 5. Plan, review, apply

```bash
make plan STAGE=<stage> STACK=training      # exactly N 8-GPU nodes and one GPU cluster added
make apply CONFIRM=yes STAGE=<stage> STACK=training
tests/validate/run-training.sh              # single-node NCCL, then multi-node over /IB at >= 300 GB/s
```

Record the reservation id, term and expiry in the capacity calendar (`docs/capacity.md`) and the
run in `docs/evidence/`.
