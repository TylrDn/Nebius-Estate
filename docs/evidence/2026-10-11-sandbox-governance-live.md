# sandbox governance root (R9 spot price cap) — 2026-10-11

- **Kind:** run of this repository (`terraform/live/sandbox/governance`, R9), the first apply of this root;
  approved by the owner, run by the owner from a script that planned, applied, verified and destroyed.
- **Date / region:** 2026-10-11, `eu-north1` sandbox project. First attempt ~21:30 UTC (L40S cap), second
  22:38 UTC (H100 cap, `"1.000"` per GPU-hour, 3 h TTL), destroyed in the same run. $0: a pricing policy
  is not billed.
- **Versions:** provider `nebius/nebius` 0.6.67, Terraform 1.16.3.
- **Method:** `source scripts/bootstrap-backend.sh sandbox governance` with the eu-north1 project exported,
  a git-ignored run override (`spot_price_caps`, `quota_watch`, labels with `nip-run` and a 3 h TTL),
  `make init plan`; apply only if the plan held nothing but the pricing policy; `terraform state show`;
  `make destroy-plan destroy`; `scripts/leftovers.sh --stage sandbox`.

## Results

| Check | Result |
|---|---|
| L40S cap (first attempt) | **refused at apply**: "platform gpu-l40s-a is not available in region eu-north1"; the error listed the accepted pairs (H100: eu-north1; H200: eu-north1, eu-north2, eu-west1, us-central1). Nothing created. Fixed: the stack refuses such pairs at plan (`spot_price_cap` in `platform/regions.yaml`, test `platform_without_spot_cap_is_refused`) |
| H100 cap plan | `1 to add, 0 to change, 0 to destroy`: the pricing policy only |
| H100 cap apply | policy **created**, `state STATE_ACTIVE`, `scheduling_state SCHEDULING_STATE_ALLOWED`, currency usd; Terraform then reported "Provider produced inconsistent result after apply" eight times: every `labels_all` element vanished (the API keeps no labels) and `max_price` came back `"1"` for `"1.000"`. Fixed: no labels, canonical price (R9-4 in `docs/upstream-findings.md`) |
| Quota reads | `compute.instance.gpu.h100` and `compute.instance.preemptible.count`: usage and limit `null`, `USAGE_STATE_NOT_USED` (limits are not returned, as recorded before) |
| Teardown | `2 destroyed`; `no leftovers` for `nip-stage=sandbox`. Pricing policies are now listed by name too (`leftovers-unlabelled-pricing-policy`) |

## Also found in this round

- A first attempt sourced `.env` alone, which targets another project: the bootstrap created a second
  state bucket and identity there, and the lock write failed on that project's Object Storage quota of 0.
  The owner removed them (verified gone). Fixed: `bootstrap-backend.sh` binds a stage to its project and
  region and needs `NIP_BOOTSTRAP_NEW_STAGE=1` for a new bucket (`tests/scripts/test-bootstrap-backend.sh`).

## What this does and does not show

- Shows: R9's spot cap applies and tears down cleanly on H100 in eu-north1 after the fixes above.
- Does not show: an apply with the fixed stack (the fix follows from the provider's own error text and is
  covered by mocked tests); a preemptible VM stopping at the cap; L40S caps (not offered by the API).
