# sandbox/ml-services run (R12 registry, MLflow, PostgreSQL) — 2026-10-11

- **Kind:** run of this repository (`terraform/live/sandbox/ml-services`, R12), the first apply of this root.
  Approved within the owner's $10 cap for the live-recipe round.
- **Date / region / platform:** 2026-10-11, first apply 18:05:18 UTC, second apply 18:26:00–18:29:47 UTC,
  destroy 18:37–18:38:52 UTC, `eu-north1`. Container Registry; Managed MLflow `medium` (public endpoint,
  `mlflow-sa`, artifact bucket created by the service); Managed PostgreSQL 16, `cpu-e2` `2vcpu-8gb`, 1 host,
  96 GiB `network-ssd`, public endpoint, daily backups at 00:02 UTC kept 7 days. **No node identity**
  (`create_node_service_account = false`): the run made no IAM changes. Safety-net teardown armed for
  20:35:09 UTC (8993 s, computed in UTC), disarmed after the destroy.
- **Versions:** provider `nebius/nebius` 0.6.67, Terraform 1.16.3; MLflow 2.21.2 as reported by the service.
- **Method:** `source scripts/bootstrap-backend.sh sandbox ml-services` (default subnet); a git-ignored
  `zz-run.auto.tfvars.json` (`enable_mlflow`, `enable_postgresql`, `create_node_service_account = false`, labels
  `nip-run=live-recipe-ml-services-2026-10-11` and a 3 h TTL); passwords generated for the run and passed as
  `TF_VAR_*` only (checked absent from the saved plan); `make init plan apply`, then the fixes below,
  `terraform untaint`, a `state rm` + `import` of the MLflow cluster, `make plan apply`, `make destroy-plan destroy`;
  `scripts/leftovers.sh --stage sandbox`. The MLflow artifact bucket the service created was deleted by hand
  after the destroy (empty; the stack does not own it, as the README says).
- **Cost:** list prices from the pricing pages (the calculator does not price these services):
  MLflow $0.48/h + 200 GiB disk $0.019/h, PostgreSQL $0.14/h + 96 GiB $0.009/h, registry free; budgeted
  ≈ $1.30 for 2 h. MLflow ran about 33 min and PostgreSQL about 13 min ≈ **$0.31 estimated** (not billed).

## Results

| Check | Result |
|---|---|
| First plan | `Plan: 4 to add` (registry, MLflow, PostgreSQL, stage policy), all in the sandbox project |
| First apply | registry created in 3 s; MLflow created and `PHASE_RUNNING` after about 18 min, but the apply failed with `Provider produced inconsistent result after apply: .labels_all: element "nip-…" has vanished` for all seven labels: **the MLflow cluster came back with no labels**; PostgreSQL refused at create: `validate cluster metadata: clusterDescription: value is invalid, must match regexp ^[\{\}\,\":a-zA-Z0-9\s_-]*$` (the description had parentheses) |
| Second plan and apply (after the fixes) | MLflow re-imported (no labels → no replacement); PostgreSQL **created in 3 min 39 s**; the in-place MLflow update that re-sends the write-only password failed: `Update is unimplemented for nebius.msp.mlflow.v1alpha1.ClusterService` |
| Acceptance | MLflow `PHASE_RUNNING` (public and private tracking endpoints reported); PostgreSQL `PHASE_RUNNING`, version 16, `cpu-e2` `2vcpu-8gb`, 96 GiB, backups `00:02:00` / `7d`, public and private read-write endpoints; registry `ACTIVE` at `cr.eu-north1.nebius.cloud` |
| Not run | MLflow run logging, `psql`, image push and node pull (runbook "Validate"): need credentials on a client and a cluster |
| Teardown | `Plan: 0 to add, 0 to change, 4 to destroy.`, `Apply complete! Resources: 0 added, 0 changed, 4 destroyed.` (MLflow 1 min 25 s, PostgreSQL 24 s); the MLflow artifact bucket remained, as documented, and was deleted; then `leftovers.sh --stage sandbox`: no leftovers |

## Portal (Nebius Estate)

| View | Result |
|---|---|
| Integrations | `msp.mlflow` 1, `msp.postgresql` 1, `registry.registries` 1 item while the services ran; 0 after the destroy |
| Estate resources | registry and PostgreSQL attributed to `sandbox / ml-services`, run and TTL; **MLflow and its artifact bucket unattributed** (no labels exist to read) |
| PostgreSQL public flag | shown as private while the cluster was public. **Fixed:** the mapper also reads `spec.config.public_access` (PostgreSQL), test `managedClusters.test.ts`; shown "public" on the next sync |
| Fleet service health | Managed MLflow and PostgreSQL cards list the clusters |
| Overview run-rate | **does not include MLflow or PostgreSQL** ("No running VMs, disks or filesystems in scope to price") while about $0.65/h of managed services ran: open |
| After teardown | resources gone on the next sync; no new alert |

## Findings

- Fixed (stack): MLflow is sent no labels; PostgreSQL description restricted to the accepted characters
  (tests in `tests/ml-services.tftest.hcl`).
- Fixed (`scripts/leftovers.sh`): `msp postgresql v1alpha1 cluster list` answers `{"clusters": [...]}`, not
  `{"items": [...]}`, so the residue check **missed a running PostgreSQL cluster**; it now normalises the key,
  and lists unlabelled MLflow clusters in a stack-scoped check (tests in `tests/scripts/test-leftovers.sh`).
- Fixed (portal): PostgreSQL public flag.
- Documented: MLflow has no update API, so password rotation by re-sending fails (`runbooks/ml-services.md`).
- Open: run-rate without managed services; MLflow attribution without labels (by name or by the artifact
  bucket's `mlflow-<cluster id>-artifacts` name).

## What this does and does not show

- Shows: R12's managed services start in `eu-north1` on their own quotas (the non-GPU vCPU quota of 0 does not
  block them) and tear down cleanly; three API behaviours the mocked tests could not see.
- Does not show: the node pull identity (IAM), any client using MLflow, PostgreSQL or the registry.
