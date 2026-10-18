# Portal connectors and Nebius APIs, read-only against a real tenant — 2026-10-11

- **Kind:** run of this repository: the portal's Nebius connectors and `yarn verify:live`
  (`portal/`), branch `feat/nebius-estate-portal` at `93c49d0` plus uncommitted changes, together
  with direct REST calls made with the same token. No Terraform root ran.
- **Date / regions:** 2026-10-11. One tenant, 9 projects, one per region: `eu-north1`, `eu-south1`,
  `eu-west1`, `eu-west2`, `me-west1`, `uk-south1`, `uk-south2`, `us-central1`, `us-north1`.
- **Identity:** a service account in a custom tenant-level group holding one `viewer` access permit
  per project and nothing at tenant level, set up as in
  [`docs/credentials.md`](../credentials.md#portal-read-only-service-account). Where a row says
  "admin identity", the call was repeated as a tenant administrator to rule out a permission effect.
  Real tenant, project, service-account and key IDs are not written here; placeholders are
  `<tenant>`, `<project>`, `<sa>`, `<key>`.
- **Versions:** Nebius public REST API as served on the day; portal versions as pinned in
  `portal/package.json` and `portal/yarn.lock` at the commit above.
- **Method:** see [Method](#method). Every call was a read except one `DELETE`, made deliberately to
  prove the token cannot write.
- **Cost:** one empty Object Storage bucket (Enhanced Throughput, `eu-west2`, created by an
  administrator as the target of the delete test) and IAM objects (service account, group, permits,
  authorized key), which are free. No compute, disks or filesystems. Billed amount: negligible (an
  empty bucket stores 0 GiB; Enhanced Throughput requests are free,
  [Object Storage pricing](https://docs.nebius.com/object-storage/resources/pricing)).
- **Caveats:** read-only. Nothing was deployed, so this shows that the APIs answer and what shape
  they answer in, not how any workload behaves. See [What this does not show](#what-this-does-not-show).

No raw output is committed with this file: the responses carry real tenant and project IDs, which
stay out of git ([`CONTRIBUTING.md`](../../CONTRIBUTING.md)). To reproduce, run `cd portal && yarn
verify:live` with your own account ([portal setup](../portal/nebius-setup.md)).
Official pages cited below are indexed, with their sections, in
[`docs/reference/nebius-docs.md`](../reference/nebius-docs.md).

## Method

1. **Token.** The portal backend signs a JWT (RS256, `kid` = authorized key ID, `iss` = `sub` =
   service-account ID, 5-minute expiry), as in
   [Create a JWT](https://docs.nebius.com/grpc-api/auth#create-a-jwt), and exchanges it over REST:

   ```http
   POST https://sts.nebius.com/oauth2/token/exchange
   Content-Type: application/x-www-form-urlencoded

   grant_type=urn:ietf:params:oauth:grant-type:token-exchange
   &requested_token_type=urn:ietf:params:oauth:token-type:access_token
   &subject_token=<JWT>
   &subject_token_type=urn:ietf:params:oauth:token-type:jwt
   ```

2. **Write refusal.** `DELETE` of the test bucket with that token.
3. **Per-project reads.** One list call per service and project (below), then `GET
   /iam/v2/projects/<project>` and `LIST /iam/v2/projects?parentId=<tenant>`.
4. **Tenant-level reads** (capacity block groups, capacity advisor, billing) to record which grant
   each needs.
5. **Quotas.** List quota allowances per project; get one by name; repeat both as an admin identity.
6. **Pricing.** `POST /billing/v1/calculator/estimate-batch` with a `CreateInstanceRequest` packed as
   an `Any` spec.
7. **Telemetry.** PromQL instant queries against the Monitoring read API.
8. **Portal.** Start the backend, open **Integrations & Coverage**, then `yarn verify:live`.

## Results

### Authentication and scope

| Check | Result |
|---|---|
| JWT exchange at `sts.nebius.com/oauth2/token/exchange` | HTTP 200, access token valid 12 h |
| `DELETE` test bucket with the token | **403 `AccessDenied`**: the account cannot write |
| `GET /iam/v2/projects/<project>` with project `viewer` | 200; returns `metadata.name` and the region (`metadata.region` / `spec.region`) |
| `LIST /iam/v2/projects?parentId=<tenant>` with project-only permits | **403**: a project-scoped identity cannot enumerate the tenant's projects; it must be told its project IDs (`NEBIUS_PROJECT_IDS`) |

The documented exchange is gRPC `TokenExchangeService/Exchange` at `tokens.iam.api.nebius.cloud`
([Get an access token](https://docs.nebius.com/grpc-api/auth#get-an-access-token)). The docs name
`sts.nebius.com/oauth2/token/exchange` only for the outward flow, Nebius access token → OIDC ID token
([WIF](https://docs.nebius.com/iam/wif#how-it-works)). Exchanging a service-account JWT there over
REST worked but is not documented. `auth.eu.nebius.com`, an older host some clients use, appears in
the docs only as a SAML audience URI in the SSO guides, never as a token endpoint.

### Per-project reads with project `viewer` (all HTTP 200)

| Service | Lists read |
|---|---|
| Compute | instances, disks, filesystems, GPU clusters, disk snapshots, platforms (25 GPU presets returned) |
| Managed Kubernetes | clusters |
| Virtual Networks | networks, subnets, pools, route tables, security groups, allocations |
| Object Storage | buckets, transfers |
| Serverless AI | endpoints, jobs, devlabs |
| Managed services | PostgreSQL clusters, MLflow clusters |
| Container Registry | registries |
| Other | Tunnels, KMS symmetric keys, SecretStash (`mysterybox`) secrets (metadata only), maintenance, DNS zones, quota allowances |

Default networks and subnets carry `status.default = true` and no labels: identify them by that
field, not by name or label.

### Tenant-level reads (refused as expected)

| Call | Result with project-only `viewer` | Grant it needs |
|---|---|---|
| Capacity block groups | 403 | a tenant-level grant |
| Capacity advisor (resource advice) | 403 | a tenant-level grant; the docs' prerequisite is `viewer` through the default `viewers` group, which is tenant-wide ([capacity advisor](https://docs.nebius.com/compute/virtual-machines/capacity-advisor#prerequisites)) |
| Calculator with contract prices | 403 | `resource.billinggroup.get` on the billing group |
| Billing pricing policies with a tenant parent | **400** (not 403) | pricing policies are per project ([pricing policy](https://docs.nebius.com/signup-billing/pricing-policy)) |

### Page-size limits

| List | Limit observed |
|---|---|
| Capacity allowances | `pageSize` ≥ 500 rejected; 200 accepted |
| NVL instance groups | "PageSize must be between 1 and 50 (or 0 for default)" |

Neither limit is on a docs page.

### Quotas

| Observation | Detail |
|---|---|
| Identity | items have **no `metadata.id`**; they are keyed by name + region |
| Limit | `spec.limit` (a uint64 string in the OpenAPI schema) is **omitted on every item**, also for an admin identity, also through get-by-name, and also where usage is above 0. The API does not expose quota limits; the console does ([view quotas](https://docs.nebius.com/overview/quotas#view-quotas)) |
| Usage state | `USED`, `NOT_USED`, `NOT_APPLICABLE` |
| GPU quota names seen | `compute.instance.gpu.h100`, `.h200`, `.b300`, `.l40s`; `compute.gpucluster.count`; `msp.cloudapps.gpu.*` |

### Pricing

`estimate-batch` returned a list price of **4.5 USD per hour** for `gpu-h100-sxm`
`1gpu-16vcpu-200gb` in `eu-north1`. This is the list price the API returned at that time on
2026-10-11, not a quote. It equals the $4.50 per GPU-hour on the
[Compute pricing](https://docs.nebius.com/compute/resources/pricing) page that day, which suggests the
GPU-hour price covers the 1-GPU preset's vCPU and RAM (the page does not say so; one preset only).

### Telemetry

| Endpoint | Result with project `viewer` |
|---|---|
| `https://read.monitoring.api.nebius.cloud/projects/<project>/service-provider/prometheus/api/v1/query` | 200: PromQL over provider metrics (the series behind the console dashboards; for GPU VMs these include the DCGM metrics listed in [Monitoring VMs](https://docs.nebius.com/compute/monitoring/virtual-machines#gpu-monitoring-metrics)) |
| `…/projects/<project>/prometheus/api/v1/query` (customer-ingested metrics) | 404 `project/bucket not found` until something has written metrics to the project |

### Storage class

The test bucket had to be Enhanced Throughput: Standard is not offered in `eu-west2`
([storage classes](https://docs.nebius.com/object-storage/storage-classes)).

### Portal

The inventory, Monitoring and pricing connectors showed `ok` in **Integrations & Coverage**.
`yarn verify:live` probed 35 capabilities: 30 `ok`, the tenant-level ones refused with the role to
grant (as expected for this identity), and **4 defects in the portal**, being fixed at the time of
writing:

1. the quota mapping, which did not match the item shape above (no `metadata.id`, no `spec.limit`);
2. and 3. two lists requested a page size above the service's limit (above);
4. the logic of one check in the probe itself.

**Second run, same day, after the fixes** (`CI=1 yarn verify:live`, 15 s): 33 `ok`, including
`quotas.allowances` (419 items across the 9 projects, keyed by name + region, limits shown as "not
reported"), `capacity.allowances` and `compute.nvl-instance-groups` with corrected page sizes, and
`billing.pricing-policies`; 3 `permission-denied` with the grant named (contract prices, capacity
block groups, capacity advice); 1 `not-configured` (node groups: no cluster exists). The probe passed.
A walk of all nine portal pages in both themes and at 390 px showed no console errors, no failed API
calls and no horizontal overflow.

## What this does not show

- **No workloads.** This run created no VM, cluster, endpoint or job, so most lists came back empty;
  item mappings for populated lists are still contract-tested against the documented shapes, not
  against live items.
- **No GPU telemetry series.** There were no GPU VMs, so no DCGM series were returned. The query
  path is proven; the metric names and labels for GPUs are not.
- **No customer-ingested metrics** (the `/prometheus` path returned 404 because nothing wrote there).
- **Quota limits are unread.** The API returned usage without limits; this run cannot say whether a
  different API or role exposes them.
- **One price, one moment.** The calculator figure is one preset in one region on one day. Contract
  prices were not read (no billing-group grant). Spot prices were not read.
- **Write paths not exercised** beyond the single refused `DELETE`.
- **Defect fixes are verified only at the API layer** (second run above); populated lists for the new
  resource types still have no live items to map.
- **Undocumented behaviour** (the REST JWT exchange at `sts.nebius.com`, page-size limits, the
  omitted quota limit) may change without notice; it is tracked in
  [gaps and discrepancies](../solutions/gaps-and-discrepancies.md).
