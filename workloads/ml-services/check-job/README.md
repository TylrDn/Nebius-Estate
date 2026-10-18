# Check Job — use every R12 service as a client

One Job that proves the services of [`terraform/stacks/ml-services`](../../../terraform/stacks/ml-services/README.md)
work for a workload, not only that they reached `RUNNING`. Run it with
[`tests/validate/ml-services.sh`](../../../tests/validate/ml-services.sh), which also pulls the pushed image
on a node without a pull secret; procedure in [`runbooks/ml-services.md`](../../../runbooks/ml-services.md#validate).

| Container | Image (pinned in `platform/versions.yaml`) | Check |
|---|---|---|
| `registry` | `crane` (debug variant, busybox shell) | log in as `iam` with `REGISTRY_TOKEN` ([authentication](https://docs.nebius.com/container-registry/authentication#short-lived-access-token)), copy the pinned busybox into `<registry_url>/nip-check:<run>` (push), pull it back by digest |
| `mlflow` | `mlflow` 2.21.2 (the version the service reported) | [`mlflow_check.py`](mlflow_check.py): DNS and TCP 443 probe of the endpoint, then log a run with metric `smoke = 1` in experiment `nip-check` and read it back ([quickstart](https://docs.nebius.com/mlflow/quickstart#configure-connection-to-mlflow-tracking)); no artifact is logged. On failure: `endpoint_host`, `probe`, `cause`, `cause_class`, `http_status` and a bounded `error` that keeps the cause ([reachability](../../../runbooks/ml-services.md#reaching-the-private-mlflow-endpoint-from-a-cluster)) |
| `postgresql` | `postgres` 16 | `select 1` with `sslmode=verify-full` against the Nebius CA certificate ([connect](https://docs.nebius.com/postgresql/databases/connect)) |

Each container prints one `NIP-CHECK {json}` line and exits 1 only when its check fails; a service
whose host is empty is skipped. The pod runs as UID 65532 with a read-only root filesystem, tolerates
the GPU taint (no GPU request) and has an egress NetworkPolicy for DNS, 443 and 5432.

| File | What |
|---|---|
| `kustomization.yaml` | namespace `ml-services`, labels |
| `job.yaml` | the three containers; inputs from ConfigMap and Secret `ml-services-check` |
| `mlflow_check.py` | the mlflow container's code, generated into ConfigMap `ml-services-check-scripts`; tested offline by `tests/scripts/test-mlflow-check.sh` |
| `networkpolicy.yaml` | egress for a default-deny namespace |

Run live once (2026-10-12, R1 cluster against the private-tracking endpoint): the MLflow check failed with a message cut before its cause, which led to `mlflow_check.py`; the other results of that run are not recorded here. Cleanup: `kubectl delete namespace ml-services`; the pushed `nip-check` tags stay
in the registry until deleted (a registry with images cannot be deleted:
[`runbooks/ml-services.md`](../../../runbooks/ml-services.md#teardown)), and the MLflow run stays in
the tracking server.
