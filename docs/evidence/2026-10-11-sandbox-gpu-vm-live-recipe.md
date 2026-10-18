# sandbox/gpu-vm run (R10 GPU VM quickstart) — 2026-10-11

- **Kind:** run of this repository (`terraform/live/sandbox/gpu-vm`, R10), the first apply of this root.
  Approved within the owner's $10 cap for the live-recipe round.
- **Date / region / platform:** 2026-10-11, apply 17:47:28–17:48:14 UTC, destroy 18:02:38–18:04:18 UTC,
  `eu-north1`. `gpu-l40s-a` / `1gpu-8vcpu-32gb`, preemptible (follows the spot price); 200 GiB Network SSD
  boot disk from `ubuntu24.04-cuda13.0`; the project's default subnet; `public_ip = true` with
  `allowed_cidrs` = the operator's single egress address (/32) and `expose_api = true`, so the API could be
  probed from the operator's machine without SSH. A safety-net teardown was armed for 19:47:20 UTC
  (computed in UTC, 7195 s) and disarmed after the destroy.
- **Versions:** provider `nebius/nebius` 0.6.67, Terraform 1.16.3, vLLM `v0.31.0` (digest-pinned in
  `platform/versions.yaml`), `Qwen/Qwen2.5-1.5B-Instruct` at its pinned revision.
- **Method:** `source scripts/bootstrap-backend.sh sandbox gpu-vm`; a git-ignored `zz-run.auto.tfvars.json`
  (subnet, the L40S preset, preemptible, public address and allowlist, `expose_api`, SSH key, labels
  `nip-run=live-recipe-gpu-vm-2026-10-11` and a 3 h `nip-ttl-expires`); `make init plan apply destroy-plan destroy
  STAGE=sandbox STACK=gpu-vm`; `scripts/leftovers.sh --stage sandbox`. No SSH or exec into the VM: every
  check below is read-only from outside it.
- **Cost:** `recipes/finance/price.py` before the run: 0.7686 USD/h preemptible (VM 0.7492 + disk 0.0194),
  ≈ $1.15 for the 1.5 h budgeted; the portal's live run-rate showed the same 0.77 USD/h. About 17 min of
  resources ≈ $0.22 estimated (list price, not billed; the FOCUS export carries the billed figure).

## Results

| Check | Result |
|---|---|
| Plan | `Plan: 8 to add` (VM, two allocations, access group and its three rules, stage policy); every resource in the sandbox project |
| Apply | `Apply complete! Resources: 8 added`; VM created in 37 s, `RUNNING`, preemptible `on_preemption = STOP`, labels as passed plus `nip-stack`, `nip-stage`, `nip-region` |
| Boot (serial console, read through the portal's Logs API) | cloud-init finished 15.6 s after boot; `vllm.service` started by systemd |
| vLLM | `GET /v1/models` without a key: **HTTP 401 `{"error":"Unauthorized"}` at 17:56:24 UTC**, 8 min after the apply (image and model pulls); `/health`: 200. The server is up and refuses unauthenticated requests (runbook check 6) |
| Runbook checks 1–5 (`cloud-init status`, `nvidia-smi`, `docker logs`, `/v1/models` and a completion with the key) | **needs owner**: the key is only on the VM (`/etc/vllm/env`), and SSH into the VM was out of scope for this run |
| Check 7 (refused from outside the allowlist) | not run: no second egress address available |
| Teardown | `Plan: 0 to add, 0 to change, 8 to destroy.` (no provider override needed: no cluster in state), `Apply complete! Resources: 0 added, 0 changed, 8 destroyed.` (VM 1 min 33 s); `leftovers.sh --stage sandbox`: no leftovers |

## Portal (Nebius Estate)

| View | Result |
|---|---|
| Estate resources | VM, boot disk, both allocations and the access group listed with stage `sandbox`, stack `gpu-vm`, run `live-recipe-gpu-vm-2026-10-11`, TTL active, live root `terraform/live/sandbox/gpu-vm`; VM spec `gpu-l40s-a`, 1 GPU, 8 vCPU, 32 GiB, preemptible |
| Graph | subnet → VM, VM → disk, VM → both allocations. **Gap found and fixed:** no edge between the VM and its security group; the inventory mapper now reads `network_interfaces[].security_groups` (relation `secured-by`), seen live on the next sync |
| Overview | 1 GPU on running VMs (`gpu-l40s-a` × 1); run-rate (live) 0.77 USD/h, two priced lines, equal to `price.py` |
| Fleet | the VM under "Standalone VMs" with DCGM samples (0 % utilisation, 26 °C) from the Nebius observability agent the GPU image runs; no Kubernetes needed |
| Alerts | GpuIdle went pending for the VM at 17:50 and resolved at 17:56 when an evaluation saw no idle sample (vLLM start-up); per-VM title "GPU 0 on nip-sandbox-gpu-vm" |
| Logs | `sp_serial` lines for the VM (cloud-init, `vllm.service`) |

## Findings

- Fixed (portal): instance → security group edge (`secured-by`), test `securityGroups.test.ts`.
- Observed: a preemptible VM counts against `compute.instance.preemptible.count` only; the tenant's
  `compute.instance.gpu.l40s` ("for regular VMs") and `compute.instance.count` showed no usage while it ran.
- Observed: the default subnet has a public pool, so with `public_ip` the VM has egress without R7's NAT
  VM (which the non-GPU vCPU quota of 0 blocks in `eu-north1`).

## What this does and does not show

- Shows: R10 applies and destroys cleanly in `eu-north1`; vLLM comes up under systemd in about 8 min and
  enforces its API key; the portal attributes, prices and monitors a standalone GPU VM.
- Does not show: a model listing or completion with the key, `nvidia-smi`, the private (R7) path,
  throughput or latency.
