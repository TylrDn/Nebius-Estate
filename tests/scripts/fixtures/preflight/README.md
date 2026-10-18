Offline inputs for `tests/scripts/test-preflight.sh` (`scripts/preflight.py --fixtures`): mock ids only.

- `quota-allowances.json`: `scripts/quota-plan.py --allowances-file` shape, `{tenant_id, allowances: {<parent id>: [quota-allowance items]}}`.
- `quota-allowances-2026-10-12.json`: the same shape, the live `eu-north1` situation of 2026-10-12 (project
  caps below the tenant, a tenant non-GPU vCPU limit of 0) that `quota-plan.py --strict` reported; the
  GPU-only plan needs none of it, so preflight is `GO` with warnings.
- `resource-advice.json`: one page of `GET /capacity/v1/resource-advice` (the shape recorded in
  `portal/e2e-stub/estate.json`), with figures in the range of the 2026-10-11 pricing run.
