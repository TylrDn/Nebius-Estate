# `stacks/network` — Private network perimeter (R7)

**Purpose.** A VPC network whose workload nodes hold no public address: egress leaves through a
custom NAT gateway with a stable public IP; operators enter through an optional, allowlisted
WireGuard bastion. R1 and R3 clusters run inside it.

**Used by.** [S1](../../../solutions/S1-private-llm-serving-vpn/README.md) private LLM serving with VPN, [S6](../../../solutions/S6-multi-region-dr/README.md) multi-region DR, [S7](../../../solutions/S7-eu-data-residency/README.md) EU data residency ([all solutions](../../../solutions/README.md)).

## What it builds

| Resource | Notes |
|---|---|
| Pool + network | private pool from `cidr` (RFC 1918, /12–/18, never overlapping Docker's `172.17.0.0/16`) |
| Workload subnet | first half of `cidr`; no public pool; route table when NAT is on |
| Edge subnet | last /24 of `cidr`; NAT and bastion; never on the route table (routing loop) |
| Security groups | `workload`, `nat`, `bastion`: allow at 100, deny other ingress at 400, stateful egress |
| NAT gateway | VM + private allocation (the route's next hop) + reserved public allocation; route `0.0.0.0/0` |
| WireGuard bastion | `enable_bastion`: VM + public allocation, UDP 51820 from `allowed_cidrs` only |

## Inputs that matter

| Variable | Default | Meaning |
|---|---|---|
| `name` | `null` → `nip-<stage>-network` | prefix of every object (`nip-sandbox-network-nat-boot`, route table `…-egress`); the stage keeps tenant-unique disk names apart ([`docs/naming.md`](../../../docs/naming.md)) |
| `cidr` | `10.40.0.0/16` | one range per stage (sizing files use 10.40/10.41/10.42) |
| `enable_nat` | `true` | without it the workload subnet has no egress; the prod policy refuses `false` |
| `enable_bastion` / `allowed_cidrs` | `false` / `[]` | a bastion needs an allowlist in every stage, each entry /8 or narrower (never `0.0.0.0/0` or its `/1` halves); staging and prod refuse RFC 5737 ranges |
| `vm_preset` | `4vcpu-16gb` | NAT throughput scales with vCPUs |
| `wireguard_cidr` | `10.99.0.0/24` | tunnel range; must not overlap `cidr` |

## Outputs and composition

`subnet_id`, `security_group_ids` and `service_cidr` go to R1/R3 as `TF_VAR_*`. Managed Kubernetes
reserves the Service range inside the cluster subnet and its /16 default does not fit, so set
`service_cidr` before the cluster's first apply. `nat_public_ip` is what external allowlists see;
`bastion.endpoint` is the WireGuard peer endpoint. Apply order: network, data (R8), clusters.

**Private API endpoint (prod, `public_endpoint: false`).** The docs reach a private MK8s endpoint
only from a VM in the cluster's own region and subnet
([connect](https://docs.nebius.com/kubernetes/connect)). Prod operators and the self-hosted CI
runner therefore run on a VM in the **workload** subnet (`subnet_id`), not the edge subnet; the
bastion is a path to such a VM, not to the API endpoint itself
([`runbooks/network.md`](../../../runbooks/network.md#private-api-endpoint-prod)).

## Quotas and cost

One VM per gateway (4 vCPU, 50 GiB) and one public IP each
([`docs/capacity.md`](../../../docs/capacity.md#stacksnetwork-r7-and-stacksdata-r8)); billed while they exist.
The NAT and bastion VMs are non-GPU VMs, whose vCPU quota defaults to **0** in `eu-north1` and
`us-central1` (`.cache/nebius-docs/compute/resources/quotas-limits.md:41`): request `compute.instance.non-gpu.vcpu` before the first plan there (a CPU node
group was refused for this on 2026-10-11, [evidence](../../../docs/evidence/2026-10-11-sandbox-inference-portal-connectors.md)).

## Validate

- Static: `terraform test` (mocked): subnets, rule priorities, route, bastion allowlist, stage policy.
- Live: [`tests/validate/network.sh`](../../../tests/validate/network.sh): no node has a public IP;
  egress leaves through the NAT address.

## Evidence

None yet: not run live (no apply of `live/<stage>/network` is recorded in [`docs/evidence/`](../../../docs/evidence/README.md)).

## Teardown

Destroy the clusters that use the subnet first, then
`make destroy-plan destroy STAGE=<stage> STACK=network CONFIRM=yes`
([`runbooks/network.md`](../../../runbooks/network.md#teardown)).

## Limits

The NAT VM is a single point of failure and a bandwidth ceiling. Site-to-site VPN is a documented
variant, not built here. A LoadBalancer Service needs its own ingress rule.

## Upstream references

[Custom NAT gateway](https://docs.nebius.com/vpc/routing/custom-nat-gateway) ·
[routing](https://docs.nebius.com/vpc/routing/overview) ·
[security groups](https://docs.nebius.com/vpc/security-groups/overview) ·
[MK8s security groups](https://docs.nebius.com/kubernetes/networking/security-groups) ·
[MK8s network requirements](https://docs.nebius.com/kubernetes/networking/requirements) ·
[disable public addresses](https://docs.nebius.com/vpc/addressing/disable-public-addresses) ·
[WireGuard](https://docs.nebius.com/compute/virtual-machines/wireguard) ·
solutions library `wireguard/`, `bastion/`.
