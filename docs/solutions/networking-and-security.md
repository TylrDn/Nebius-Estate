# Networking and security

VPC, routing, perimeter, identity, secrets and audit on Nebius AI Cloud, and how R7 and R2 use
them. All links read on **2026-10-11**.

## Virtual Networks building blocks

Source: [About Virtual Networks](https://docs.nebius.com/vpc/overview).

| Resource | What it is | Notes |
|---|---|---|
| Network | L3 isolation boundary; resources in one network reach each other by private IP | IPv4 only. Network-scoped: Managed PostgreSQL, Managed MLflow |
| Subnet | Address range in a network | Subnet-scoped: VMs, MK8s clusters, allocations. Uses its own pool or the network's pools |
| Pool | Reserved CIDR blocks; child pools must be subsets of the source pool | Subnets in one network cannot overlap |
| Allocation | A reserved private or public IP, attached to a resource | VMs create their own allocations unless given one; MK8s clusters always create their own |
| Route table / route | Next hop per destination CIDR; longest prefix wins | Next hop is an allocation (any CIDR) or the default egress gateway (`0.0.0.0/0` only) |
| DNS zone | Private zone attached to one network; a system zone holds VM FQDNs | [DNS](https://docs.nebius.com/vpc/dns/overview) |
| Security group / rule | Packet filter on VM interfaces | below |

Defaults per project: `default-network`, `default-subnet` (named `default-subnet-<suffix>` in current projects, [connectors evidence](../evidence/2026-10-11-sandbox-inference-portal-connectors.md)), `default-network-pool` (region CIDR,
[regions.md](regions.md#regions-and-locations)), `default-public-pool` (shared across all projects
in a tenant, cannot be deleted), `default-route-table-***` (0.0.0.0/0 → default egress gateway).
Observed through the API on 2026-10-11 ([evidence](../evidence/2026-10-11-portal-live-read-only.md)): the default network and subnet carry
`status.default = true` and no labels; but nebius CLI 0.12.285 omits `status.default`
([connectors evidence](../evidence/2026-10-11-sandbox-inference-portal-connectors.md)), so tooling reads
the field where present and otherwise matches the `default-subnet` name prefix, as
`scripts/bootstrap-backend.sh` does.
Network resources attached to active workloads cannot be reconfigured; plan custom networks
before deploying ([customized networking](https://docs.nebius.com/vpc/overview#customized-networking-infrastructure)).

### Routing facts

Source: [Routing](https://docs.nebius.com/vpc/routing/overview).

| Behaviour | Consequence |
|---|---|
| Intra-network traffic always stays in the network, ignoring route tables | Cannot force east-west traffic through an appliance inside one network |
| Default table: private destinations outside the network are **discarded**; public go to the default egress gateway | No built-in path to another network, region or on-prem: you need a gateway VM |
| Default egress gateway SNATs to the resource's public IP, or to a dynamic IP from a regional pool shared by all projects | Egress source IP is not stable unless you route through your own NAT with a reserved public allocation |
| A route to an allocation not assigned to a resource discards traffic | NAT/VPN VM replacement must keep the allocation |
| Empty route table = no egress at all | Basis of an "isolated" subnet |

Network peering, private service endpoints (PrivateLink-style), and dedicated interconnects to
other clouds or colocation: **docs silent** (no page found). Cross-network and on-prem
connectivity in the docs is VM-based (custom NAT, WireGuard jump host, VPN Gateway).

### Security groups

Source: [Security groups](https://docs.nebius.com/vpc/security-groups/overview),
[VPC quotas and constraints](https://docs.nebius.com/vpc/resources/quotas-limits).

| Rule | Detail |
|---|---|
| Evaluation | Rules from all attached groups are merged and evaluated by effective priority, 1 (first) to 1000; first match wins; **no match = deny**; at equal priority DENY beats ALLOW; default priority 500 |
| Stateful vs stateless | `STATEFUL` (default) allows return traffic; `STATELESS` needs explicit return rules |
| Match fields | up to 8 CIDRs and 8 ports per rule; protocol TCP/UDP/ICMP/ANY (ports only for TCP/UDP); a security group can be source (ingress) or destination (egress) |
| Not filtered | 169.254.0.0/16 (Nebius internal) |
| Default security group | One per network; **allows all ingress and egress**; cannot be changed or deleted. It controls an interface that is in no group ([manage](https://docs.nebius.com/vpc/security-groups/manage#adding-vms-to-security-groups)); whether it also applies next to explicit groups is not stated |
| MK8s | A managed *system* security group per cluster is always attached to nodes; your groups are added alongside it ([MK8s security groups](https://docs.nebius.com/kubernetes/networking/security-groups)) |
| Limits | 8 groups per VM interface, 60 rules per group, 128 groups per network; quotas 200 groups / 1000 rules per region |

Because the docs leave open whether the default group still applies once an interface has its own
groups, a tighter posture adds an explicit DENY rule at a higher priority than the default group's
ALLOW (500) in a group you attach; that holds either way. The docs explain the effective-priority
mechanism but do not publish the default group's effective priority value; check
`.status.effective_priority` on the rules in your project before relying on ordering.

### Public exposure controls

| Control | Doc |
|---|---|
| Subnet with no public pool (allocation of a public IP fails) | [Disable public addresses](https://docs.nebius.com/vpc/addressing/disable-public-addresses) |
| Custom NAT gateway VM + route table for a private subnet | [Custom NAT gateway](https://docs.nebius.com/vpc/routing/custom-nat-gateway) |
| WireGuard jump server | [WireGuard](https://docs.nebius.com/compute/virtual-machines/wireguard) |
| Site-to-site IPsec (IKEv2, strongSwan), VM-based, open source, from Nebius Professional Services | [VPN Gateway](https://docs.nebius.com/vpc/nebius-vpn-gateway) → [nebius-ps-services/vpngw](https://github.com/nebius/nebius-ps-services/tree/main/services/vpngw) |
| MK8s public endpoint allowlist (`allowed_cidrs`; update overwrites the list; private endpoint unaffected) | [Limit public endpoint](https://docs.nebius.com/kubernetes/networking/limit-access-to-public-endpoint) |
| MK8s OIDC on the public endpoint | [OIDC public endpoint](https://docs.nebius.com/kubernetes/networking/oidc-public-endpoint) |
| Expose a local service without inbound ports (preview). The URL is **public** and Tunnels add no user authentication; 80 Mbps and 300 client connections per tunnel; the agent's service account needs `applicationtunnel.agent`. Not a substitute for port-forward to Grafana or vLLM | [Nebius Tunnels](https://docs.nebius.com/tunnels/overview#authentication-and-access), [limits](https://docs.nebius.com/tunnels/resources/quotas-limits#traffic) |
| Public IPv4 quota: 3 per region by default | [VPC quotas](https://docs.nebius.com/vpc/resources/quotas-limits) |

MK8s address needs: 5 × /32 for the control plane with HA (3 without), one service CIDR (default
/16, configurable /12–/28), and per node one /24 for pods plus one /32
([network requirements](https://docs.nebius.com/kubernetes/networking/requirements)). A subnet that
is too small, or allocation quota, leaves the cluster stuck in `Provisioning`
([CIDR allocation error](https://docs.nebius.com/kubernetes/troubleshooting/cidr-allocation-error)).
Docker's default bridge `172.17.0.0/16` makes VMs unable to reach remote addresses in that range
([Docker subnet conflict](https://docs.nebius.com/compute/virtual-machines/docker-subnet-conflict)).

Virtual Networks is free of charge ([VPC pricing](https://docs.nebius.com/vpc/resources/pricing));
the NAT, bastion and VPN VMs are billed as Compute.

## Identity and access

Sources: [IAM overview](https://docs.nebius.com/iam/overview),
[groups](https://docs.nebius.com/iam/authorization/groups),
[roles](https://docs.nebius.com/iam/authorization/roles).

| Concept | Fact |
|---|---|
| Tenant | Top-level workspace: projects, users, groups, federation, quotas, billing, audit logs; cannot be deleted; you can create several |
| Project | Isolated workspace in one region; holds resources, service accounts, quotas, project-level groups. One per region at signup |
| Default groups | `auditors` (view some, no data), `viewers` (view most + data), `editors` (manage most + data), `admins` (all); tenant-wide general roles |
| Custom groups | Tenant or project scoped; *access permits* bind roles at tenant, project or individual resource (VMs, buckets, registries, secrets, IAM resources) |
| Bucket-level control | Bucket policies, alone or with access permits ([bucket policy](https://docs.nebius.com/object-storage/buckets/bucket-policy)) |
| New principals | No access until added to a group |
| SSO | SAML federations; guides for Entra ID, Okta, JumpCloud, Keycloak ([federations](https://docs.nebius.com/iam/federations/manage)) |

Read-only access, verified live on 2026-10-11 ([evidence](../evidence/2026-10-11-portal-live-read-only.md); setup in
[`docs/credentials.md`](../credentials.md#portal-read-only-service-account); the IAM pages behind it are
indexed in [`docs/reference/nebius-docs.md`](../reference/nebius-docs.md)):

| Behaviour | What it means for a customer design |
|---|---|
| A custom tenant group with one `viewer` permit per project reads about 30 per-project lists (Compute, MK8s, VPC, Object Storage, Serverless AI, PostgreSQL, MLflow, Registry, Tunnels, KMS, SecretStash metadata, DNS, quotas) | Project-scoped read-only auditors and dashboards work without any tenant role |
| The same token gets **403** on a bucket `DELETE` | `viewer` is read-only for control-plane writes; remember it can still **read data**, e.g. download objects ([roles](https://docs.nebius.com/iam/authorization/roles#general-roles)) |
| `GET /iam/v2/projects/<id>` works; listing the tenant's projects is **403** | A project-scoped identity cannot discover projects: hand it the project IDs |
| Capacity block groups, capacity advisor and contract prices are **403** | They need tenant-level or billing-group grants; grant them separately, not by widening project access |

Credentials for automation:

| Credential | Use | Lifetime / limits | Source |
|---|---|---|---|
| Authorized key (service account key pair) | CLI, Terraform provider, SDKs; or sign a 5-minute RS256 JWT and exchange it for a 12 h access token | optional `--expires-at`; uploading needs `admin`; an account's first key cannot go through Terraform or an SDK | [authentication](https://docs.nebius.com/iam/service-accounts/authentication), [authorized keys](https://docs.nebius.com/iam/service-accounts/authorized-keys#uploading-the-public-key), [JWT exchange](https://docs.nebius.com/grpc-api/auth#get-an-access-token) (gRPC documented; the REST exchange at `sts.nebius.com` worked on 2026-10-11 but is undocumented, see [gaps](gaps-and-discrepancies.md#docs-silent)) |
| Access key (AWS-style) | Object Storage and other S3-compatible APIs | can be issued without expiry; creating one requires `admin` | [access keys](https://docs.nebius.com/iam/service-accounts/access-keys) |
| Static key | Only Observability (e.g. Grafana) and Container Registry from external systems; service accounts only; one service each | up to 3 years | [static keys](https://docs.nebius.com/iam/authorization/static-keys) |
| Federated credentials (OIDC issuer → service account) | Keyless CI (any issuer exposing OIDC discovery) | — | provider reference only: [`iam_v1_federated_credentials`](https://docs.nebius.com/terraform-provider/reference/resources/iam_v1_federated_credentials) |
| Nebius STS ID tokens (Nebius → external cloud) | Workload identity federation outward (example: Google Cloud) | short-lived | [WIF](https://docs.nebius.com/iam/wif), [configure](https://docs.nebius.com/iam/wif/configure) |

## Secrets, keys, encryption, audit

| Service | Status | Fact | Source |
|---|---|---|---|
| SecretStash (formerly MysteryBox) | free while in preview | Versioned key-value secrets per project, accessible within the region; CLI/API/Terraform still use `mysterybox`; Serverless AI injects secrets as env vars; managed services store generated passwords here | [SecretStash](https://docs.nebius.com/mysterybox/overview), [PAYG free list](https://docs.nebius.com/signup-billing/billing-models/payg) |
| KMS | preview | Symmetric/asymmetric keys, envelope encryption, rotation | [KMS](https://docs.nebius.com/kms) |
| Encryption at rest | GA behaviour | AES-256 with DEK/KEK via KMS; Network SSD, filesystems and buckets always encrypted; NRD and IO M3 opt-in; local SSD not encrypted; WEKA opt-in at create | [Encryption](https://docs.nebius.com/security/encryption) |
| Audit Logs | preview, free | Who did what, when, tenant-wide; viewing needs `admin` or `auditlogs.audit-event-viewer`; export is one-time per time range to a bucket in the same region; data-plane events capped at 1000/s per region (excess dropped) | [Audit Logs](https://docs.nebius.com/audit-logs), [services](https://docs.nebius.com/audit-logs/services), [export](https://docs.nebius.com/audit-logs/events/export#how-to-export-events), [quotas](https://docs.nebius.com/audit-logs/resources/quotas-limits#data-plane-events) |
| Object Storage data-plane logs | — | Optional per bucket (also filesystem buckets) | [Object Storage logs](https://docs.nebius.com/object-storage/logs) |
| Security logs retention | — | 24 months | [Data deletion](https://docs.nebius.com/overview/data-deletion) |
| Third-party posture scanning | — | Wiz integration | [Wiz](https://docs.nebius.com/3p-integrations/wiz) |

Customer-managed keys for disks, filesystems or buckets (BYOK/CMEK): **docs silent**; the
encryption page describes Nebius-managed KEKs only, and the provider's `disk_encryption` offers
only `DISK_ENCRYPTION_MANAGED` (the platform root key). The stacks therefore do not use KMS: it is
for application-level (envelope) encryption. Network SSD NRD and IO M3 disks are encrypted only
when enabled at creation ([disks](https://docs.nebius.com/security/encryption#disks-in-compute)).

## How R7 maps

`terraform/stacks/network` (R7) builds the documented VM-based perimeter:

| R7 resource | Doc pattern | Note |
|---|---|---|
| `nebius_vpc_v1_network` + `nebius_vpc_v1_pool` (default 10.40.0.0/16) | custom network with its own pool | outside every region's default pool; check against on-prem ranges |
| workload subnet (first half, no public pool) | [disable public addresses](https://docs.nebius.com/vpc/addressing/disable-public-addresses) | half the range because MK8s takes one /24 per node. An MK8s public endpoint still works here: its IP is allocated from the Managed Kubernetes project, not the subnet or your quota ([requirements](https://docs.nebius.com/kubernetes/networking/requirements#public-ip-address-allocations)) |
| edge subnet (last /24) | holds NAT and bastion | |
| NAT VM + `nebius_vpc_v1_allocation` (public) + route table 0.0.0.0/0 → NAT private allocation | [custom NAT gateway](https://docs.nebius.com/vpc/routing/custom-nat-gateway) | without `enable_nat` the workload subnet has no egress (image pulls fail); NAT throughput scales with VM size |
| WireGuard bastion (`enable_bastion`, UDP 51820 only from `allowed_cidrs`) | [WireGuard jump server](https://docs.nebius.com/compute/virtual-machines/wireguard) | VPN Gateway (IPsec) is the PS alternative for site-to-site |
| security groups with explicit ingress DENY | [security groups](https://docs.nebius.com/vpc/security-groups/overview) | DENY at 400 is intended to precede the default group's ALLOW at 500, but rules from several groups combine by computed effective priority (`.cache/nebius-docs/vpc/security-groups/overview.md:88-94`), which is unpublished for the default group: confirm `.status.effective_priority` on the live rules |
| R1/R3 consume `subnet_id`, `security_group_ids` | MK8s non-default subnet ([doc](https://docs.nebius.com/kubernetes/networking/non-default-subnet)) | prod stage sets `public_endpoint: false`: the private endpoint is reachable only from a VM in the cluster's subnet ([connect](https://docs.nebius.com/kubernetes/connect)), so prod operators and the CI runner sit in the workload subnet, not behind the bastion alone |

## How R2 maps

`terraform/live/foundation` + `terraform/modules/foundation/*`:

| R2 element | Nebius feature |
|---|---|
| One project per stage | project isolation; quotas per project per region |
| State bucket per stage × stack | Object Storage as Terraform backend ([doc](https://docs.nebius.com/terraform-provider/store-terraform-state)) |
| `state-identity` (bucket-scoped access permit) | access permit on an individual bucket |
| `ci-service-account` (group + project permit; keys registered with the CLI) | authorized key for the Terraform provider; federated credentials are a keyless alternative |
| stage policy `audit_logs: true` (staging, prod) | Managed Kubernetes cluster audit logs, and bucket logging in R8; tenant Audit Logs (control plane) exist regardless of this flag |
