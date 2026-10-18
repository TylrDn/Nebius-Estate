# Naming and labelling standard

How resources are named and labelled in Nebius AI Cloud, what the official documentation and API
actually constrain, and the one convention this repository adds on top. It is meant to be portable:
everything under "Official" holds for any tenant; everything under "Ours" is a choice that a platform
team can adopt as-is or replace with its own prefix.

Sources, all read on **2026-10-11**: the docs cached as raw Markdown by
[`scripts/nebius-docs.py`](../scripts/nebius-docs.py) (index: [`reference/nebius-docs.md`](reference/nebius-docs.md)),
the public OpenAPI description (`https://api.nebius.cloud/openapi.json`), a read-only reconciliation of a
real tenant on the same day (names exactly as the API returned them; IDs replaced by `<id>`), and
the code in this repository. "Not documented" means neither the docs nor the OpenAPI description
state it; "observed" means seen in the tenant and nowhere in the docs.

## 1. Principles

1. **Official IDs and names are authoritative.** A resource is identified by its `metadata.id`;
   tooling joins on IDs, never on names. Nothing in this repository renames, re-labels or parses
   the meaning out of a resource it did not create.
2. **Nebius-created resources keep Nebius's names.** Project defaults, Managed Kubernetes node VMs,
   their disks, allocations, system security groups and DNS zones are recognised by an explicit
   field first (`status.default`, a Nebius-set label), by name pattern only as a fallback
   ([section 6](#6-how-the-portal-and-scripts-recognise-defaults-and-managed-resources)). They are never
   re-labelled with `nip-*` labels and never counted as unattributed.
3. **Our prefix only where we create things.** Every object this repository creates starts with
   the prefix (`nip`, the foundation input `name_prefix`), so ours and theirs can be told apart by
   name alone and a `default-` name is always Nebius's.
4. **Labels attribute; names identify.** Attribution, cost reports and the residue check read the
   `nip-*` labels, never the name ([`resources.ts`](../portal/packages/nebius-domain/src/resources.ts),
   `attribute()`).
5. **One convention, few exceptions.** Where the docs force something (region-unique bucket names,
   tenant-unique disk and node group names, Kubernetes label syntax) the exception is stated
   next to the rule, with its source.

## 2. Official ID prefixes

Every ID is `<type prefix>-<suffix>`. The suffix is opaque lowercase alphanumerics; the docs do not
define its structure, so do not parse it. The API describes `id` only as "Identifier for the
resource, unique for its resource type" (`nebius.common.v1.ResourceMetadata`).

| Resource kind | ID prefix | API service (OpenAPI tag) | Terraform resource | Docs page showing the prefix |
|---|---|---|---|---|
| Tenant | `tenant-` | `nebius.iam.v2.TenantService` | none (data source only) | [audit event reference](https://docs.nebius.com/audit-logs/events/reference) |
| Project | `project-` | `nebius.iam.v2.ProjectService` | `nebius_iam_v2_project` | [audit event reference](https://docs.nebius.com/audit-logs/events/reference) |
| Tenant user account | `tenantuseraccount-` | `nebius.iam.v1.TenantUserAccountService` | none | [filtering audit events](https://docs.nebius.com/audit-logs/events/filter) |
| Service account | `serviceaccount-` | `nebius.iam.v1.ServiceAccountService` | `nebius_iam_v1_service_account` | [filtering audit events](https://docs.nebius.com/audit-logs/events/filter) |
| Group | `group-` | `nebius.iam.v1.GroupService` | `nebius_iam_v1_group` | [adding users](https://docs.nebius.com/iam/authorization/add-users) |
| Access permit | `accesspermit-` | `nebius.iam.v1.AccessPermitService` | `nebius_iam_v1_access_permit` | [managing groups](https://docs.nebius.com/iam/authorization/groups/manage) |
| Authorized (public) key | `publickey-` | `nebius.iam.v1.AuthPublicKeyService` | `nebius_iam_v1_auth_public_key` | [dstack integration](https://docs.nebius.com/3p-integrations/dstack) |
| Access key (S3) | `accesskey-` | `nebius.iam.v2.AccessKeyService` | `nebius_iam_v2_access_key` | observed; not shown in the docs |
| VM | `computeinstance-` | `nebius.compute.v1.InstanceService` | `nebius_compute_v1_instance` | [filtering audit events](https://docs.nebius.com/audit-logs/events/filter) |
| Disk | `computedisk-` | `nebius.compute.v1.DiskService` | `nebius_compute_v1_disk` | [filtering audit events](https://docs.nebius.com/audit-logs/events/filter) |
| Shared filesystem | `computefilesystem-` | `nebius.compute.v1.FilesystemService` | `nebius_compute_v1_filesystem` | [detaching volumes](https://docs.nebius.com/compute/storage/detach-volume) |
| GPU cluster | `computegpucluster-` | `nebius.compute.v1.GpuClusterService` | `nebius_compute_v1_gpu_cluster` | [GPU cluster topology](https://docs.nebius.com/compute/clusters/gpu/topology/manage) |
| Image | `computeimage-` | `nebius.compute.v1.ImageService` | none (data source only) | [custom images](https://docs.nebius.com/compute/storage/custom-disk-images) |
| MK8s cluster | `mk8scluster-` | `nebius.mk8s.v1.ClusterService` | `nebius_mk8s_v1_cluster` | observed; not shown in the docs |
| MK8s node group | `mk8snodegroup-` | `nebius.mk8s.v1.NodeGroupService` | `nebius_mk8s_v1_node_group` | observed; not shown in the docs |
| Network | `vpcnetwork-` | `nebius.vpc.v1.NetworkService` | `nebius_vpc_v1_network` | [creating a VM](https://docs.nebius.com/compute/virtual-machines/create) |
| Subnet | `vpcsubnet-` | `nebius.vpc.v1.SubnetService` | `nebius_vpc_v1_subnet` | [Compute quickstart](https://docs.nebius.com/compute/quickstart) |
| Pool | `vpcpool-` | `nebius.vpc.v1.PoolService` | `nebius_vpc_v1_pool` | [public address ranges](https://docs.nebius.com/vpc/addressing/public-address-ranges) |
| Route table / route | `vpcroutetable-` / `vpcroute-` | `nebius.vpc.v1.RouteTableService` / `RouteService` | `nebius_vpc_v1_route_table` / `_route` | [routing overview](https://docs.nebius.com/vpc/routing/overview) |
| Security group / rule | `vpcsecuritygroup-` / `vpcsecurityrule-` | `nebius.vpc.v1.SecurityGroupService` / `SecurityRuleService` | `nebius_vpc_v1_security_group` / `_rule` | [security groups](https://docs.nebius.com/vpc/security-groups/overview) |
| Allocation (IP) | `vpcallocation-` | `nebius.vpc.v1.AllocationService` | `nebius_vpc_v1_allocation` | [dynamic to static IP](https://docs.nebius.com/kubernetes/networking/dynamic-to-static) |
| Bucket | `storagebucket-` | `nebius.storage.v1.BucketService` | `nebius_storage_v1_bucket` | [bucket policies](https://docs.nebius.com/object-storage/buckets/bucket-policy) |

Code that validates IDs uses `^<prefix>[a-z0-9]+$` (for example `PROJECT_ID` in
[`config.ts`](../portal/plugins/nebius-estate-backend/src/lib/config.ts) line 131). A Kubernetes
node is named after its VM: the docs' `kubectl get nodes` output shows `computeinstance-<id>` as
the node name ([topology labels](https://docs.nebius.com/kubernetes/gpu/topology-aware-scheduling#how-to-view-topology-labels-in-your-cluster)).

## 3. Name constraints per kind

`metadata.name` is described in the API only as "Human readable name for the resource". The OpenAPI
description carries no `maxLength` or `pattern` on any name or label field, and every
`get-by-name` call takes `parentId` plus `name`. What the docs add:

| Kind | Length / charset | Uniqueness scope | Mutable | Source |
|---|---|---|---|---|
| Bucket | 3–63 characters; lowercase Latin letters, digits, dots, hyphens | **region** (all tenants): "unique across the region" | not documented | [Object Storage naming](https://docs.nebius.com/object-storage/overview#naming) |
| Disk, shared filesystem | not documented | **tenant**: "must be unique inside your tenant" | no: "cannot be changed after it" | [volume metadata](https://docs.nebius.com/compute/storage/manage#metadata) |
| MK8s node group | not documented | **tenant**: "Must be unique within the tenant" | no | [node group parameters](https://docs.nebius.com/kubernetes/node-groups/manage#node-group-parameters) |
| Project | not documented | tenant: "should be unique in the tenant" | yes | [creating a project](https://docs.nebius.com/iam/manage-projects#how-to-create-a-project) |
| Tenant | not documented; a rename appends a random suffix (`my-main-tenant` → `my-main-tenant-jf3`) | global (implied by the suffix) | rename only | [renaming tenants](https://docs.nebius.com/iam/rename-tenants#how-to-rename-a-tenant) |
| GPU cluster | 3–63 characters; lowercase letters, digits, hyphens (stated for the web console) | not documented | not documented | [GPU clusters](https://docs.nebius.com/compute/clusters/gpu#how-to-enable-infiniband-for-vms-with-gpus) |
| VM hostname (not the name) | no full stop; default FQDN `<VM_ID>.<network_ID>.compute.internal.` | "must be unique" | yes | [customising an FQDN](https://docs.nebius.com/compute/virtual-machines/fqdn#how-to-customize-an-fqdn) |
| DNS record (resource name) | optional; records Nebius creates have none | zone | not documented | [DNS records](https://docs.nebius.com/vpc/dns/manage-records#creating-dns-records) |
| DNS zone (domain name) | at least two labels; up to 252 characters with the trailing dot; Nebius-owned domains reserved | not documented | no | [DNS constraints](https://docs.nebius.com/vpc/dns/resources/quotas-limits#constraints) |
| Kubernetes node labels (`template.metadata.labels`) | Kubernetes label syntax; keys containing `kubernetes.io` or `k8s.io` are ignored; new values reach only nodes created after the change | per node | yes (no roll-out) | [node group schema](https://docs.nebius.com/terraform-provider/reference/resources/mk8s_v1_node_group#nested-schema-for-templatemetadata) |
| VM, MK8s cluster, network, subnet, pool, route table, security group, allocation, service account, group, access key, secret | not documented | not documented (lookup is by parent + name) | not documented | — |

Docs examples use underscores in names (an allocation called `private_allocation` in
[VM networking](https://docs.nebius.com/compute/virtual-machines/network)); nothing says which other
characters are accepted. Our convention stays inside the narrowest documented set,
`[a-z0-9-]`, 3–63 characters, starting with a letter, which satisfies the bucket, GPU cluster and
Kubernetes (RFC 1123 label) rules at once.

**Reserved by Nebius.** Tenant groups `auditors`, `viewers`, `editors`, `admins`
([default groups](https://docs.nebius.com/iam/authorization/groups#default-groups)); the `default-` name
prefix of project VPC resources ([default resources](https://docs.nebius.com/vpc/overview#default-virtual-networks-resources));
the `nebius.com/` and `topology.nebius.com/` label prefixes.

### Regions, platforms and presets (official, never invented)

| Thing | Shape | Examples | Source |
|---|---|---|---|
| Region | `<area>-<direction><n>` | `eu-north1`, `eu-west2`, `us-central1`, `uk-south1`, `me-west1`; `eu-north2` is private | [regions](https://docs.nebius.com/overview/regions#public-regions) |
| Platform | `gpu-<model>-<form>[-<variant>]`, `cpu-<generation>` | `gpu-h200-sxm`, `gpu-b200-sxm-a`, `gpu-l40s-a`, `gpu-rtx6000`, `cpu-d3`, `cpu-e2` | [VM types](https://docs.nebius.com/compute/virtual-machines/types) |
| Preset | `[<n>gpu-]<n>vcpu-<n>gb` (GiB) | `8gpu-128vcpu-1600gb`, `1gpu-16vcpu-200gb`, `4vcpu-16gb` | [GPU presets](https://docs.nebius.com/compute/virtual-machines/types#presets-for-gpu-platforms) |

These values come from [`platform/regions.yaml`](../platform/regions.yaml) or the
[list-platforms](https://docs.nebius.com/compute/virtual-machines/list-platforms) call, never from a
hand-typed string. The portal parses presets with `^(?:(\d+)gpu-)?(\d+)vcpu-(\d+)gb$` and regions with
`^[a-z]{2}-[a-z]+\d$`.

### Resources Nebius creates (official names)

| Created by | Name (as returned by the API) | Docs say | Recognise by |
|---|---|---|---|
| Sign-up | one project per region: `default-project-<region>` (observed) | "a project per region" ([projects](https://docs.nebius.com/iam/overview#projects)) | name |
| Project creation | `default-network` | `default-network` | `status.default` |
| | `default-subnet-<suffix>` (observed; older projects `default-subnet`) | `default-subnet` | `status.default` |
| | `default-network-pool-<suffix>`, two per network (observed) | `default-network-pool` and `default-public-pool` (tenant-shared, cannot be changed) | name |
| | `default-route-table-<suffix>` | `default-route-table-***` | `status.default` |
| | `default-security-group-<suffix>` (observed) | a default group per network, allow-all, cannot be changed or deleted ([default security groups](https://docs.nebius.com/vpc/security-groups/overview#default-security-groups)) | `status.default` |
| Every network | DNS zone `<network_ID>.compute.internal.` | system-managed, read-only ([system zones](https://docs.nebius.com/vpc/dns/overview#system-managed-and-custom-zones)) | domain name |
| Each MK8s cluster | a system security group | managed, cannot be edited or attached ([system security groups](https://docs.nebius.com/kubernetes/networking/security-groups#system-security-groups)) | not yet (see section 6) |
| Each node | VM and boot disk `mk8snodegroup-<id>-<rand>-<rand>` with labels `mk8s-cluster-id`, `mk8s-node-group-id` (observed) | not documented | labels |
| Each node | allocations `<node VM name>-private`, `-alias`, `-public` (observed) | MK8s "create their own allocations" ([VPC overview](https://docs.nebius.com/vpc/overview#default-virtual-networks-resources)) | assignment to the node VM |
| `LoadBalancer` Service | allocation labelled `nebius.com/managed-by: mk8s` | yes ([dynamic to static](https://docs.nebius.com/kubernetes/networking/dynamic-to-static)) | label |
| CSI volumes | disks `pvc-<uid>`, no labels | volumes are created by the CSI driver ([disks over CSI](https://docs.nebius.com/kubernetes/storage/disk-over-csi)) | name and no labels |
| GPU nodes | Kubernetes node labels `topology.nebius.com/gpu-cluster-id`, `tier-0/1/2`, `nebius.com/node-group-id` | yes ([topology labels](https://docs.nebius.com/kubernetes/gpu/topology-aware-scheduling#how-to-enable-topology-aware-scheduling)) | label |

## 4. Our convention

```text
<prefix>-<stage>-<stack>[-<role>]        prefix = nip (foundation input name_prefix)
                                         stage  = sandbox | staging | prod | lab   (platform/stages.yaml)
                                         stack  = inference | training | soperator | network | data
                                                  | gpu-vm | ml-services | governance | nvl
                                         role   = what this object is within the stack
```

Rules:

- Lowercase `[a-z0-9-]`, starts with a letter, at most 63 characters.
- The stage is always in the name. Stages are separate projects, but disk, filesystem and node group
  names must be unique in the whole **tenant**, and buckets in the whole **region**.
- Roles are nouns from a closed list: `ng-cpu`, `ng-gpu` (node groups), `shared-fs` (filesystem),
  `datasets`, `checkpoints`, `fs` (buckets), `ingest` (transfer), `<fabric>` (GPU cluster),
  `workload`, `edge`, `nat`, `bastion`, `egress`, `private` (network objects), `boot` (disks),
  `access` (an allowlist security group), `public` (a public allocation), `mlflow`, `pg` (managed
  clusters), `node-sa`, `image-pullers` (R12 pull identity), `spot-<platform>`, `cbg-<key>` (R9
  pricing policies and project limits), `gha-<job>` (R13 federated credentials), `rack-<nnn>` and
  `ng-rack-<nnn>` (R15 NVLink instance group and its node group, `<nnn>` = `001`, `002` …). A stack whose
  whole root is one object uses the stack as the role: the R10 VM `nip-<stage>-gpu-vm`; the R12
  registry is `nip-<stage>` (its images are addressed by registry ID, not name).
- Nothing we create starts with `default-`, `mk8s`, `pvc-` or any Nebius-reserved name.
- Names are set at creation and treated as immutable. A rename of a Terraform-managed object
  replaces it (filesystems and node groups cannot be renamed at all), so a naming fix ships with
  a new stage or a planned rebuild, never as a drive-by change.

### Buckets

`<prefix>-<stage>-<role>-<suffix>` where `<suffix>` is the first 12 characters after `project-` in
the owning project's ID ([`stacks/data/main.tf`](../terraform/stacks/data/main.tf) line 10). Bucket
names are unique per region across all customers and appear in URLs
(`https://storage.<region_id>.nebius.cloud/<bucket_name>`), so they never carry a customer or team
name and never use dots (a choice; dots are allowed). The one exception is the Terraform state
bucket, `tfstate-<prefix>-<stage>-<hash>` (hash of tenant and project ID). It is the current
convention, kept on purpose: the bucket holds every stack's state, so a new name means a new bucket
and a state migration for every root, and the hash already makes it unique per tenant and project
(item 6 in section 7).

### IAM

| Object | Convention | Scope |
|---|---|---|
| Stage identity (service account and its group share the name) | `<prefix>-<stage>-<function>` for new identities; the foundation's existing ones are `<prefix>-<function>-<stage>` (below) | stage project |
| Tenant-wide identity | `<prefix>-<function>` (`nip-portal-viewer`, group `nip-portal-viewers`) | home project; tenant group |
| Access key, authorized key | `<identity name>-<consumer>-<UTC yyyymmddhhmm>`; Terraform state keys (bootstrap and CI) `<identity name>-<consumer>-<UTC yyyymmddhhmmss>`: since 2026-10-11 10:15Z, after two bootstraps in one minute produced the same name | the identity's project |
| SecretStash secret | `<prefix>-<stage>-<purpose>` | stage project |
| Federated credential (R13) | `<prefix>-<stage>-gha-<apply\|plan>`, one per CI account | stage project |
| Team group (R13) | `<prefix>-team-<key>`: a team, not a stage, so no stage in the name; created inside one project | that project |

**Current convention for the foundation identities (kept).** The state and CI identities put the
function before the stage: `nip-tfstate-<stage>`, `nip-ci-<stage>`, `nip-ci-plan-<stage>`,
`nip-ci-<stage>-secrets`, and the CI authorized key `<identity>-key`. They stay as they are: a
rename recreates the service accounts and groups (new IDs to re-enter in every GitHub environment,
new keys, new permits) for no functional gain. New identities follow `<prefix>-<stage>-<function>`.

### Kubernetes

| Object | Convention | Current |
|---|---|---|
| Namespace | the workload family, no prefix (the cluster is already ours) | `inference`, `training`, `nccl-test`, `team-<team>`, `o11y`; platform charts keep upstream names (`gpu-operator`, `network-operator`, `nvidia-device-plugin`, `kube-system`) |
| Node and namespace labels we set | `nip.nebius.io/<key>` | `nip.nebius.io/gpu`, `nip.nebius.io/infiniband`, `nip.nebius.io/team`; `nip.nebius.io/nvl`, `nip.nebius.io/nvl-rack` (R15 nodes); `nip.nebius.io/stage` (R16 Kueue objects, from the overlay) |
| Recommended app labels | `app.kubernetes.io/name`, `app.kubernetes.io/part-of: <prefix>-<stack>` | `vllm`, `stage-dataset`, `vllm-bench`; `part-of: nip-inference`, `nip-training`, `nip-data` |
| Objects we add to a cluster by hand | `<prefix>-<function>`, in their own namespace, never `kube-system` | `nip-portal/nip-portal-read` (non-Nebius clusters only); R16 Kueue: Topology `nip-ib`, ResourceFlavor `nip-gpu-ib`, ClusterQueues `nip-team-<team>` in cohort `nip-gpu`, LocalQueue `gpu` per team namespace |
| Never set | `kubernetes.io/*`, `k8s.io/*` (ignored by MK8s), `nebius.com/*`, `topology.nebius.com/*` (Nebius's) | — |

### Every current use

| Object | Name produced | Code |
|---|---|---|
| Stage project | `nip-<stage>` | [`live/foundation/main.tf`](../terraform/live/foundation/main.tf) line 43 |
| State bucket | `tfstate-nip-<stage>-<hash>` | `live/foundation/main.tf` line 53; [`bootstrap-backend.sh`](../scripts/bootstrap-backend.sh) line 97 |
| State identity (SA and group) | `nip-tfstate-<stage>` (read-write); `nip-tfstate-ro-<stage>` (read-only, the pipeline's plan job) | `live/foundation/main.tf` lines 62, 75; `bootstrap-backend.sh` lines 139, 159 |
| State access key | `nip-tfstate-<stage>-<stack>-<UTC yyyymmddhhmmss>` (bootstrap, e.g. `nip-tfstate-sandbox-inference-20261011101500`); CI keys `nip-tfstate-<stage>-ci-<UTC yyyymmddhhmmss>` (`<stage>` environment) and `nip-tfstate-ro-<stage>-ci-<UTC yyyymmddhhmmss>` (`<stage>-plan`) | `bootstrap-backend.sh` line 209; [`credential-rotation.md`](../runbooks/credential-rotation.md) line 67 |
| CI apply / plan identity | `nip-ci-<stage>`, `nip-ci-plan-<stage>`, key `<name>-key` | `live/foundation/main.tf` lines 86, 99; [`ci-service-account/main.tf`](../terraform/modules/foundation/ci-service-account/main.tf) line 43 |
| CI secret-reader group | `nip-ci-<stage>-secrets` | `live/foundation/main.tf` line 123 |
| Portal identity | SA `nip-portal-viewer`, tenant group `nip-portal-viewers` (on MK8s the portal uses this IAM identity, group `nebius:viewer`); for non-Nebius clusters only, Kubernetes SA, ClusterRole and binding `nip-portal-read` in namespace `nip-portal` | [`credentials.md`](credentials.md#kubernetes-read-only-token) |
| R8 copy identity | SA and group `nip-<stage>-copy`, keys `nip-<stage>-copy-transfer-<UTC yyyymmddhhmm>`, `nip-<stage>-copy-k8s-<UTC yyyymmddhhmm>` | [`credentials.md`](credentials.md#object-storage-access-key-for-r8); [`runbooks/data.md`](../runbooks/data.md) line 39 |
| Grafana admin secret | `nip-<stage>-grafana-admin` | `credentials.md` line 231 |
| MK8s cluster | `nip-<stage>-inference`, `nip-<stage>-training` (the stack default when `cluster_name` is null; every stage's tfvars also sets it, and each live root's test pins it) | `terraform/live/<stage>/{inference,training}/<stage>.auto.tfvars` line 6; `stacks/{inference,training}/main.tf` `local.cluster_name` |
| Node groups | `<cluster>-ng-cpu`, `<cluster>-ng-gpu` | [`stacks/inference/main.tf`](../terraform/stacks/inference/main.tf) lines 131, 154; [`stacks/training/main.tf`](../terraform/stacks/training/main.tf) lines 153, 176 |
| Shared filesystem | `<cluster>-shared-fs` (both stacks; `modules/filestore` has no default name) | `stacks/inference/main.tf` line 120; `stacks/training/main.tf` line 142 |
| GPU cluster | `<cluster>-<fabric>` | `stacks/training/main.tf` line 130 |
| Soperator | upstream names derived from `company_name = nip-<stage>` | `terraform/live/<stage>/soperator/stage.tfvars` |
| R7 network | `nip-<stage>-network`, pool `…-private`, subnets `…-workload`, `…-edge`, groups `…-workload`, `…-nat`, `…-bastion`, route table `…-egress`, route `via-nat`, VMs `…-nat`, `…-bastion`, disks `…-nat-boot`, `…-bastion-boot`, allocations `…-nat-public`, `…-bastion` | [`stacks/network/main.tf`](../terraform/stacks/network/main.tf) `local.name`, [`edge.tf`](../terraform/stacks/network/edge.tf) (input `name`, null = `nip-<stage>-network`) |
| R8 data | buckets `nip-<stage>-datasets-<suffix>`, `nip-<stage>-checkpoints-<suffix>`, `nip-<stage>-fs-<suffix>`; filesystem `nip-<stage>-data`; transfer `nip-<stage>-ingest` | [`stacks/data/main.tf`](../terraform/stacks/data/main.tf) lines 76, 93, 123, 136, 153 |
| R9 governance | pricing policies `nip-<stage>-spot-<platform>`, project limits `nip-<stage>-cbg-<key>` | [`stacks/governance/main.tf`](../terraform/stacks/governance/main.tf) `nebius_billing_v1_pricing_policy.spot_cap`, `nebius_capacity_v1_capacity_allowance.project_limit` |
| R10 GPU VM | VM and private allocation `nip-<stage>-gpu-vm` (input `name`, null = that), boot disk `…-boot`, public allocation `…-public`, security group `…-access`, rules `allowlist`, `deny-other-ingress`, `egress`; filesystem mount tag `nip-fs` | [`stacks/gpu-vm/main.tf`](../terraform/stacks/gpu-vm/main.tf) `local.name` |
| R12 ML services | registry `nip-<stage>`, service account `nip-<stage>-node-sa`, group `nip-<stage>-image-pullers`, MLflow `nip-<stage>-mlflow`, PostgreSQL `nip-<stage>-pg`; SecretStash keys `mlflow-admin-password`, `postgresql-password` | [`stacks/ml-services/main.tf`](../terraform/stacks/ml-services/main.tf) `local.prefix`; [`runbooks/ml-services.md`](../runbooks/ml-services.md) |
| R13 CI federation | federated credentials `nip-<stage>-gha-apply`, `nip-<stage>-gha-plan`; team groups `nip-team-<key>` | [`ci-federation/main.tf`](../terraform/modules/foundation/ci-federation/main.tf) |
| R14 observability | nothing in the cloud; the static key it reads with follows the access-key rule (`nip-portal-viewer-o11y-<UTC yyyymmddhhmm>`) | [`recipes/observability`](../recipes/observability/README.md), [`credentials.md`](credentials.md#observability-static-key) |
| R15 NVL72 | NVLink instance groups `nip-<stage>-nvl-rack-<nnn>`, node groups `nip-<stage>-nvl-ng-rack-<nnn>` (in R3's cluster; node group names are tenant-unique, so the stage stays in the name) | [`stacks/nvl/main.tf`](../terraform/stacks/nvl/main.tf) `local.name` |
| R16 team scheduling | namespaces `team-nlp`, `team-vision`; Kueue `nip-ib`, `nip-gpu-ib`, `nip-team-<team>`, cohort `nip-gpu`, LocalQueue `gpu` | [`workloads/kueue`](../workloads/kueue/README.md) |
| FOCUS export bucket (portal) | `nip-billing-export-<project suffix>` (observed; created by hand, not by code) | [`docs/portal/nebius-setup.md`](portal/nebius-setup.md) |
| CLI profile on a CI runner | `nip-ci-<last 8 of SA id>` (local, in a throwaway config deleted after the token is minted; not a cloud resource) | [`ci-token.sh`](../scripts/ci-token.sh) line 91 |

## 5. Labels

### What Nebius documents

- `metadata.labels` is a `map<string,string>` on every resource. "Keys and values can be arbitrary"
  ([cost allocation labels](https://docs.nebius.com/signup-billing/usage/cost-allocation-labels)).
  **Length, character set and maximum count are not documented**, in the docs or the OpenAPI.
  Official examples use dots in keys and semicolons in values
  (`nebius.o11y.systemd-logs-collection.units=kubelet.service;containerd.service`,
  [journald logs](https://docs.nebius.com/kubernetes/logs#how-to-enable-journald-logs)).
- **Cost allocation** works only for Compute billable resources (VMs, disks, shared filesystems);
  labels on other resources do not reach the billing report. Filter or group by label on Billing →
  Usage, or read the `Tags` column (`map<string, string>`) of the usage export
  ([FOCUS fields](https://docs.nebius.com/signup-billing/usage/focus-fields#focus-defined-fields)).
- A node group's own `labels` are not documented to reach its VMs.
  `template.instance_metadata.labels` is: "Labels propagated into Compute Instance metadata"
  ([schema](https://docs.nebius.com/terraform-provider/reference/resources/mk8s_v1_node_group#nested-schema-for-templateinstance_metadata)).
  Changing them recreates the nodes.
- The Terraform provider's `default_labels` applies labels to every resource that supports them;
  resource labels win ([provider](https://docs.nebius.com/terraform-provider/reference/provider#optional)).

### Our label set

Keys are `nip-[a-z-]{1,30}` (the portal's cost grouping accepts only that,
[`commercial/router.ts`](../portal/plugins/nebius-estate-backend/src/commercial/router.ts) line 53).
Values are lowercase `[a-z0-9-]`, at most 63 characters, except `nip-ttl-expires`.

| Key | Values | Set by | Required | Cost-allocation role |
|---|---|---|---|---|
| `nip-stage` | `sandbox`, `staging`, `prod` | the stack (`merge(var.labels, …)`), foundation per stage | always | primary split: stage |
| `nip-stack` | the stack: `inference`, `training`, `network`, `data`, `gpu-vm`, `ml-services`, `governance`, `nvl` | the stack (`merge(var.labels, …)`) | always | split by recipe; the portal maps it to `terraform/live/<stage>/<stack>` |
| `nip-env` | **deprecated** twin of `nip-stack` (same value) | stage tfvars; the stack fills it when absent | kept for one release | read only when `nip-stack` is absent (`leftovers.sh`, the portal until it reads `nip-stack`) |
| `nip-region` | a region ID | the stack | always | split by region |
| `nip-owner` | a team, `platform` today | stage tfvars | always | split by team |
| `nip-run` | a ticket, date or run ID; the stage name for long-lived stages | `TF_VAR_labels` (sandbox) or tfvars | always; the plan fails without it | per-run spend and residue |
| `nip-ttl-expires` | RFC 3339 UTC, exactly `YYYY-MM-DDTHH:MM:SSZ`, e.g. `2026-10-31T18:00:00Z` | `TF_VAR_labels` at plan time | where `require_ttl_label` is true (sandbox) | expiry report; not a cost split |
| `nip-layer` | `foundation` | foundation root | foundation objects only | separates foundation from stacks |
| `nip-purpose` | `workload`, `nat`, `bastion`; `gpu-vm-access` | R7; R10 | security groups only | none |
| `nip-ci-job` | `apply`, `plan` | R13 | federated credentials only | none |

Rules:

- The stack sets `nip-stage`, `nip-region` and `nip-stack`; nobody passes them by hand.
- Node VMs carry the set when `propagate_cost_labels = true`, the default for new clusters.
  Without it, Billing → Usage cannot split node spend by `nip-*`; the portal still attributes nodes
  through the `mk8s-*` labels ([section 6](#6-how-the-portal-and-scripts-recognise-defaults-and-managed-resources)).
  The per-run `nip-run` / `nip-ttl-expires` are left out of that copy so a new run does not recreate
  the nodes. Changing the flag on an existing cluster, or any other label while it is true, does.
- `nip-ttl-expires` contains colons, which Kubernetes label values do not allow: never copy `nip-*`
  labels into Kubernetes `node_labels` or object labels.
- The detail of each label's lifecycle is in [`cost.md` → Required labels](cost.md#required-labels).

## 6. How the portal and scripts recognise defaults and managed resources

Order of evidence: an explicit field, then a Nebius-set label, then a name pattern. Name patterns
only label things for display; nothing is deleted or flagged as an orphan on a name match alone.

| Signal | Means | Where |
|---|---|---|
| `status.default == true` on a network, subnet, security group or route table | project default; never unattributed, never orphaned | [`nebius-mappers.ts`](../portal/plugins/nebius-estate-backend/src/inventory/nebius-mappers.ts) `markPlatformDefault` (line 192) |
| label `mk8s-node-group-id` or `mk8s-cluster-id` on a VM or disk | created by Managed Kubernetes; inherits the attribution of its cluster | `nebius-mappers.ts` `mk8sManagedRefs` (line 135); [`resources.ts`](../portal/packages/nebius-domain/src/resources.ts) `attributeWithParents` (line 237) |
| `spec.providerID` contains `computeinstance-<id>` | the VM behind a Kubernetes node | [`kubernetes.ts`](../portal/plugins/nebius-estate-backend/src/inventory/kubernetes.ts) line 83 |
| a node label value matching `^mk8snodegroup-[a-z0-9]+$` | the node's node group | `kubernetes.ts` line 88 |
| disk name `pvc-*` with no labels | CSI volume; attribute through the PVC | `nebius-mappers.ts` line 128; [`leftovers.sh`](../scripts/leftovers.sh) line 64 |
| VPC kinds without `nip-*` labels | not reported as residue (every project has defaults) | `leftovers.sh` lines 58–62 (`--labelled-only`) |
| any `nip-*` label | ours; attribution comes from labels only, "whatever its name looks like" | `resources.ts` `attribute` (line 255) |

Patterns to use where no field exists (fallback only):

```text
^default-project-[a-z]+-[a-z]+[0-9]$                        sign-up project
^default-(network|public-pool)$                             VPC defaults (docs)
^default-(subnet|network-pool)(-[a-z0-9]+)?$                VPC defaults (docs name, observed suffix)
^default-(route-table|security-group)-[a-z0-9]+$            VPC defaults
^mk8snodegroup-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$               MK8s node VM and its boot disk
^mk8snodegroup-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+-(private|alias|public)$   node allocations
^pvc-[0-9a-f-]+$                                            CSI disk
```

Not recognised yet: pools (`mapPool` reads no default marker, so `default-network-pool-*` can show
as unattributed), the per-cluster MK8s system security group, and the `nebius.com/managed-by: mk8s`
label on load balancer allocations. Each needs the explicit field confirmed live before a name
pattern is used.

## 7. Inconsistencies in the repository today

Found by the naming audit of 2026-10-11; the **Status** column records what was done the same day.
Renaming a Terraform-managed object replaces it (new ID; for filesystems, new and empty), so a fix
lands only where nothing is affected: the stacks never applied (network, data, training,
foundation) or a default that every applied stage already overrides. The one applied stack,
sandbox inference, keeps `nip-sandbox-inference` and `nip-sandbox-inference-shared-fs`
(asserted by its live root's test). "Where" and "Today" describe the code before the change.
Live roots under `terraform/live/<stage>/<stack>/variables.tf` are generated by
[`render-live-roots.py`](../scripts/render-live-roots.py) and follow the stack.

| # | Where | Today | Proposed | Notes | Status |
|---|---|---|---|---|---|
| 1 | [`stacks/network/variables.tf`](../terraform/stacks/network/variables.tf) line 35; `terraform/live/<stage>/network/<stage>.auto.tfvars` (no `name`) | R7 names have no stage: `nip`, `nip-workload`, `nip-nat`, disks `nip-nat-boot`, `nip-bastion-boot` | set `name = "nip-<stage>-network"` per stage, giving `nip-sandbox-network-nat-boot` etc. | disk names are tenant-unique, so two stages in one tenant would clash on the boot disks. R7 has not been applied yet: change before the first apply | **Done**: `name` defaults to null → `nip-<stage>-network` (`local.name`); tested |
| 2 | [`stacks/network/edge.tf`](../terraform/stacks/network/edge.tf) line 58 | route `default-via-nat` | `via-nat` | our object starts with Nebius's `default-` prefix and matches the defaults pattern | **Done**: route `via-nat`; tested |
| 3 | [`stacks/inference/variables.tf`](../terraform/stacks/inference/variables.tf) line 35 (and generated `live/*/inference/variables.tf` line 28) | `cluster_name` default `nip-lab` | no default (required), or `nip-sandbox-inference` | every stage's tfvars already overrides it; the default yields stage-less, tenant-clashing node group names | **Done**: default null → `nip-<stage>-inference`, validated; sandbox tfvars unchanged, so the live cluster keeps its name |
| 4 | [`stacks/training/variables.tf`](../terraform/stacks/training/variables.tf) line 35 (and `live/*/training/variables.tf` line 28) | `cluster_name` default `nip-training` | as item 3 | same | **Done**: default null → `nip-<stage>-training`, validated |
| 5 | [`stacks/training/main.tf`](../terraform/stacks/training/main.tf) line 140 vs [`stacks/inference/main.tf`](../terraform/stacks/inference/main.tf) line 118 and [`modules/filestore/variables.tf`](../terraform/modules/filestore/variables.tf) line 7 | training filesystem `<cluster>-datasets`; inference `<cluster>-shared-fs`; module default `nip-shared-fs` (no stage) | `<cluster>-shared-fs` in both stacks; module default removed | `datasets` is also the R8 bucket role. Filesystem names are immutable: apply only to new clusters | **Done**: training uses `<cluster>-shared-fs`; `modules/filestore` `name` is required (no default). Training was never applied |
| 6 | [`live/foundation/main.tf`](../terraform/live/foundation/main.tf) line 53; [`bootstrap-backend.sh`](../scripts/bootstrap-backend.sh) line 97 | state bucket `tfstate-nip-<stage>-<hash>` | `nip-<stage>-tfstate-<hash>` for new tenants only | the only name not starting with the prefix. Renaming means a new bucket and a state migration: keep as a documented exception for existing stages | **Kept** as the current convention (section 4, Buckets): a rename means a new bucket and a state migration for every root |
| 7 | `live/foundation/main.tf` lines 62, 75, 86, 99, 123; `bootstrap-backend.sh` lines 139, 159 | stage in last or middle place: `nip-tfstate-<stage>`, `nip-ci-<stage>`, `nip-ci-plan-<stage>`, `nip-ci-<stage>-secrets` | `nip-<stage>-tfstate`, `nip-<stage>-ci`, `nip-<stage>-ci-plan`, `nip-<stage>-ci-secrets` | the rest of the repo puts the stage second (`nip-<stage>-copy`, `nip-<stage>-grafana-admin`, clusters, buckets). A rename recreates the service accounts (new IDs in the GitHub environments): new tenants only | **Kept** as the current convention (section 4, IAM): a rename recreates the identities and their keys and permits |
| 8 | `bootstrap-backend.sh` line 209; [`runbooks/credential-rotation.md`](../runbooks/credential-rotation.md) line 67; [`runbooks/data.md`](../runbooks/data.md) line 39; [`credentials.md`](credentials.md) line 226 | four key-name shapes: `…-<stack>-<epoch>`, `…-ci-<yyyymmdd>`, `…-copy-<epoch>`, none | `<identity name>-<consumer>-<UTC yyyymmddhhmm>` | keys are not Terraform-managed; safe to change now | **Done**: one shape in `bootstrap-backend.sh`, `credential-rotation.md`, `runbooks/data.md`, `credentials.md`; the state keys (bootstrap and CI) carry seconds, `yyyymmddhhmmss`, since 2026-10-11 10:15Z (two bootstraps in one minute collided). Authorized keys (`auth-public-key create`) are still unnamed in the docs' commands |
| 9 | [`cost.md`](cost.md) line 83; [`resources.ts`](../portal/packages/nebius-domain/src/resources.ts) line 193; every stack's `labels` default | `nip-env` holds the stack name | add `nip-stack` with the same value, read `nip-stack ?? nip-env` in the portal and `leftovers.sh`, drop `nip-env` after one release | "env" reads as stage. Label updates are in place, except on node VMs with `propagate_cost_labels = true`, where they recreate the nodes | **Done** outside the portal: the stacks set `nip-stack` (and fill `nip-env` when absent); `leftovers.sh --stack` reads `nip-stack`, then `nip-env`; `cost.md` marks `nip-env` deprecated. The portal's `resources.ts` reads `nip-stack` first (portal change, tracked with the portal) |
| 10 | `live/foundation/main.tf` line 20; `stacks/network/main.tf` line 113 | `nip-layer` and `nip-purpose` are set but missing from the label table in `cost.md` and from `NIP_LABELS` | add both to `cost.md` "Required labels" (as optional) and to `NIP_LABELS` | documentation only | **Done**: `cost.md` lists both, and the portal's `NIP_LABELS` has `layer` and `purpose` |
| 11 | `stacks/inference/variables.tf` line 332; `stacks/training/variables.tf` line 342 | `propagate_cost_labels` defaults to `false` | `true` for new clusters | without it the largest Compute cost (GPU nodes) has no `nip-*` cost allocation labels in Billing. Changing it on an existing cluster recreates every node | **Done**: default `true`, without the per-run `nip-run` / `nip-ttl-expires` (tested in both stacks); the description warns that a change recreates nodes |
| 12 | [`kubernetes.ts`](../portal/plugins/nebius-estate-backend/src/inventory/kubernetes.ts) line 87 | comment and code: "the label key is not documented"; matches any label value | read `nebius.com/node-group-id` first, keep the value match as fallback | the key is in the docs ([Kueue example](https://docs.nebius.com/kubernetes/gpu/topology-aware-scheduling#how-to-enable-topology-aware-scheduling)) | In progress in the portal: `kubernetes.ts` reads `nebius.com/node-group-id` first (portal change, tracked with the portal) |
| 13 | [`stacks/data/main.tf`](../terraform/stacks/data/main.tf) line 9; [`stacks/data/variables.tf`](../terraform/stacks/data/variables.tf) line 33 | "Bucket names are global" | "Bucket names are unique per region" | the docs say region; comment-only change | **Done** |
| 14 | `stacks/{inference,training}/variables.tf` line 47; [`modules/network/variables.tf`](../terraform/modules/network/variables.tf) line 15 | `subnet_name` default `default-subnet` | `null` (require `subnet_id`, which bootstrap exports) | current default subnets are `default-subnet-<suffix>`, so the default only matches older projects; the variable description already says so | **Done**: default null in both stacks and `modules/network`, with a precondition asking for `subnet_id` (exported by `bootstrap-backend.sh`) or `subnet_name` |
| 15 | `stacks/inference/main.tf` line 176; `stacks/training/main.tf` lines 198–199; `workloads/inference/base/deployment.yaml` line 24; `workloads/training/nccl/base/mpijob.yaml` line 52; `workloads/training/ddp/pytorchjob.yaml` line 20; `recipes/team-platform/skypilot/config.yaml` line 17; `recipes/team-platform/namespaces/namespace.yaml` line 6 | Kubernetes label prefix `nip.nebius.io/` | keep, documented here as ours (not set by Nebius, whose prefixes are `nebius.com/` and `topology.nebius.com/`); move to a domain the platform team owns only when carrying the standard elsewhere | node label changes reach new nodes only, so a move needs the node groups, selectors and SkyPilot config changed together | **Kept**, as proposed |
| 16 | [`workloads/inference/base/kustomization.yaml`](../workloads/inference/base/kustomization.yaml) line 15 vs `workloads/training/*/kustomization.yaml`, `workloads/data/copy-job/kustomization.yaml` | only inference sets `app.kubernetes.io/part-of` (`nip-inference`) | add `part-of: nip-training` and `nip-data` | manifests only | **Done**: object metadata only (no selectors or pod templates) |
| 17 | `credentials.md` lines 127–130 | Kubernetes ServiceAccount, ClusterRole and binding `nebius-estate-read` in `kube-system` | `nip-portal-read` | a `nebius-` object in `kube-system` reads as a Nebius-installed component; manual objects, safe to change with the portal config | **Done**: `nip-portal-read` in namespace `nip-portal`, needed only for non-Nebius clusters; on MK8s the portal uses its Nebius IAM identity (group `nebius:viewer`) |
| 18 | [`leftovers.sh`](../scripts/leftovers.sh) line 7; `terraform/live/<stage>/soperator/stage.tfvars` | the vendored Soperator recipe sets no `nip-*` labels | pass the label set through the recipe's own label inputs where it has them; otherwise list Soperator spend by project | today R4 spend is visible only per project, not per `nip-*` label | **Open** |

Docs-versus-tenant differences found while writing this (report upstream, see
[`upstream-findings.md`](upstream-findings.md)): default subnet and pool names carry a suffix the docs
omit; two `default-network-pool-*` pools exist per network where the docs name
`default-network-pool` and `default-public-pool`; the `mk8scluster-`, `mk8snodegroup-` and
`accesskey-` prefixes and the `mk8s-*` VM labels appear nowhere in the docs.
