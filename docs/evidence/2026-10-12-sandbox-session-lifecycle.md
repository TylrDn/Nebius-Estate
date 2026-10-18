# sandbox session lifecycle: preflight, re-price, TTL jobs, teardown (R2, R9) — 2026-10-12

- **Kind:** run of this repository: the session around three live roots, `terraform/live/sandbox/data`,
  `terraform/live/sandbox/ml-services` and `terraform/live/sandbox/inference`; run 2, steps 0, 1, 2d, 10 and
  11, of the [live-run plan](../plans/2026-10-12-live-runs.md), run from the owner's terminal
  with the plan's step scripts (`ASSUME_YES=1` after review).
- **Date / region:** 2026-10-12, 19:10–20:07 UTC, `eu-north1`, one sandbox project. Run ticket
  `live-20261012-run2`; labels `nip-owner`, `nip-run`, `nip-ttl-expires`.
- **Versions:** provider `nebius/nebius` 0.6.67 (helm, kubernetes, kubectl, random and units providers
  for R1 at their lock-file versions); `scripts/preflight.py`, `recipes/finance/price.py`,
  `scripts/ttl-teardown.sh`, `scripts/leftovers.sh` at the session's commit.
- **Method:** below, step by step. What each root showed is in its own file:
  [R8](2026-10-12-sandbox-data-acceptance.md), [R12](2026-10-12-sandbox-ml-services-acceptance.md),
  [R1](2026-10-12-sandbox-inference-validate.md), [R14](2026-10-12-sandbox-inference-o11y-acceptance.md).
- **Cost:** the three roots together ≈ $1.46/h list while all were up; the session ≈ $1.0 estimated
  (R1 $0.43, R12 $0.54, R8 $0.02); billed figures not yet in the FOCUS export (unknown).

## Results

| Step | Result |
|---|---|
| Preflight, first attempt (its log not kept) | **NO-GO**: `scripts/preflight.py` ran the tenant-wide `quota-plan.py --strict` audit and derived nothing from the plan, so project caps below the tenant and tenant zeros (such as the non-GPU vCPU limit of 0) that the GPU-only plan does not need refused it. Fixed: it now computes the plan's demand per quota and refuses only when that demand exceeds min(tenant limit, project cap) less usage; other findings warn |
| Preflight, 19:10 | **GO** for data, ml-services and inference: data 256 GiB of 4,096 GiB filesystem quota and 2 of 198 buckets; inference 537 GiB disk, 64 GiB filesystem, 1 of 12 instances, 1 of 32 L40S, 1 of 8 preemptible, 1 of 2 clusters; capacity `HIGH 8/8` for `gpu-l40s-a` preemptible (a tenant view, not a guarantee). Warnings: the vCPU zero, and no quota model for ml-services yet |
| Re-price (R9), 19:11 | `price.py --contract` against the billing calculator: preemptible `gpu-l40s-a` `1gpu-8vcpu-32gb` **$0.7492/h**, 512 GiB Network SSD boot disk $0.0498/h, 256 GiB filesystem $0.0281/h; on-demand, preemptible and contract scenarios all $0.8270/h (no contract rate on the account). An estimate, not a quote |
| TTL jobs | armed **before** each apply (data and ml-services 23:40:31Z, R1 22:20:29Z), re-armed after R1 (data and ml-services 22:50:29Z, 30 min after R1); each printed when its IAM token expires (04:17:35Z next day, after the fire time) |
| Teardown, first run 19:39 | R1: 11 destroyed. Then **stopped by its own precondition** before the R12 destroy: the registry still held an image (the image list's top-level `.id`, [R12-1](../upstream-findings.md#2026-10-12-findings-from-this-repositorys-own-runs)). It reported what was destroyed, what was not, and that the data and ml-services TTL jobs stayed armed |
| Teardown, rerun 19:58 | skipped the empty R1 state; image deleted; R12 8 destroyed; orphaned MLflow artifact bucket deleted; R8 4 destroyed; SecretStash secret deleted; every TTL job cancelled |
| Teardown, third run 20:05 | every root's state verified empty; `make leftovers` per stack empty; no MLflow artifact bucket |
| Stage gate, 20:01 and 20:06 | `make leftovers-stage STAGE=sandbox` exit 0, **clean** (state bucket excluded by design); no TTL job left; run inputs, saved plans and the kubeconfig removed |

Also on the day: the GitHub environment for the federated CI **apply** (R13) was created; no apply was
dispatched, so the apply side of R13 is still not run (no log here; owner's record).

## What this does and does not show

- Shows: the plan-scoped preflight lets a project with an unrelated zero quota run, and still refuses a
  plan that needs it (by construction; not exercised live); TTL jobs armed against three real roots;
  a teardown that stops before a destroy it knows will fail, keeps the safety net armed, and finishes
  clean when rerun; the stage gate.
- Does not show: a TTL job firing (all were cancelled after the manual teardown), a staging or prod
  run, a pipeline apply, a billed total for the session.
