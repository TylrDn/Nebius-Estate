# Finance runbook — R9 monthly close and governance checks

Close a month: get the FOCUS export, load it into the portal, review each stage's budget against
it, fix labels, and clear leftovers. Then re-check the controls that stop spend (pricing
policies, project limits, quotas). The controls and their console steps are in
[`recipes/finance`](../recipes/finance/README.md); the Terraform part is
[`terraform/stacks/governance`](../terraform/stacks/governance/README.md). `price.py` ran live on
2026-10-11 on every S1–S9 footprint (list and spot; no contract rate, the account has no commitment:
[pricing evidence](../docs/evidence/2026-10-11-solutions-pricing.md)), and the portal imported a live
FOCUS export the same day ([populate evidence](../docs/evidence/2026-10-11-sandbox-inference-populate.md),
Results). The governance apply and a monthly close have not run; record the first close in
`docs/evidence/<date>-finance-close.md`.

Who: a member of the platform team with `viewer` in the tenant (exports, usage), plus a tenant
`admin` for anything that changes a periodic export, a quota or a project limit. Duration: 45–60
min per month. Risk: read-only, except step 6 (deletes, with a ticket) and step 7 (changes caps).

Upstream references: [usage export](https://docs.nebius.com/signup-billing/usage/export),
[budgets](https://docs.nebius.com/signup-billing/budgets),
[cost allocation labels](https://docs.nebius.com/signup-billing/usage/cost-allocation-labels),
[pricing policies](https://docs.nebius.com/signup-billing/manage-pricing-policy),
[project limits](https://docs.nebius.com/overview/limits/manage-project-limits),
[quotas](https://docs.nebius.com/overview/quotas).

## When

On the first working day after the month's invoice appears (**Billing → Payments → Documents**,
[paying](https://docs.nebius.com/signup-billing/billing-models/committed-usage#paying-for-the-commitment)).
The docs do not say when a month's usage becomes final; an adjustment appears as its own line in a
later export ([interpreting](https://docs.nebius.com/signup-billing/usage/export#how-to-interpret-the-export-results)),
so re-import when one arrives (step 2 supersedes by hour).

## Monthly close

| # | Step | Command / where | Expect |
|---|---|---|---|
| 1 | **Export.** Check the periodic export ran | **Billing → Export → Periodic export**: **Status** and **Last successful run** ([state](https://docs.nebius.com/signup-billing/usage/export#how-to-view-the-export-state)) | status not **Failed**; last run within the last hours (it delivers once per hour) |
| 1a | If it failed or hours are missing, take a one-time export of the month | `nebius billing v1alpha1 one-time-export create --parent-id <contract id> --start-period <yyyy-mm> --end-period <yyyy-mm> --format export_format_focus_1_2_csv`, then `nebius billing v1alpha1 one-time-export get --id <export id>` and download `.status.download_url` ([one-time](https://docs.nebius.com/signup-billing/usage/export#how-to-create-an-export)) | the link expires after 15 minutes; the file stays for 7 days. The contract id is under **Billing → Payments → Billing details → Payer**; never commit it |
| 2 | **Portal import.** Load the month | automatic with the billing export pull configured ([portal](../docs/portal/billing-and-pricing.md#billing-export-pull)); otherwise **Costs → Import** with the CSV from 1a | the Costs page shows the month with **no missing hours** and export lag of a few hours; re-imported hours replace earlier rows of the same project and hour |
| 3 | **Budget review.** Per stage project | **Billing → Budgets** ([status](https://docs.nebius.com/signup-billing/budgets#how-to-check-a-budget-status)); portal **Costs** by project, `BilledCost` | each `nip-<stage>-monthly` budget exists, alerts go to the tenant contact, and the amount still matches the approved figure ([`docs/cost.md`](../docs/cost.md#spend-controls), control 9). A budget that alerted gets a line in the ticket: which `nip-run` caused it, from Costs by label |
| 3a | Commitments | **Billing → Discounts → Commitment discounts**; in the export, rows with `CommitmentDiscountStatus = Unused` ([view](https://docs.nebius.com/signup-billing/usage/view#how-to-view-commitment-discounts), [fields](https://docs.nebius.com/signup-billing/usage/focus-fields#focus-defined-fields)) | unused committed amount is recorded; budgets do not see it (PAYG only) |
| 4 | **Label hygiene.** Compute cost without labels | the check below; portal Costs grouped by `nip-stage`, then `nip-run` | every Compute row carries `nip-stage` and `nip-run`; unattributed cost is explained or fixed in the stack that created it. Labels reach billing for Compute resources only ([labels](https://docs.nebius.com/signup-billing/usage/cost-allocation-labels)) |
| 5 | **Leftovers.** Per stage project | `NEBIUS_PROJECT_ID=<stage project> scripts/leftovers.sh --stage <stage>` | nothing past its `nip-ttl-expires` in the sandbox; nothing unlabelled; `pvc-*` disks only where a cluster still runs |
| 6 | Delete what step 5 found (sandbox only, with the run's ticket) | `make destroy …` for whole stacks ([`teardown.md`](teardown.md)); a person deletes single items | step 5 re-run is clean |
| 7 | **Controls.** Spot caps, project limits, quotas | `terraform -chdir=terraform/live/<stage>/governance output` (once the live root exists), or `nebius billing pricing-policy list --parent-id <project>` and `nebius capacity capacity-allowance list-by-capacity-block-group --capacity-block-group-id <cbg>` ([view policies](https://docs.nebius.com/signup-billing/manage-pricing-policy#how-to-view-pricing-policies), [view limits](https://docs.nebius.com/overview/limits/manage-project-limits#how-to-view-project-limits)) | no policy `SCHEDULING_STATE_BLOCKED` unless intended; sandbox and staging limits `0` on prod's CBGs; quota limits read in the console (**Administration → Limits → Quotas**), because the API omits them and an omitted limit reads as 0 ([recipe](../recipes/finance/README.md#quotas)) |
| 8 | **Record.** | `docs/evidence/<yyyy-mm>-finance-close.md`: total `BilledCost` per stage and currency, budget alerts, unattributed share, leftovers removed, control changes | committed with no tenant, project or contract IDs |

### Label check on an export file

Rows without tags, by service and project, from a FOCUS CSV (stdlib only):

```bash
python3 - focus.csv <<'EOF'
import csv, sys
from collections import defaultdict
tot = defaultdict(float)
with open(sys.argv[1], newline="") as f:
    for r in csv.DictReader(f):
        if not (r.get("Tags") or "").strip("{} "):
            tot[(r.get("ServiceName", "?"), r.get("x_ContainerName", "?"), r.get("BillingCurrency", "?"))] += float(r.get("BilledCost") or 0)
for (svc, proj, cur), v in sorted(tot.items(), key=lambda x: -x[1]):
    print(f"{v:12.2f} {cur} {svc} / {proj}")
EOF
```

Only Compute rows can carry tags, so untagged Object Storage and other services are expected;
untagged Compute cost is the finding.

## Changing a control

| Change | How | Watch out |
|---|---|---|
| Raise or lower a spot cap | edit `spot_price_caps` in the stage's governance tfvars, plan, apply | the max price changes only while no VM runs under the policy: drain the preemptible node group first ([edit](https://docs.nebius.com/signup-billing/manage-pricing-policy#how-to-edit-a-pricing-policy)); a cap below the spot price blocks every start |
| Change a project limit | edit `capacity_limits`, plan and apply as a tenant admin | lowering below usage does not stop running VMs, but blocks new allocations and restarts ([running workloads](https://docs.nebius.com/overview/limits/project-limits#how-limits-affect-running-workloads)) |
| Change a budget amount or recipients | **Billing → Budgets → ⋮ → Edit** ([edit](https://docs.nebius.com/signup-billing/budgets#how-to-edit-a-budget)) | record the new figure and its approval |
| Limit a stage's spend hard | request a quota decrease (admin; [change quotas](https://docs.nebius.com/overview/quotas#change-quotas)) | budgets never stop usage ([budgets](https://docs.nebius.com/signup-billing/budgets)) |
| Move the periodic export | delete it, then create the new one (one active per contract; [delete](https://docs.nebius.com/signup-billing/usage/export#how-to-delete-an-export)) | old files stay in the old bucket; update the portal's export variables |

## Before a new run: price it

```bash
python3 recipes/finance/price.py <footprint.yaml> --project "$NEBIUS_PROJECT_ID" --contract \
  --advice --tenant "$NEBIUS_TENANT_ID" --json > results/price-<run>.json
```

Attach the output to the spend approval with its `as_of` time. It is the price the API returned
then, not a quote; preemptible figures are the spot price at that moment
([method](../recipes/finance/README.md#pricing-and-tco-method)).

## Budget or credit signal

The portal raises these from the budgets and credits entered on **Budgets & credits** (Nebius has no
budget, balance or credit API, so they mirror the console):

| Signal | Meaning | Read-only checks | What a fix changes |
|---|---|---|---|
| `budget-threshold` | actual spend (export rows, entered spend) in the budget's period crossed a threshold | Costs page by project, service and resource; export lag; the same budget in the console ([status](https://docs.nebius.com/signup-billing/budgets#how-to-check-a-budget-status)) | nothing, if expected; otherwise stop or delete what is not needed |
| `budget-over` | actual spend reached the budget amount | as above, plus leftovers (`NEBIUS_PROJECT_ID=<stage project> make leftovers STACK=<stack>`) | stop or delete resources ([stop being charged](https://docs.nebius.com/signup-billing/billing-models/payg#how-to-stop-being-charged)), or raise the budget after approval; a quota decrease is the only hard stop |
| `budget-projected` | actual spend plus the live run-rate estimate since the last exported hour reaches a threshold the actual has not; warning when it is the amount, info below it. A projection, not spend: the export confirms or corrects it within hours | what runs now (Fleet, Estate Explorer: TTL expired, orphan candidates, idle GPUs); the run-rate source (list or contract price) on Budgets & credits; the export lag on Costs | nothing, if the workload is expected; otherwise stop or scale down what is not needed before the export confirms it |
| `budget-forecast` | at the burn rate so far (at least a day of spend), the period-end forecast reaches a threshold that spend has not crossed yet; warning when it reaches the amount, info for a lower threshold | Costs page by service and resource for what drives the rate; whether it is a run that ends soon or something left running (Estate Explorer: TTL expired, orphan candidates; Fleet: idle GPUs); the same budget in the console ([status](https://docs.nebius.com/signup-billing/budgets#how-to-check-a-budget-status)) | nothing, if the rate is expected; otherwise stop or scale down what is not needed before the threshold is reached. A forecast is not a charge |
| `credit-expiring` | a credit with money left expires within 14 days | the balance in the console (AI Cloud: Billing; Token Factory: its console) | plan the work that uses it, or let it lapse; update the credit on the page if the console differs |
| `credit-exhausting` | at the burn since its first draw (at least a day of it), a credit runs out within 14 days, before any expiry; critical within 3 days. A forecast from the spend drawn so far, not a balance | the balance in the console (AI Cloud: Billing; Token Factory: its console); what drives the burn (Costs; the Token Factory Usage tab) | nothing, if the spend is expected and budgeted once the credit is gone; otherwise reduce it before then; update the credit and the entered spend on the page if the console differs |

A credit with no spend known since it applied (no Token Factory spend entered, no AI Cloud export rows) reads
"Unverified" and "≤ amount left": the page cannot tell what was drawn. Saving, editing or deleting a budget, credit
or spend entry re-evaluates these signals at once; a deleted budget's alerts resolve with "budget deleted".

Budgets notify, quotas stop. The portal never changes a budget, a credit or a resource.
