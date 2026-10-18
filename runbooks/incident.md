# Incident runbook — inference and training clusters

Work bottom-up (P4). Each section: symptom → check → likely cause → fix → resolved when. Record what you
did in `results/incidents.md` with timestamps and the exact versions from
`docs/compatibility-matrix.md`.

## GPU not visible to pods (`nvidia.com/gpu` allocatable = 0)

1. `tests/validate/01-gpu.sh`; `kubectl -n nvidia-device-plugin get ds,pods`.
2. On the node: `kubectl debug node/<gpu-node> -it --image=busybox:1.36.1@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662 -- chroot /host nvidia-smi`.
3. Causes: node group created **without** `gpu_settings.drivers_preset` (operator path
   expected but no GPU Operator installed), or Marketplace release `nvidia-device-plugin`
   failed (`terraform state show module.device_plugin...` → `status.error_message`).
4. Fix: never flip an existing node group between driver paths; create a new node group
   with the right preset (docs recommendation) and drain the old one.
5. No CPU node group and the GPU node tainted (`kubectl describe node <gpu-node> | grep Taints`
   shows `nvidia.com/gpu`): the add-ons, device plugin included, have no node to run on. Seen
   2026-10-11 with the non-GPU vCPU quota at 0 ([connectors evidence](../docs/evidence/2026-10-11-sandbox-inference-portal-connectors.md)).
   Fix: re-plan with `cpu_node_count = 0`, which drops the CPU group and the GPU taint
   (`terraform/stacks/inference/main.tf` line 36); method in [`deploy.md`](deploy.md). The second
   apply showed allocatable 1, taints 0 ([populate evidence](../docs/evidence/2026-10-11-sandbox-inference-populate.md)).

Resolved when: `kubectl get nodes -o jsonpath='{.items[*].status.allocatable.nvidia\.com/gpu}'` shows
the expected count on every GPU node and `tests/validate/01-gpu.sh` passes.

## CUDA fails to initialise on an 8-GPU node

- `nvidia-smi` works but CUDA init fails with "system not yet initialized (error 802)": on the node,
  `systemctl status nvidia-fabricmanager` and `nvidia-smi -q | grep -A2 Fabric`; the fabric state
  must be completed ([CUDA init error](https://docs.nebius.com/compute/virtual-machines/cuda-init-error#solutions)).
- Was the node touched by maintenance? `nebius compute maintenance list-active --parent-id <project_ID>` and the
  [reason codes](https://docs.nebius.com/compute/virtual-machines/maintenance-reasons#reason-codes).
- Managed Kubernetes auto-repair replaces nodes with GPU issues. To keep a node for diagnosis, stop
  GPU issue processing through the node group's `auto_repair.conditions`
  ([health checks](https://docs.nebius.com/kubernetes/maintenance/enable-disable-health-checks#how-to-stop-processing-issues-with-gpus-on-a-node)),
  and re-enable it afterwards.

Resolved when: CUDA initialises (`tests/validate/01-gpu.sh` passes) and auto-repair is re-enabled.

## vLLM pod Pending

- `kubectl -n inference describe pod -l app.kubernetes.io/name=vllm` → events.
- `Insufficient nvidia.com/gpu`: GPU already held by another pod (`kubectl get pods -A -o json | jq '..|.resources?.limits?["nvidia.com/gpu"]? // empty'`), or step above.
- `node(s) had untolerated taint`: overlay lost the toleration; re-apply the overlay.
- PVC `model-cache` Pending: StorageClass missing → `tests/validate/03-storage.sh`; Filestore not mounted on the node → check cloud-init (`journalctl -u cloud-final` via node debug).

Resolved when: the pod is `Running` and the PVC `Bound`.

## vLLM CrashLoopBackOff / OOM

- `kubectl -n inference logs deploy/vllm --previous | tail -50`.
- `CUDA out of memory` or `KV cache` errors: lower `MAX_MODEL_LEN` or `GPU_MEMORY_UTILIZATION`
  in the overlay ConfigMap; for a 7B model on a 48 GB L40S use `MAX_MODEL_LEN=4096`.
- Host OOMKilled (exit 137 without CUDA message): raise `resources.limits.memory`, or the
  preset is too small for the model's CPU-side loading.
- Model download stalls: `HF_HUB_OFFLINE=0` and egress to huggingface.co required; the
  Filestore cache means a second start never re-downloads.
- `OSError: [Errno 30] Read-only file system` right after the weights load (vLLM 0.31): Triton/Inductor
  writes `/root/.triton` on the read-only root filesystem. The base manifest points `TRITON_HOME`,
  `TRITON_CACHE_DIR`, `VLLM_CONFIG_ROOT` and `XDG_CONFIG_HOME` at the writable cache emptyDir
  (`workloads/inference/base/deployment.yaml`); an overlay or older manifest without them fails this way.
  Seen 2026-10-11; the fix has not been re-run live ([populate evidence](../docs/evidence/2026-10-11-sandbox-inference-populate.md)).

Resolved when: the pod stays `Ready` with zero new restarts for 10 min and `/health` returns 200.

## Request path broken (health 200, completions fail)

- `kubectl -n inference logs deploy/vllm | grep -i error`; check `--served-model-name`
  matches the `model` field in the request.
- Latency spikes with low GPU util → CPU node starved (Prometheus/Grafana + CSI on 2
  small nodes); check `kubectl top nodes`.

Resolved when: a completion request with the served model name returns 200 with tokens.

## NCCL / interconnect (training env)

- Single-node first: `tests/validate/02-interconnect.sh`. If `all_reduce_perf` fails on one
  GPU the problem is drivers/image, not the network.
- Multi-node: `tests/validate/03-nccl.sh multi-node-2x8`. With `NCCL_DEBUG=INFO` the transport
  line decides: `NET/IB : Using [..]mlx5_X:1/IB` is InfiniBand; a `/RoCE` suffix means a plain NIC
  (no GPU cluster) and `NET/Socket` means no RDMA at all. The parser also requires every worker's
  node to carry the same `topology.nebius.com/gpu-cluster-id`.

Resolved when: `03-nccl.sh` passes (average busbw ≥ `NCCL_MIN_BUSBW`, `/IB` transport, one GPU cluster).

## Terraform run safety

- **Never kill an apply or destroy.** Stopping a run by hand lost Terraform's in-flight state
  and orphaned ~30 resources until they were found by label and deleted. `make apply` / `make destroy` go
  through `scripts/tf-run.sh`: one Ctrl-C sends Terraform a single SIGINT and waits for it to
  unwind. If it dies anyway (host crash): `terraform state list`, then
  `scripts/leftovers.sh` and delete what state does not know about, deliberately.
- **Saved plans embed a snapshot of state.** The IAM token is ephemeral (never in a plan), but a
  plan reviewed today and applied tomorrow applies stale assumptions. `tf-run.sh` refuses plans
  older than `NIP_PLAN_MAX_AGE_H` (10). Re-plan; never apply a stale plan.
- **Login expiry mid-run.** A federated session that expired during an apply failed it, and
  the following destroy reused the dead token. Preflight with
  `nebius iam get-access-token --no-browser --auth-timeout 90s` (also in `tf-run.sh` and
  `get-kubeconfig.sh`'s exec args) so an expired login fails fast instead of waiting for a
  browser.
- **Don't re-run `terraform init` (or `make ci`/`make validate`, which re-init) in a root while
  its apply or destroy is running.** Init can replace the provider binary in place, and the
  running process dies with exit 137 mid-apply (observed on macOS).
- **A destroy plan dials `http://localhost`.** `Get "http://localhost/api?timeout=32s": connection refused`
  while refreshing a `helm_*`/`kubernetes_*` resource means the Kubernetes-side providers lost the cluster
  endpoint (it is null in a destroy plan). `make destroy-plan` writes `zz_destroy_override.tf` for this;
  if you planned by hand, run `scripts/destroy-providers-override.sh <stage> <stack>` and plan again
  ([teardown](teardown.md#in-cluster-resources-and-the-provider-override), finding R2-15).
- **Lost state.** Restore the previous object version from the versioned state bucket
  (ADR-0005); if none, reconcile by `terraform import` of what `leftovers.sh` lists.
- **A residue list that reports nothing may be wrong.** Compute rejects `--page-size` above 999
  (undocumented), and a disk's attachment is `status.readWriteAttachment` (singular); both made
  `leftovers.sh` miss resources before 2026-10-11, and it now lists with `--all` and stops on a failed
  call ([connectors evidence](../docs/evidence/2026-10-11-sandbox-inference-portal-connectors.md)). Use
  `--all` in hand-written lists too.
- **No subnet named `default-subnet`.** The default subnet is `default-subnet-<suffix>`, and nebius CLI
  0.12.285 omits `status.default`; `scripts/bootstrap-backend.sh` finds it by prefix and exports
  `subnet_id` (same evidence).

Resolved when: `terraform plan` shows no changes against what exists, and `leftovers.sh` lists only
what state knows about.

## Logs and metrics outside the cluster

Container logs (14 days) and node/GPU metrics reach Nebius Observability through the agent
(`modules/o11y`), so they survive a deleted pod or node:

- Logs: console **Observability → Logs**, or `nebius` CLI with LogQL
  ([CLI queries](https://docs.nebius.com/observability/logs/nebius-cli#running-log-queries)).
- Metrics: console dashboards, or Grafana with the Nebius data source
  ([Grafana](https://docs.nebius.com/observability/metrics/grafana#how-to-connect-grafana-data-source)).
- GPU series missing in Nebius Monitoring while `kubectl` shows the node: check the agent's
  `labelAllowlist` (series over the label limit are dropped without an error).
- A throttle alert that never fires: Nebius Monitoring has no `DCGM_FI_DEV_CLOCK_THROTTLE_REASONS`, only
  `DCGM_FI_DEV_CLOCKS_EVENT_REASONS` ([observability evidence](../docs/evidence/2026-10-11-observability-read-only.md));
  `platform/alerts/gpu-health.yaml` line 31 queries both.

Resolved when: the series for the node appear in a query over the incident window.

## Escalating to Nebius support

Open a ticket in the support center with the topic **technical** and the priority from
[priorities and response times](https://docs.nebius.com/overview/support#priorities-and-response-times);
include the resource IDs, region and time window. Check [status.nebius.com](https://status.nebius.com/)
(UTC timestamps) first.

Resolved when: the ticket is closed and its cause recorded in `results/incidents.md`.

## Terraform: Marketplace release stuck

- `terraform state show 'module.o11y[0].nebius_applications_v1alpha1_k8s_release.prometheus[0]'`
  → `status.state` / `status.error_message`.
- Usually a values key the chart no longer accepts; compare with upstream `modules/o11y` at
  the pinned commit before changing values.

Resolved when: the release `status.state` is deployed and `make plan` shows no change for it.

## Private network (R7) and data plane (R8)

- Pods cannot reach the internet (image pulls, model download): `tests/validate/network.sh`; then
  the NAT VM, its forwarding and masquerade, and the route table ([`network.md` → Verify](network.md#verify)).
- Copy Job fails with `AccessDenied` or `SignatureDoesNotMatch`: the key in `s3-credentials` is
  expired, lacks access to the bucket, or `S3_REGION` does not match the bucket's region
  ([`data.md`](data.md#credentials-access-keys-never-committed)).
- Copy Job Pending on its claim: the `datasets` PVC needs the filesystem CSI StorageClass and the
  filesystem mounted on the node (`tests/validate/03-storage.sh`).

Resolved when: `tests/validate/network.sh` passes, or the Copy Job completes.

## Rollback (any layer)

See `runbooks/rollback.md`: workload → `rollout undo`; platform → revert the Terraform
change and `make plan` / `make apply CONFIRM=yes`; node groups → new group, drain, delete.

Resolved when: the steps in `rollback.md` report their expected outcome and the failing check passes.
