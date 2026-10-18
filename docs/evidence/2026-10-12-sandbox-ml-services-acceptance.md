# sandbox/ml-services acceptance run (R12 registry, MLflow, PostgreSQL) — 2026-10-12

- **Kind:** run of this repository (`terraform/live/sandbox/ml-services`, R12), the second apply of this root
  and the first with the node identity; run 2, steps 2b and 5, of the
  [live-run plan](../plans/2026-10-12-live-runs.md), approved by the owner (IAM change included).
- **Date / region / platform:** 2026-10-12, apply 19:11:41–19:20:10 UTC, check Job 19:31:54–19:37:22 UTC,
  destroy 19:58–20:01 UTC, `eu-north1`. Container Registry; Managed MLflow; Managed PostgreSQL 16; node
  service account, image-pullers group, membership and access permit (`create_node_service_account`).
  Passwords in a SecretStash secret created from a `-f` request file (no password on argv).
- **Versions:** provider `nebius/nebius` 0.6.67; PostgreSQL server `16.15` as reported; check Job from
  `workloads/ml-services/check-job` on the R1 cluster of the same session (Kubernetes 1.36.3).
- **Method:** `make preflight` (GO; ml-services has no quota demand model yet, a warning), `make init plan`
  (8 to add), TTL job, `make apply CONFIRM=yes`, then `make plan` again (one-pass check). Step 5:
  `ml-services.sh`: the check Job pushes and pulls an image with `crane` as the IAM identity, logs and
  reads an MLflow run, runs `select 1` with `sslmode=verify-full`; then a pod pulls the pushed digest with
  `imagePullPolicy: Always` and no pull secret. Secrets for the Job came from stdin and process
  substitution, never argv; the Kubernetes secret was deleted afterwards.
- **Cost:** $0.648/h list for MLflow and PostgreSQL together, about 50 min ≈ $0.54 estimated, not billed
  yet (unknown). Not preemptible.

## Results

Raw: [`ml-services.json`](../../results/2026-10-12/ml-services.json) (scrubbed).

| Check | Result |
|---|---|
| Apply | 8 added; PostgreSQL `3m45s`, MLflow `8m2s` (18 min on 2026-10-11) |
| One-pass | the next `make plan` printed **No changes** (the 2026-10-11 fixes for MLflow labels and the PostgreSQL description held) |
| SecretStash | secret and version created from a request file; deleted at teardown, listed after: 0 (soft-deleted secrets are not listed) |
| Registry push and pull | **ok**: pushed `nip-check:<timestamp>` in 3 s, pulled the same digest |
| Node pull without a pull secret | **ok**: a pod on the L40S node pulled `cr.eu-north1.nebius.cloud/<registry>/nip-check@sha256:…` with `imagePullPolicy: Always`; its service account had 0 pull secrets. The R1 node group ran as this root's node service account (step 2c), the only credential the pull had |
| PostgreSQL | **ok**: `select 1` = 1 over `sslmode=verify-full` to the private read-write host |
| MLflow | **failed**: `MlflowException` from `experiments/get-by-name` on the private tracking host, `HTTPSConnectionPool(host='private-tracking.mlflow-<id>…` — the recorded message is truncated there, so the cause is **unknown** (DNS, TLS, network path and credentials are all possible; not diagnosed before teardown) |
| Teardown, first attempt | stopped safely before the destroy: the registry still held 1 image, because the harness read image ids at `.metadata.id` and `nebius registry image list` returns them at the top-level `.id` ([R12-1](../upstream-findings.md#2026-10-12-findings-from-this-repositorys-own-runs)). Nothing was destroyed half-way |
| Teardown, rerun | 1 image deleted by `--id`, 8 destroyed (MLflow `1m23s`), the orphaned MLflow artifact bucket deleted by `scripts/mlflow-artifacts.sh`, `make leftovers STACK=ml-services` empty |

## What this does and does not show

- Shows: registry push and pull by IAM, node pulls without pull secrets, and PostgreSQL over verified TLS,
  each from a real client in the stage network; the root applies in one pass; the teardown order
  (images, then the destroy, then the MLflow artifact bucket) works once images are listed by `.id`.
- Does not show: any MLflow client operation (failed, cause unknown); MLflow over its public endpoint;
  PostgreSQL beyond one query; registry throughput.
