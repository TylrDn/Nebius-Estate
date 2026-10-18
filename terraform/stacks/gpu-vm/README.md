# `stacks/gpu-vm` — GPU VM quickstart (R10)

**Purpose.** One GPU VM that serves a model through an OpenAI-compatible API, with no Kubernetes:
the shortest path from an empty project to `POST /v1/chat/completions`. It follows the documented
building blocks of the [host-model quickstart](https://docs.nebius.com/compute/quickstart-host-model#create-the-vm)
and [container VMs](https://docs.nebius.com/compute/virtual-machines/containers#how-to-check-that-a-custom-image-is-deployed)
(GPU image family, VM-managed boot disk, a cloud-init user, a systemd service that starts the
server at boot, `docker logs` to check it), with this repository's pinned vLLM image as the server.
The quickstart itself serves Ollama and Open WebUI from a Python environment, and container VMs are
created in the web console only; neither path is scriptable as documented, so this stack is the
Terraform equivalent, not a copy.

**Used by.** [S3](../../../solutions/S3-llm-api-token-factory/README.md) LLM API without GPUs (alt.: the self-host counterpart), [S8](../../../solutions/S8-batch-inference/README.md) batch inference ([all solutions](../../../solutions/README.md)).

## What it builds

| Resource | Notes |
|---|---|
| GPU VM | `<name>` (default `nip-<stage>-gpu-vm`); platform and preset from [`platform/regions.yaml`](../../../platform/regions.yaml) unless overridden; regular, or preemptible where the stage allows it |
| Boot disk | VM-managed `<name>-boot`, Network SSD, 4 KiB blocks, 200 GiB, from the platform's GPU image family (`ubuntu24.04-cuda13.0` on every platform today); deleted with the VM |
| Private address | allocation `<name>` in `subnet_id`: the address survives a VM replacement |
| Public address | `public_ip` only: allocation `<name>-public` plus security group `<name>-access` (SSH, and the API with `expose_api`, from `allowed_cidrs`; other ingress denied at priority 400; stateful egress) |
| vLLM service | cloud-init writes `/usr/local/sbin/nip-vllm` and `vllm.service`: `docker run --gpus all` of `workloads.vllm` (pinned by digest) serving `workloads.<model>` at its pinned revision, API on `127.0.0.1:8000` |
| Filesystem attach | `existing_filesystem_id` (R8): attached read-write under mount tag `nip-fs`, mounted at `/mnt/fs` (virtiofs, `nofail`); the model cache moves there |

The API key is generated on the VM at first start (`/etc/vllm/env`, root only), so it is never in
user data, the plan or state.

**Why these choices, with the docs behind them:**

- **Image per platform.** GPU VMs boot from the GPU image families; `ubuntu24.04-cuda13.0` is the
  recommended image on every GPU platform, and the B200/B300 and RTX PRO 6000 platforms list no
  CUDA 12 image at all ([images for GPU VMs](https://docs.nebius.com/compute/storage/boot-disk-images#images-for-gpu-vms)).
  The B200 1-GPU preset needs driver 580.x, which is the cuda13.0 family's driver
  ([components](https://docs.nebius.com/compute/storage/boot-disk-images#gpu-drivers-and-other-components)).
  A stable family keeps driver and CUDA versions fixed across disks created at different times
  ([image family](https://docs.nebius.com/compute/storage/boot-disk-images#image-family)). The stack
  maps `drivers_preset` to the family and refuses an `image_family` override the docs do not list
  for the platform.
- **Nothing installed at boot.** The GPU images include the NVIDIA Container Toolkit
  ([components](https://docs.nebius.com/compute/storage/boot-disk-images#gpu-drivers-and-other-components))
  and the default boot images come with Docker
  ([Docker subnet conflict](https://docs.nebius.com/compute/virtual-machines/docker-subnet-conflict)),
  so the only downloads are the vLLM image (Docker Hub) and the model (Hugging Face).
- **Started by systemd**, as the quickstart does for its server
  ([start automatically](https://docs.nebius.com/compute/quickstart-host-model#make-open-webui-start-automatically)),
  so a stopped and restarted VM (including a preempted one) serves again without a login.
- **Private by default.** The quickstart and the create guide both offer a VM without a public
  address, reached through a WireGuard jump server
  ([create a VM](https://docs.nebius.com/compute/virtual-machines/create#create-a-vm),
  [WireGuard](https://docs.nebius.com/compute/virtual-machines/wireguard)). Here the API also binds
  to loopback, so even inside the VPC it is reached through an SSH tunnel unless `expose_api`.
- **Allowlist, never 0.0.0.0/0.** Every network has a default security group that allows all
  ingress at priority 500 ([default groups](https://docs.nebius.com/vpc/security-groups/overview#default-security-groups));
  the access group's DENY at 400 wins over it ([priorities](https://docs.nebius.com/vpc/security-groups/overview#security-rule-priorities)),
  the same pattern as R7.
- **Reserved addresses.** A dynamic public address is returned to the pool after a VM has been
  stopped for an hour, a static one on deletion; an allocation is kept until it is deleted
  ([public IP addresses](https://docs.nebius.com/compute/virtual-machines/network#public-ip-addresses),
  [allocations](https://docs.nebius.com/vpc/overview#allocation)). A preempted VM is a stopped VM
  ([preemptible](https://docs.nebius.com/compute/virtual-machines/preemptible#how-to-continue-working-with-a-stopped-preemptible-vm)).
- **Preemptible settings.** Preemptible VMs take only `recovery_policy = "FAIL"` and
  `on_preemption = "STOP"`, plus either a pricing policy or `follows_spot_price`
  ([create a preemptible VM](https://docs.nebius.com/compute/virtual-machines/preemptible#how-to-create-a-preemptible-vm));
  every GPU platform supports them ([VM types](https://docs.nebius.com/compute/virtual-machines/types#compatibility-with-vm-types)).
  Compute sends SIGTERM 60 s before it stops the VM; volumes are kept. The type of an existing VM
  cannot be changed, so treat a change of `preemptible` as a new VM (review the plan).
- **Filesystem mount** by tag as `virtiofs`, with `nofail` so the VM still boots if the filesystem is
  gone ([shared filesystems](https://docs.nebius.com/compute/storage/use#shared-filesystems)).

## Inputs that matter

| Variable | Default | Meaning |
|---|---|---|
| `subnet_id` | — (required) | R7 `subnet_id`; the VM needs egress (R7's NAT) to pull the image and the model |
| `ssh_public_key` | — (required) | for `admin_user` (`nip-admin`; `root` and `admin` are reserved by Compute) |
| `platform` / `preset` | `null` = region default / its 1-GPU preset | eu-north1: `gpu-h100-sxm` / `1gpu-16vcpu-200gb`; the cheapest eu-north1 option is `gpu-l40s-a` / `1gpu-8vcpu-32gb`. A multi-GPU preset sets vLLM's tensor parallelism to its GPU count |
| `image_family` | `null` = from `drivers_preset` | override only with a family the docs list for the platform |
| `preemptible` / `spot_pricing_policy_id` | `false` / `null` (follow the spot price) | sandbox only (`allow_preemptible_serving`); the plan refuses it in staging and prod |
| `security_group_ids` | `[]` | R7 `security_group_ids` |
| `public_ip` / `allowed_cidrs` | `false` / `[]` | a public address needs an allowlist in every stage, each entry /8 or narrower (never `0.0.0.0/0` or its `/1` halves); staging and prod refuse RFC 5737 ranges. R7's workload subnet cannot hold public addresses, so `public_ip` needs a subnet with a public pool |
| `expose_api` | `false` | publish the API on the VM's interfaces (VPC, and the allowlist with `public_ip`) instead of loopback |
| `model` | `qwen2.5-1.5b-instruct` | a `workloads` key in [`platform/versions.yaml`](../../../platform/versions.yaml) with a Hugging Face source and pinned revision |
| `existing_filesystem_id` | `null` | R8 `filesystem_id` |
| `boot_disk_size_gib` | 200 | image plus model cache; raise it for large models without a filesystem |
| `labels` | `nip-owner = platform` (plus the deprecated `nip-env = gpu-vm`, [`docs/naming.md`](../../../docs/naming.md#5-labels)); the stack adds `nip-stack = gpu-vm`, `nip-stage` and `nip-region` (`main.tf:12`), never passed by hand | `nip-run` always; `nip-ttl-expires` in sandbox |

## Outputs and composition

`instance_id`, `private_ip`, `public_ip` (null unless `public_ip`), `platform`, `model`, and
`how_to_reach`: the SSH tunnel command, the base URL, the command that prints the API key, and the
log command. Apply order: network (R7), data (R8) if a filesystem is wanted, then this stack.
Live roots exist for sandbox and staging (`max_gpu_nodes.gpu-vm = 1` in `platform/stages.yaml`); prod
caps it at 0 and has no root: production serving is R1.

```bash
cd terraform/live/<stage>/gpu-vm      # from inside the VPC / WireGuard, or an allowlisted address
$(terraform output -json how_to_reach | jq -r .tunnel) &
KEY=$(eval "$(terraform output -json how_to_reach | jq -r .api_key)")
curl -s http://127.0.0.1:8000/v1/models -H "Authorization: Bearer $KEY"
```

## Quotas and cost

**Quotas** ([Compute quotas](https://docs.nebius.com/compute/resources/quotas-limits#gpu-virtual-machines)):

- One regular GPU VM (default quota 12 per region; preemptible 8; `eu-north2` 0) and one GPU of the
  platform. GPU defaults for regular VMs without reservations: H100 and L40S 32 in `eu-north1`;
  B300 32 in `uk-south1`, `eu-west2`, `us-north1`; **B200 0** in `us-central1` and `me-west1`;
  RTX PRO 6000 0 in `us-central1`. Request quota before planning on a 0.
- The VM's vCPUs and RAM come with its GPU preset. "Total vCPUs across non-GPU VMs" is a separate
  quota, **0 by default in `eu-north1` and `us-central1`**
  ([non-GPU VMs](https://docs.nebius.com/compute/resources/quotas-limits#non-gpu-virtual-machines)):
  it does not cover this VM, but it does block R7's CPU NAT VM, which this VM needs for egress.
- One Network SSD disk (200 GiB of the 4 TiB `eu-north1` default) and, with R8, one shared filesystem.
- The quota API omits every limit (`spec.limit`; [evidence](../../../docs/evidence/2026-10-11-portal-live-read-only.md));
  treat an omitted limit as 0 and read the real one in the console
  ([view quotas](https://docs.nebius.com/overview/quotas#view-quotas)). The
  [capacity advisor](https://docs.nebius.com/compute/virtual-machines/capacity-advisor) shows
  availability against quota.

**Cost shape.** Compute bills a running VM per second for GPUs, vCPUs and RAM; a stopped VM is not
charged for them, but its disks are
([Compute pricing](https://docs.nebius.com/compute/resources/pricing#virtual-machines-gpus-vcpus-ram),
[volumes](https://docs.nebius.com/compute/resources/pricing#volumes)). Virtual Networks is free of
charge ([VPC pricing](https://docs.nebius.com/vpc/resources/pricing)). Preemptible GPUs follow a
dynamic spot price or a pricing-policy cap
([spot pricing](https://docs.nebius.com/signup-billing/pricing-policy#how-spot-pricing-works)).

The live billing calculator prices it; dated observations, list prices, **not quotes**
([pricing and billing](../../../docs/solutions/pricing-and-billing.md)):

| Shape (eu-north1) | Observed 2026-10-11 | Note |
|---|---|---|
| `gpu-l40s-a` `1gpu-8vcpu-32gb` | 1.5484 USD/h | $1.35 GPU + 8 vCPU + 32 GiB RAM at the pricing page's rates |
| `gpu-h100-sxm` `1gpu-16vcpu-200gb` (default) | 4.5 USD/h | equal to the $4.50 GPU-hour list price, which suggests it covers this 1-GPU preset's vCPU and RAM; observed for this one preset only, not documented ([evidence](../../../docs/evidence/2026-10-11-portal-live-read-only.md#pricing)) |
| 200 GiB Network SSD boot disk | ~0.02 USD/h | billed while the VM exists, running or stopped |

A sandbox day (8 h) on the default H100 is about 36 USD, on L40S about 12 USD, plus the disk and R7's
NAT VM. Re-price before a customer conversation.

## Validate

- Static: `terraform test` (mocked): defaults from `regions.yaml`, private by default, image digest
  and model revision from `versions.yaml`, preemptible settings and the stage gate, allowlist
  required for a public address and never `0.0.0.0/0`, image family per platform (B200/B300 on
  `ubuntu24.04-cuda13.0`, CUDA 12 refused there), filesystem attach and mount, cloud-init is valid
  YAML with no key in it. The real stage-policy module runs in `tests/policy.tftest.hcl`.
- Live ([`runbooks/gpu-vm.md`](../../../runbooks/gpu-vm.md#validate)): `sudo docker logs vllm`
  shows the server up, `nvidia-smi` in the VM shows the GPU, `/v1/models` lists the model and a chat
  completion answers through the tunnel.
- Load: the R1 method through the tunnel, `tests/load/bench.sh --target r10 --base-url
  http://127.0.0.1:8000 --model <repo> [--vantage in-vpc]` (same sweep, bars and JSON as R1,
  [`tests/load/README.md`](../../../tests/load/README.md); `results/bench-r10.json`). The key is only
  readable over SSH, by design (it is generated on the VM and never in state): export it first with
  the `how_to_reach.api_key` command (Outputs, above) as `BENCH_API_KEY`. Not yet run.

## Evidence

Run live once, 2026-10-11 ([evidence](../../../docs/evidence/2026-10-11-sandbox-gpu-vm-live-recipe.md)): preemptible L40S
in `eu-north1`, applied and destroyed cleanly; vLLM up under systemd in about 8 min and refusing requests
without the key (401). Not yet shown: a completion with the key and `nvidia-smi` (need SSH; the owner's step).
The H100 price above is a calculator read, not a run.

## Teardown

`make destroy-plan destroy STAGE=<stage> STACK=gpu-vm CONFIRM=yes` deletes the VM, its boot disk,
the allocations and the access group. An attached R8 filesystem is only detached; the model cache on
it stays. Delete rather than stop a VM you no longer need: a stopped VM still counts against quotas
and its disk is still billed
([quota recommendations](https://docs.nebius.com/compute/resources/quotas-limits#quota-usage-recommendations)).
There is no prod root (the stage caps the stack at 0 GPUs).

## Limits

One VM, no autoscaling, no load balancer, no TLS: the API is plain HTTP behind an SSH tunnel or an
allowlist. The first start pulls the vLLM image and the model, which takes minutes; the API answers
only after that (`journalctl -u vllm`). Gated Hugging Face models need a token, which this stack does
not handle. vLLM's own flags (entrypoint `vllm serve`, `VLLM_API_KEY`) come from the pinned image, not
from the Nebius docs.

## Upstream references

[Host an LLM on a VM](https://docs.nebius.com/compute/quickstart-host-model) ·
[container VMs](https://docs.nebius.com/compute/virtual-machines/containers) ·
[create a VM](https://docs.nebius.com/compute/virtual-machines/create) ·
[boot disk images](https://docs.nebius.com/compute/storage/boot-disk-images) ·
[preemptible VMs](https://docs.nebius.com/compute/virtual-machines/preemptible) ·
[VM types and presets](https://docs.nebius.com/compute/virtual-machines/types#presets-for-gpu-platforms) ·
[Compute quotas](https://docs.nebius.com/compute/resources/quotas-limits) ·
[vLLM image](https://hub.docker.com/r/vllm/vllm-openai/tags).
