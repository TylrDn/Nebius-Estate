# Sandbox inference root, partial apply for the portal's cluster connectors — 2026-10-11

- **Kind:** run of this repository (`terraform/live/sandbox/inference`, R1), the first apply of a
  live root. Approved scope: the sandbox stack with 1 L40S GPU node for at most 2 h, then teardown.
- **Date / region / platform:** 2026-10-11, apply 06:04:48 UTC, destroy 06:33:43–06:51:12 UTC,
  `eu-north1`. GPU node group `gpu-l40s-a` / `1gpu-8vcpu-32gb` × 1, preemptible; CPU node group
  `cpu-d3` / `4vcpu-16gb` × 2 (never created, see below); 64 GiB shared filesystem.
- **Versions:** provider `nebius/nebius` 0.6.67, Managed Kubernetes 1.36, drivers preset from
  `platform/regions.yaml`, device plugin release from `stacks/inference`.
- **Method:** `make apply STAGE=sandbox STACK=inference` with a git-ignored run override
  (run labels `nip-run`, `nip-ttl-expires`; the presets above), then `make destroy-plan` and
  `make destroy CONFIRM=yes`, then `scripts/leftovers.sh --stage sandbox` and direct CLI lists.
- **Cost:** about 47 min of resources (GPU node about 30 min). The portal's live run-rate showed
  0.806 USD/h for the running GPU node (preemptible list price, not a quote); the billed figure is
  not recorded yet.

## Results

| Check | Result |
|---|---|
| Cluster, filesystem, GPU node group | created: cluster in 5 min 33 s, GPU node group in 6 min 55 s, filesystem in 10 s |
| CPU node group | **not created**: the project's `compute.instance.non-gpu.vcpu` quota is 0 (`QuotaFailure ... limit "0"`). The apply was interrupted with one SIGINT; state was saved and the destroy plan covered everything |
| Portal cluster discovery | the `mk8s:<cluster>` connector found the cluster from `/mk8s/v1/clusters` with no configuration and answered with 6 items; it reports "waiting" while a cluster is provisioning and drops it after deletion (self-healing, no token in `.env`) |
| Least-privilege cluster reads | the portal's read-only service-account IAM token is accepted by the Kubernetes API as group `nebius:viewer`: lists succeed; writes, `secrets` and `services/proxy` are refused (403) |
| GPU telemetry | DCGM series for the L40S node at `read.monitoring.api.nebius.cloud/projects/<p>/service-provider/prometheus`, labelled `instance_id`, `mk8s_cluster_id`, `mk8s_node_group_id` |
| GPU visible to Kubernetes | **not shown**: the node reported 0 allocatable `nvidia.com/gpu` when the portal last read it; the run ended before the device plugin was confirmed ready. Open, re-check on the next run |
| Quota semantics (read with the admin CLI profile, 2026-10-11 ~07:00 UTC) | tenant `quota-allowance list`: an entry without `spec.limit` behaved as 0 (`QuotaFailure compute.instance.non-gpu.vcpu limit "0"` on the CPU node group); eu-north1 tenant limits read `compute.instance.gpu.l40s` 32, `compute.instance.preemptible.count` 8. Project-level entries for the same quotas had no `metadata.id`, `created_at` 1970-01-01, no `spec.limit` and no `status.state`, **yet the preemptible L40S node ran in that project**: such a placeholder does not cap the project, it draws on the tenant quota |
| Teardown | `Apply complete! Resources: 0 added, 0 changed, 7 destroyed.`; `leftovers.sh --stage sandbox` reports nothing; direct lists show 0 instances, disks, filesystems, clusters and allocations, and only the state bucket |

## Findings fixed from this run

- The default subnet is named `default-subnet-<suffix>`, not `default-subnet`, and CLI 0.12.285 drops
  `status.default`: `scripts/bootstrap-backend.sh` now discovers it.
- A disk's attachment is `status.readWriteAttachment` (singular): the portal's orphan rule and
  `leftovers.sh` read it.
- `leftovers.sh` passed `--page-size 1000`, which Compute rejects (999 at most), and hid the error;
  it now lists with `--all` and stops on any failed call instead of reporting "no leftovers".
- Copying the per-run labels into node metadata would recreate every node on each run: the stacks now
  leave `nip-run` and `nip-ttl-expires` on the node group only.

## What this does and does not show

- Shows: the R1 root applies and destroys cleanly in `eu-north1`; the portal discovers a cluster on
  its own and reads it with a viewer-only identity; GPU metrics reach the provider-metrics endpoint.
- Does not show: a CPU node layer (quota 0), a pod using the GPU, any serving or throughput figure.
  The next run needs the non-GPU vCPU quota raised first (`runbooks/deploy.md`).
