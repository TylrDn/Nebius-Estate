# GPU VM runbook — R10 GPU VM quickstart

Deploy, reach, validate and remove one GPU VM that serves a model through vLLM's OpenAI-compatible
API. The stack is [`terraform/stacks/gpu-vm`](../terraform/stacks/gpu-vm/). First live run:
[2026-10-11](../docs/evidence/2026-10-11-sandbox-gpu-vm-live-recipe.md) (apply, boot, 401 without the key,
teardown; checks 1–5 still need SSH).

Upstream references: [host an LLM on a VM](https://docs.nebius.com/compute/quickstart-host-model),
[container VMs](https://docs.nebius.com/compute/virtual-machines/containers),
[boot disk images](https://docs.nebius.com/compute/storage/boot-disk-images#images-for-gpu-vms),
[preemptible VMs](https://docs.nebius.com/compute/virtual-machines/preemptible).

## Before you start

- **Stage policy.** The stage must grant the stack a GPU VM: `max_gpu_nodes.gpu-vm` in
  [`platform/stages.yaml`](../platform/stages.yaml) is 1 in sandbox and staging and 0 in prod, so
  prod has no `terraform/live/prod/gpu-vm` root (prod serves through R1). A stage set to 0 stops the
  plan with "caps gpu_node_count for gpu-vm at 0". Preemptible is sandbox only.
- **Quota** in the console (Administration → Limits → Quotas;
  [view quotas](https://docs.nebius.com/overview/quotas#view-quotas)): one GPU VM and one GPU of the
  platform ([GPU VM defaults](https://docs.nebius.com/compute/resources/quotas-limits#gpu-virtual-machines);
  B200 is 0 by default). The quota API does not return limits; treat a missing one as 0.
- **Network.** R7 applied ([`network.md`](network.md)) with NAT on: the VM pulls the vLLM image from
  Docker Hub and the model from Hugging Face at first start, and R7's workload subnet has no other
  egress. R7's NAT VM needs non-GPU vCPU quota, which is 0 by default in `eu-north1`
  ([non-GPU VMs](https://docs.nebius.com/compute/resources/quotas-limits#non-gpu-virtual-machines)).
- **Access path.** Either R7's WireGuard bastion (private VM, the default) or a public address with
  an allowlist of your egress CIDRs.
- **SSH key** for `nip-admin` (`root` and `admin` are reserved by Compute;
  [create a VM](https://docs.nebius.com/compute/virtual-machines/create#create-a-vm)).

## Deploy

| # | Command | Expect |
|---|---|---|
| 1 | `source scripts/bootstrap-backend.sh <stage> gpu-vm` | `terraform/live/<stage>/gpu-vm/backend.hcl` and credentials |
| 2 | `net=terraform/live/<stage>/network; export TF_VAR_subnet_id="$(terraform -chdir=$net output -raw subnet_id)" TF_VAR_security_group_ids="$(terraform -chdir=$net output -json security_group_ids)"` | R7's subnet and workload group |
| 3 | `export TF_VAR_ssh_public_key="$(cat ~/.ssh/id_ed25519.pub)"`; sandbox: `export TF_VAR_labels='{"nip-owner":"platform","nip-run":"<ticket>","nip-ttl-expires":"<RFC 3339 UTC>"}'` | the plan refuses sandbox without a TTL |
| 4 | optional: `export TF_VAR_existing_filesystem_id="$(terraform -chdir=terraform/live/<stage>/data output -raw filesystem_id)"` | the model cache lives on R8's filesystem |
| 5 | optional, cheapest eu-north1 GPU: `export TF_VAR_platform=gpu-l40s-a TF_VAR_preset=1gpu-8vcpu-32gb` | default is the region's platform in `regions.yaml` (eu-north1: H100) |
| 6 | `make init plan STAGE=<stage> STACK=gpu-vm` | one allocation, one VM with a managed boot disk from `ubuntu24.04-cuda13.0`; with `public_ip`, a public allocation and the `-access` group |
| 7 | `make apply CONFIRM=yes STAGE=<stage> STACK=gpu-vm` | the VM boots; vLLM is up after the image and model downloads (minutes) |

If creation fails with not enough resources, the platform has no free capacity in the region right
now ([not enough resources](https://docs.nebius.com/compute/virtual-machines/not-enough-resources#error-creating-a-vm));
check the [capacity advisor](https://docs.nebius.com/compute/virtual-machines/capacity-advisor) or
pick another platform from `regions.yaml`.

## Reach the API

The API listens on `127.0.0.1:8000` on the VM. From a machine that can reach the VM's address (a
WireGuard peer of R7's bastion for a private VM, an address in `allowed_cidrs` for a public one):

```bash
out=terraform/live/<stage>/gpu-vm
$(terraform -chdir=$out output -json how_to_reach | jq -r .tunnel) &       # ssh -N -L 8000:127.0.0.1:8000 ...
KEY=$(eval "$(terraform -chdir=$out output -json how_to_reach | jq -r .api_key)")
export OPENAI_BASE_URL=http://127.0.0.1:8000/v1 OPENAI_API_KEY=$KEY      # any OpenAI client
```

The key is generated on the VM at first start and kept in `/etc/vllm/env` (root only); it is not in
Terraform state. To rotate it: `sudo rm /etc/vllm/env && sudo systemctl restart vllm`.

`expose_api = true` publishes the port on the VM's interfaces instead: other VMs in the VPC (as their
security groups allow) and, with `public_ip`, the allowlist reach `http://<ip>:8000/v1` directly. The
traffic is plain HTTP; prefer the tunnel outside the VPC.

## Validate

Run on the VM (`ssh nip-admin@<ip>`), then through the tunnel:

| # | Check | Expect |
|---|---|---|
| 1 | `cloud-init status --wait` | `status: done` |
| 2 | `nvidia-smi` | the preset's GPUs, driver 580.x on `ubuntu24.04-cuda13.0` ([components](https://docs.nebius.com/compute/storage/boot-disk-images#gpu-drivers-and-other-components)) |
| 3 | `systemctl is-active vllm` and `sudo docker logs vllm` | `active`; the server log ends with the API listening on port 8000 ([check a container](https://docs.nebius.com/compute/virtual-machines/containers#how-to-check-that-a-custom-image-is-deployed)) |
| 4 | `curl -s 127.0.0.1:8000/v1/models -H "Authorization: Bearer $KEY"` | the model id, e.g. `Qwen/Qwen2.5-1.5B-Instruct` |
| 5 | `curl -s 127.0.0.1:8000/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"model":"Qwen/Qwen2.5-1.5B-Instruct","messages":[{"role":"user","content":"Say ok"}],"max_tokens":8}'` | a completion |
| 6 | without the header | `401`: the API refuses requests without the key |
| 7 | with `public_ip`: `nc -vz <public ip> 8000` from an address outside `allowed_cidrs` | refused or timed out |

Record the run (date, platform, preset, region, image digest, model revision, outputs of 2–5) in
`docs/evidence/` and flip the evidence row from "not yet run".

## Preemption

A preemptible VM gets SIGTERM 60 s before Compute stops it; disks and allocations are kept
([preemptible](https://docs.nebius.com/compute/virtual-machines/preemptible#how-to-continue-working-with-a-stopped-preemptible-vm)).
Start it again (`nebius compute instance start --id <instance_id>`;
[stop and start](https://docs.nebius.com/compute/virtual-machines/stop-start#how-to-stop-and-start-vms-manually));
`vllm.service` brings the server back with the cached image and model. Clients see connection
errors while it is stopped: preemptible serving is for sandbox and batch, never for a customer
endpoint.

The portal's PreemptibleNodeLost alert does not fire for a planned teardown: when the VM's node group
or cluster is deleting or gone, or its TTL (`nip-ttl-expires`, its own or its cluster's) has passed.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `journalctl -u vllm` stuck on `docker pull` or the model download | no egress: R7 NAT off or down ([`network.md`](network.md)); Docker Hub or Hugging Face rate limits |
| vLLM exits with a CUDA initialization error (802) | rare on GPU VMs; restart the Fabric Manager, the GPUs or the VM ([CUDA init error](https://docs.nebius.com/compute/virtual-machines/cuda-init-error#solutions)) |
| VM cannot reach an address in `172.17.0.0/16` | Docker's default bridge ([Docker subnet conflict](https://docs.nebius.com/compute/virtual-machines/docker-subnet-conflict)); R7 refuses that range for its network |
| `/mnt/fs` empty, vLLM waiting | the filesystem was not attached or its tag changed; `findmnt /mnt/fs`, `grep nip-fs /etc/fstab` ([shared filesystems](https://docs.nebius.com/compute/storage/use#shared-filesystems)) |
| out of GPU memory at start | the model does not fit the preset: a larger preset, or `vllm_extra_args = ["--max-model-len", "8192"]` |

## Teardown

```bash
make destroy-plan STAGE=<stage> STACK=gpu-vm                # review the printed summary first
make destroy CONFIRM=yes STAGE=<stage> STACK=gpu-vm
```

Deletes the VM, its boot disk, both allocations and the access group. An attached R8 filesystem is
detached, not deleted; remove `/mnt/fs/vllm-cache` from it if the cache is no longer wanted. Delete,
do not just stop: a stopped VM still holds quota and its disk is still billed
([quota recommendations](https://docs.nebius.com/compute/resources/quotas-limits#quota-usage-recommendations)).
Then check for residue with `make leftovers STACK=gpu-vm` and `NEBIUS_PROJECT_ID` set to the stage's project; adding `--stage` would list the whole stage, labelled or not (`scripts/leftovers.sh:8-9`) ([`teardown.md`](teardown.md)).
