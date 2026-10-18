# sandbox/inference R1-only sessions (R1, R10 plan, retry with R14=0) — 2026-10-13

- **Kind:** run of this repository (commit `d434b42`, `scripts/live/run-r1.sh` with `R10_TOO=1`): the
  first R1-only session ([runbook](../../runbooks/live-session.md#morning-checklist)), R1 on run profile
  `l40s-gpu-only` with its own 64 GiB filestore, no R8 or R12 root, R14's Alertmanager on; then R10's
  plan. Seventh apply of `terraform/live/sandbox/inference`. Started by the owner. A retry at commit
  `2db5124` (eighth apply) is in [Retry (R14=0)](#retry-r140).
- **Date / region / platform:** 2026-10-13, session 13:38–15:01 UTC (09:38–11:01 EDT), `eu-north1`.
  `gpu-l40s-a` / `1gpu-8vcpu-32gb` × 1, preemptible, `cpu_node_count = 0`, drivers preset `cuda13.0`,
  Kubernetes `1.36`. Run ticket `live-20261013-r1`; R1 TTL 16:39:47Z, job armed before the apply.
- **Versions:** provider `nebius/nebius` 0.6.67, `hashicorp/helm` 3.3.0, `hashicorp/kubernetes` 3.3.0,
  `gavinbunney/kubectl` 1.19.0; CSI chart `csi-mounted-fs-path` 0.1.10; Marketplace releases
  `nebius/nvidia-device-plugin`, `nebius/nebius-observability-agent`, `nebius/grafana-and-prometheus`
  (versions as pinned in [`platform/versions.yaml`](../../platform/versions.yaml) at that commit).
- **Method:** `run-r1.sh`: `run2-0-preflight` (`make preflight PROFILE=l40s-gpu-only`), `run2-1-reprice`
  (`price.py --contract` on `recipes/finance/examples/inference-l40s-r1-only.json`), `run2-2c-inference`
  (`make plan`, `make ttl-teardown`, `make apply` through `scripts/tf-run.sh`), on the failure straight to
  `run2-9-evidence` and `run2-10-teardown`; then `run3-2-plan` (R10), `run3-5-teardown`,
  `run2-11-leftovers` (`make leftovers-stage STAGE=sandbox`).
- **Cost:** $0.806/h list (preemptible L40S $0.7492/h + 512 GiB boot disk + 64 GiB filestore, re-priced
  13:39Z) for about 1.2 h (apply to destroy end) ≈ $0.97 estimated; billed figure pending the FOCUS
  export. The retry's cost is in its own table.
- **Source:** the step logs under `.cache/live/logs/` (local, not committed: they carry ids) and the
  session summary; the in-cluster and portal observations are the owner's record (screenshots kept
  locally, not committed).

## Results

| Step | Result |
|---|---|
| Preflight | **GO**, 1 warning (tenant non-GPU vCPU limit 0, not needed by this plan); quota demand fits; capacity `LOW 2/8` for the preset (a tenant view) |
| Re-price | PASS: preemptible L40S $0.7492/h, same as 2026-10-12; R1-only footprint $0.806/h |
| Plan | 12 to add: cluster, node group, filestore, filestore CSI and its two StorageClass annotations, device plugin, o11y agent and `grafana-and-prometheus` releases, Grafana password, two policy checks |
| Apply: infrastructure | filesystem 4 s, cluster 5 min 14 s, GPU node group 4 min 26 s; the L40S node went Ready (owner's record) |
| Apply: device plugin release | created after **33 min 53 s** (on 2026-10-12 the whole apply took 9 min); why it took that long is unknown |
| Apply: `grafana-and-prometheus` release | **stuck**: `module.stack.module.o11y[0].nebius_applications_v1alpha1_k8s_release.prometheus[0]` still creating after 59 min; the step failed after 69 min. The Alertmanager StatefulSet's PVC `storage-grafana-and-prometheus-alertmanager-0` had no storage class set, so it took the cluster default `csi-mounted-fs-path-sc` (promoted to default by the filestore CSI module) and never bound: "didn't find available persistent volumes to bind". The `prometheus-server` PVC, pinned to `compute-csi-default-sc` ([R1-9](../upstream-findings.md#r1-inference-and-managed-kubernetes)), bound. Grafana's `download-dashboards` container was in back-off (a separate cause, not diagnosed). The release resource has no `timeouts`, so nothing ended the wait ([R1-20](../upstream-findings.md#2026-10-13-findings-from-this-repositorys-own-runs)) |
| Interrupt | one SIGINT to the local `terraform` (through `tf-run.sh`): it stopped the wait, wrote state for what had completed and released the lock (`resource creation failed: operation wait: context canceled`); no orphan |
| Evidence step | session mode `r1-only`; no GPU layer, vLLM or R14 step ran |
| R1 teardown | PASS in 11 min: `make destroy-plan` 12 to destroy (the half-created release included), node group 7 min 32 s, cluster 2 min 43 s; `make leftovers STACK=inference` clean. The PVC pre-delete was skipped (no kubeconfig file in the session); no `pvc-*` disk was left |
| R10 plan | **fail**, nothing created: `run3-2-plan` had no `subnet_id` in an R1-only session ("No value for required variable subnet_id"); run 2's bootstrap exports it, R10's did not. A harness defect, not a Nebius finding |
| R10 teardown | state empty (verified), `make leftovers STACK=gpu-vm` clean, TTL job cancelled |
| Stage gate | `make leftovers-stage STAGE=sandbox`: exit 0, clean; no TTL job left |
| Verdict | **PARTIAL**: torn down and clean, but the R1 apply and the R10 plan failed |

**The portal during the session** (Nebius Estate, read-only; owner's record): it showed the new cluster,
the pending Alertmanager pod in Workloads with the scheduler's exact reason (the unbound PVC), and the
L40S node in Fleet. That is the same diagnosis the owner made with `kubectl`, reached from the portal.

**CLI token lifetime** (owner's record and the `refresh-login` step logs, 03:06–03:20Z): four fresh
logins after removing the cached token each returned the same `expires_at` (04:17:39–40Z); a refresh, a
logout and a private browser window did not change it until it passed. The token issued at 13:38Z
expired 12 h later (01:38Z on 10-14), so the session itself was not affected
([R2-17](../upstream-findings.md#2026-10-13-findings-from-this-repositorys-own-runs)).

## Retry (R14=0)

A second R1-only session at commit `2db5124`: `run-r1.sh` with `R14=0` (no Alertmanager, no data-source
Secret named; the R14 step reports SKIP) and `R5=0`, R10 not run. Started 15:06Z (11:06 EDT): preflight
GO (1 warning), re-price PASS ($0.7492/h at 15:07Z), plan 12 to add with
`TF_VAR_alertmanager_enabled=false`, TTL job armed before the apply. Source: the step logs and the
owner's record; the operator-host bench is committed scrubbed as
[`bench-r1-operator-host.json`](../../results/2026-10-13/bench-r1-operator-host.json).

| Step | Result |
|---|---|
| Apply | **PASS in 8 min**: "Apply complete! Resources: 12 added" (the `grafana-and-prometheus` release created without Alertmanager) |
| 00-nodes | pass |
| 01-gpu | pass: 1 allocatable GPU, **NVIDIA L40S, driver 580.173.02, 46,068 MiB**; the 2026-10-12 DaemonSet false positive did not recur (the fix held) |
| 02-interconnect | pass: `nccl-tests` image on the single GPU, with the new pod wait (NCCL plumbing only: busbw is 0 on one GPU, [R1-7](../upstream-findings.md#r1-inference-and-managed-kubernetes)) |
| 03-storage | pass: fio 4 jobs, **write 2,228 MiB/s, read 2,423 MiB/s** (floor 450 MiB/s), workload PVC Bound on R1's own 64 GiB filestore |
| 04-workload (vLLM) | pass: `Qwen/Qwen2.5-1.5B-Instruct` on `vllm/vllm-openai:v0.31.0` (digest-pinned), first request 393 ms |
| 05-load, in cluster | **fail**: the bench Job's pod could not reach Hugging Face for the tokenizer (`[Errno 101] Network is unreachable` in `huggingface_hub` `repo_utils`) and sat on its first request; stopped after about 20 min (SIGTERM to `05-load.sh`) so teardown could proceed. No figure ([R1-21](../upstream-findings.md#2026-10-13-findings-from-this-repositorys-own-runs), ours) |
| 05-load, from the operator host | **pass** (table below): the same `tests/load/bench.sh` sweep, `--base-url` through `kubectl port-forward svc/vllm`, vantage `operator-host-port-forward`, `BENCH_USD_PER_HOUR=0.7492` from the re-price. `--target r10` was used only for its generic base-url path, so the raw step is named `bench-r10`; it measured R1's vLLM |
| R14 acceptance | SKIP (`R14=0`: Alertmanager and the data-source Secret left out, see R1-20) |
| Teardown | PASS in 11 min: "Plan: 0 to add, 0 to change, 12 to destroy", then `make leftovers STACK=inference`: no leftovers for `nip-stack=inference` (state bucket excluded by design) |
| Stage gate | `make leftovers-stage STAGE=sandbox`: exit 0, clean; no leftovers for `nip-stage=sandbox`; no TTL job left (inference, ml-services, data, gpu-vm) and no process left |
| Verdict | "Done 11:59 EDT. VERDICT: PARTIAL: torn down and clean, but a step failed or was skipped": the in-cluster 05-load failed (R1-21) and R14 was skipped by `R14=0`; R1 serving was measured from the operator host instead |
| Cost | apply start 15:07Z to teardown end about 15:58Z: 0.85 h × $0.806/h ≈ $0.69 estimated; billed figure pending the FOCUS export |

**Load, operator host** (`tests/load/README.md` method: 256 input / 128 output tokens, 200 prompts per
level after 10 warm-up, chat completions; bar E2E p99 ≤ 10 s and every request answered; status
**pass**, 200/200 at each level, `max_passing_concurrency` 32, `failed_levels` []):

| Concurrency | Output tok/s | Req/s | TTFT p50 / p99 (ms) | TPOT p50 (ms) | E2E p99 (ms) | $ per 1M output tokens (list, preemptible) |
|---|---|---|---|---|---|---|
| 1 | 152.96 | 1.20 | 143.13 / 150.37 | 5.45 | 845.31 | 1.3606 |
| 8 | 1,145.37 | 8.95 | 153.86 / 421.46 | 5.73 | 1,146.79 | 0.1817 |
| 32 | 3,695.81 | 28.87 | 168.70 / 679.61 | 6.29 | 1,470.22 | 0.0563 |

Measured through a port-forward from the operator host, so every latency includes the tunnel (a
conservative figure), and throughput is what one client host pushed through it. It is not an
in-cluster figure. Cost per token assumes the node is fully used (`utilisation` 1.0) at the re-priced
preemptible rate.

## What this does and does not show

- Shows (session 1): the R1-only session path end to end on a failure: preflight, re-price, plan and TTL
  job, a failed apply ended with one SIGINT and state intact, teardown and a clean stage gate; that the
  Alertmanager PVC does not bind when the filestore class is the cluster default; that the portal surfaces
  a pending pod's scheduling reason.
- Shows (retry): R1 applied in 8 min without Alertmanager; GPU, driver, NCCL plumbing and the filestore
  validated on the node; vLLM served Qwen2.5-1.5B; the **first measured R1 serving sweep** on 1
  preemptible L40S, passing the 10 s E2E p99 bar at 1, 8 and 32 concurrent, with throughput and list cost
  per 1M output tokens. R1 moves to Measured on this evidence.
- Does not show: an in-cluster load figure (the bench pod had no route to Hugging Face, R1-21); latency
  without the port-forward; anything multi-GPU or a model larger than 1.5B; R14 acceptance (skipped);
  the cause of session 1's 34 min device-plugin release or the Grafana dashboard back-off; R10 (its plan
  never ran).
