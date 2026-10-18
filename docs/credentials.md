# Credentials

How to create, store and hand over every credential that [`.env.example`](../.env.example) names.
Each Nebius step cites the documentation section it follows. A step marked **not in the Nebius
docs** is plain Kubernetes or a repository convention.

## Storage rules

- `.env`: `cp .env.example .env && chmod 600 .env`. It is git-ignored. Fill in only what you use.
- Private keys are **files** under `secrets/` (git-ignored, mode 600). `.env` holds only their
  path. A key never goes into `.env`, a tfvars file, a commit or a ticket.
- `make env-status` lists which slots are set without printing values. It also checks that
  `.env` and `secrets/` are private.
- `set -a; source .env; set +a` loads the file into one shell. CI never reads `.env`; it uses
  GitHub Environment secrets ([change management](change-management.md)).
- Real IDs stay in `.env` and the secret stores, never in git (CONTRIBUTING).
- Expiry: every key gets `--expires-at`. Rotation and revocation are in
  [`runbooks/credential-rotation.md`](../runbooks/credential-rotation.md).

## Never stored

| Credential | Lifetime | How it is obtained |
|---|---|---|
| `NEBIUS_IAM_TOKEN`, `TF_VAR_iam_token` (user) | ~12 h | `nebius iam get-access-token` ([access tokens](https://docs.nebius.com/iam/authorization/access-tokens#getting-an-access-token)); `scripts/bootstrap-backend.sh` exports it per shell |
| `TF_VAR_iam_token` (CI) | ~12 h | `scripts/ci-token.sh` mints it from the stage's CI key |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (local state) | 1 day | `scripts/bootstrap-backend.sh` mints them per session |

The live roots declare the token `ephemeral`, so it never reaches a plan or state.

## Account scope

| Variable | Where it comes from |
|---|---|
| `NEBIUS_TENANT_ID` | console tenant picker, or [get a tenant ID](https://docs.nebius.com/iam/get-tenants#how-to-get-a-tenant-id) |
| `NEBIUS_PROJECT_ID`, `NEBIUS_PROJECT_IDS` | `nebius iam v2 project list --parent-id <tenant ID>` ([projects](https://docs.nebius.com/iam/manage-projects#how-to-get-a-project-id)) |
| `NEBIUS_REGION`, `NEBIUS_PROFILE` | `platform/regions.yaml`; your CLI profile name |

## Portal read-only service account

This fills `NEBIUS_SA_ID`, `NEBIUS_SA_PUBLIC_KEY_ID` and `NEBIUS_SA_PRIVATE_KEY_FILE`.

**Who runs it:** an administrator. Managing groups needs `admin`. Uploading an authorized key
needs `admin`, and the docs list tenant `admin` as its prerequisite
([authorized keys](https://docs.nebius.com/iam/service-accounts/authorized-keys#creating-a-key-pair)).

**Which group:** a custom group, not the default `viewers` group. The default groups carry
tenant-wide roles ([default groups](https://docs.nebius.com/iam/authorization/groups#default-groups)).
`viewer` can also read data, for example download bucket objects
([roles](https://docs.nebius.com/iam/authorization/roles#general-roles)).

A custom group with one `viewer` permit per listed project limits the account to those projects
([custom groups](https://docs.nebius.com/iam/authorization/groups#custom-groups)).
`security-auditor` alone is not enough: it cannot list shared filesystems or billing, which the
portal reads. Three tenant-wide reads need tenant permits on top ([step 2b](#tenant-reads)).

1. Create the service account
   ([service accounts](https://docs.nebius.com/iam/service-accounts/manage#creating-a-service-account)):

   ```bash
   export SA_ID=$(nebius iam service-account create --name nip-portal-viewer \
     --parent-id <home project ID> --format jsonpath='{.metadata.id}')
   ```

2. Create the group and grant one `viewer` permit per project
   ([custom groups](https://docs.nebius.com/iam/authorization/groups/manage#setting-up-custom-groups)).
   Use a tenant-level group when the portal lists several projects: a group created inside a
   project can only hold permits for that project.

   ```bash
   export GROUP_ID=$(nebius iam group create --parent-id <tenant ID> \
     --name nip-portal-viewers --format jsonpath='{.metadata.id}')
   for p in <project ID> <project ID>; do
     nebius iam access-permit create --parent-id "$GROUP_ID" --resource-id "$p" --role viewer
   done
   ```

   <a id="tenant-reads"></a>**2b. Tenant reads (optional, each one enables a portal page).** Project
   permits cannot see tenant-level objects. The portal's full grant set is:

   | Permit on | Role | Enables | Trade-off |
   |---|---|---|---|
   | each listed project | `viewer` | inventory, quotas per project, monitoring, Kubernetes reads | also reads data in those projects (bucket objects) |
   | tenant | `security-auditor` | tenant project discovery, capacity block groups, capacity advice | configuration only, no data ([roles](https://docs.nebius.com/iam/authorization/roles#security)) |
   | tenant | `viewer` | contract prices (`resource.billinggroup.get`) | `viewer` on the tenant reads data in **every** project, including bucket objects ([roles](https://docs.nebius.com/iam/authorization/roles#general-roles)) |
   | tenant | `auditlogs.audit-event-viewer` | audit events on the Logs page (who did what to which resource, per region) | reads every audit event in the tenant, including who called and from where; the portal keeps only time, caller, action, resource and result ([roles](https://docs.nebius.com/iam/authorization/roles#audit-logs)) |

   Skip the tenant `viewer` permit when tenant-wide data access is unacceptable: the portal then
   shows list prices and per-project quotas, and says so.

   ```bash
   nebius iam access-permit create --parent-id "$GROUP_ID" --resource-id <tenant ID> --role security-auditor
   nebius iam access-permit create --parent-id "$GROUP_ID" --resource-id <tenant ID> --role viewer
   nebius iam access-permit create --parent-id "$GROUP_ID" --resource-id <tenant ID> --role auditlogs.audit-event-viewer
   nebius iam access-permit list --parent-id "$GROUP_ID" --all --format json | jq -r '.items[] | "\(.spec.role) \(.spec.resource_id)"'
   ```

3. Add the account to the group and check it
   ([members](https://docs.nebius.com/iam/authorization/groups/members#adding-a-service-account)):

   ```bash
   nebius iam group-membership create --parent-id "$GROUP_ID" --member-id "$SA_ID"
   nebius iam group-membership list-members --parent-id "$GROUP_ID" | grep "$SA_ID"
   ```

4. Create the key pair and register the public half with an expiry
   ([key pair](https://docs.nebius.com/iam/service-accounts/authorized-keys#creating-a-key-pair),
   [upload](https://docs.nebius.com/iam/service-accounts/authorized-keys#uploading-the-public-key)).
   Setting mode 600 is the repository's rule.

   ```bash
   umask 077
   openssl genrsa -out secrets/portal-viewer.pem 4096
   openssl rsa -in secrets/portal-viewer.pem -outform PEM -pubout -out portal-viewer.pub.pem
   nebius iam auth-public-key create --account-service-account-id "$SA_ID" \
     --data "$(cat portal-viewer.pub.pem)" --expires-at <ISO 8601> --format jsonpath='{.metadata.id}'
   ```

   `nebius iam auth-public-key generate` is the alternative. It writes a JSON credentials file,
   not a PEM. The PEM is that file's `private_key` field.

| Value | Variable |
|---|---|
| service account `.metadata.id` (`serviceaccount-…`) | `NEBIUS_SA_ID` |
| authorized key `.metadata.id` (`publickey-…`); list later with `nebius iam auth-public-key list-by-account --account-service-account-id "$SA_ID" --format json` ([provider auth](https://docs.nebius.com/terraform-provider/authentication#authentication-for-a-service-account)) | `NEBIUS_SA_PUBLIC_KEY_ID` |
| path of `secrets/portal-viewer.pem` | `NEBIUS_SA_PRIVATE_KEY_FILE` |
| projects that received a permit in step 2 | `NEBIUS_PROJECT_IDS` |

The public `.pub.pem` file is not secret and can be deleted once it is registered.

For read-only command-line work (the Kubernetes MCP server, `scripts/get-kubeconfig.sh`,
`leftovers.sh`), make a CLI profile from the same key. Activate your admin profile again afterwards,
because `profile create` makes the new one the default:

```bash
nebius profile create nip-portal-viewer --endpoint api.nebius.cloud --service-account-id "$SA_ID" \
  --public-key-id <publickey ID> --private-key-file-path "$PWD/secrets/portal-viewer.pem" --parent-id <project ID>
nebius profile activate <your admin profile>
```

`make env-status LIVE=1` proves the key still mints a token and warns 30 days before any key of the
account expires.

Check it the portal's way: start the backend and open **Integrations & Coverage**
([portal setup](portal/nebius-setup.md)). The backend signs a short-lived JWT with these three
values ([JWT](https://docs.nebius.com/grpc-api/auth#create-a-jwt)).

## Observability static key

This fills `PROMETHEUS_TOKEN` for tools that cannot sign a Nebius JWT, such as a Grafana you run.
The portal does not need it: its GPU telemetry connector already reads the same endpoint for every
listed project with its own service-account token. The endpoint is Nebius Observability's official
Prometheus-compatible read API
`https://read.monitoring.api.nebius.cloud/projects/<project ID>/service-provider/prometheus`
([Grafana with Nebius metrics](https://docs.nebius.com/observability/metrics/grafana)). A static key
never has more access than its service account, so issue it for the read-only portal account
([static keys](https://docs.nebius.com/iam/authorization/static-keys)):

```bash
nebius iam static-key issue --parent-id <home project ID> --account-service-account-id "$SA_ID" \
  --service OBSERVABILITY --name nip-portal-viewer-o11y-$(date -u +%Y%m%d%H%M) \
  --expires-at <ISO 8601> --format json | jq -r '.token'     # value -> PROMETHEUS_TOKEN
```

In Grafana: Prometheus data source, server URL as above, HTTP header `Authorization` = the key.

For the in-cluster Grafana of `modules/o11y` the key goes into a Kubernetes Secret in the `o11y`
namespace (key `PROMETHEUS_TOKEN`), named by `grafana_datasource_token_secret`; Grafana reads it from
its environment, so it is in no tfvars, plan or state
([runbook](../runbooks/observability.md#in-cluster-grafana-moduleso11y)).

## Kubernetes read-only token

This fills `K8S_<CLUSTER>_TOKEN`, for example `K8S_SANDBOX_INFERENCE_TOKEN`.

**Managed Kubernetes clusters need no token.** The portal authenticates to MK8s with its own
Nebius IAM identity (the service account above): the API server accepts its IAM token as user
`serviceaccount-<id>` in group `nebius:viewer`, which reads namespaces, nodes and workloads and is
refused secrets and writes ([portal setup](portal/nebius-setup.md#kubernetes)). A separate
in-cluster ServiceAccount is only needed for clusters that are **not** Nebius Managed Kubernetes.

**Not in the Nebius docs.** The only documented Nebius step is getting a kubeconfig:
`nebius mk8s cluster get-credentials --id <cluster ID> --external`, or `--internal` from a VM in
the cluster's subnet ([connect](https://docs.nebius.com/kubernetes/connect)).

For a non-Nebius cluster, everything below is plain Kubernetes RBAC. The objects are ours, so
they carry our prefix and live in their own namespace, never in `kube-system`
([naming](naming.md#kubernetes)):

```bash
kubectl apply -f nip-portal-read.yaml             # the ClusterRole in docs/portal/nebius-setup.md#kubernetes
kubectl create namespace nip-portal
kubectl -n nip-portal create serviceaccount nip-portal-read
kubectl create clusterrolebinding nip-portal-read \
  --clusterrole=nip-portal-read --serviceaccount=nip-portal:nip-portal-read
kubectl -n nip-portal create token nip-portal-read --duration=720h   # value -> K8S_<CLUSTER>_TOKEN
```

- The API server can cap `--duration`. Check the printed token's expiry and plan to re-issue it.
- Write the cluster CA to the file named in `caFile` (from the kubeconfig's
  `certificate-authority-data`).
- Revoke by deleting the binding or the ServiceAccount.

## Object Storage access key for R8

This produces the keys for a transfer (`TF_VAR_transfer_*_secret_key`) or a copy job (a cluster
Secret).

1. Create a service account as in [the portal steps](#portal-read-only-service-account), step 1,
   named after its purpose and stage, for example `nip-<stage>-copy`. Use one account per purpose.

2. Grant it the bucket roles through a group in the project
   ([required permissions](https://docs.nebius.com/object-storage/transfer/access#required-permissions),
   [storage roles](https://docs.nebius.com/iam/authorization/roles#object-storage)):
   - source bucket: `storage.viewer`;
   - destination bucket: `storage.object-editor`.

   Buckets accept access permits directly.

   ```bash
   export GROUP_ID=$(nebius iam group create --parent-id <project ID> --name nip-<stage>-copy \
     --format jsonpath='{.metadata.id}')
   nebius iam access-permit create --parent-id "$GROUP_ID" --resource-id <bucket ID> --role storage.object-editor
   nebius iam group-membership create --parent-id "$GROUP_ID" --member-id "$SA_ID"
   ```

3. Mint an expiring key
   ([access keys](https://docs.nebius.com/iam/service-accounts/access-keys#creating-a-key-pair)).
   This needs `admin`; the docs list tenant admin.

   ```bash
   # name: <identity>-<consumer>-<UTC yyyymmddhhmm> (docs/naming.md); consumer = transfer or k8s
   export ACCESS_KEY_ID=$(nebius iam v2 access-key create --account-service-account-id "$SA_ID" \
     --name nip-<stage>-copy-transfer-$(date -u +%Y%m%d%H%M) \
     --expires-at <ISO 8601> --description 'R8 copy' --format jsonpath='{.metadata.id}')
   ```

4. Read the two halves
   ([AWS CLI profile](https://docs.nebius.com/iam/service-accounts/access-keys#configuring-your-aws-cli-profile)):

   ```bash
   nebius iam v2 access-key get --id "$ACCESS_KEY_ID" --format json | jq -r '.status.aws_access_key_id'
   nebius iam v2 access-key get --id "$ACCESS_KEY_ID" --format json | jq -r '.status.secret'
   ```

| Value | Goes to |
|---|---|
| `.status.aws_access_key_id` | `transfer.source_access_key_id` / destination key id in the data root (not secret) |
| `.status.secret` | `TF_VAR_transfer_source_secret_key` or `TF_VAR_transfer_destination_secret_key` (write-only), or the `s3-credentials` Secret ([`runbooks/data.md`](../runbooks/data.md)) |

The transfer sends the secret as a write-only argument
([credentials](https://docs.nebius.com/object-storage/transfer/access#credentials-for-s3-compatible-storage-services)).
Rather than typing the secret into `TF_VAR_transfer_*_secret_key`, store it in SecretStash and
set `transfer_secret_id` ([below](#secretstash)).
Delete the key when the engagement ends: `nebius iam v2 access-key delete --id <id>`.

## SecretStash

SecretStash (the CLI, API and Terraform provider still call it `mysterybox`) holds the values
that would otherwise be typed in or kept in Terraform state:

| Secret | Payload keys | Terraform inputs (not secret) | Filled before apply |
|---|---|---|---|
| Grafana admin password (R1/R3 `modules/o11y`) | `admin-password` | `grafana_admin_secret_id`, `grafana_admin_secret_version_id` | `TF_VAR_grafana_admin_password` |
| R8 transfer keys (`stacks/data`) | `destination-secret-access-key`, `source-secret-access-key` (keyed source only) | `transfer_secret_id`, `transfer_secret_version_id` | `TF_VAR_transfer_destination_secret_key`, `TF_VAR_transfer_source_secret_key` |
| R12 MLflow admin and PostgreSQL bootstrap passwords (`stacks/ml-services`) | `mlflow-admin-password`, `postgresql-password` (one payload; [`runbooks/ml-services.md`](../runbooks/ml-services.md)) | `secret_id`, `secret_version_id` | `TF_VAR_mlflow_admin_password`, `TF_VAR_postgresql_password` |

**How the value travels.** The ids go in the stage's tfvars. Before the plan that will be
applied, whoever applies reads the payload into the ephemeral variable, which feeds only a
write-only argument: the value is in neither the plan file nor the state, only the secret and
version ids are
([sensitive values](https://docs.nebius.com/terraform-provider/sensitive-values#ephemeral-variables-and-resources)).
Terraform requires an ephemeral variable at apply exactly when it was set at plan, so export it
before `make plan` and keep it for `make apply`. A plan that is only reviewed (the plan job)
does not need it, so the plan identity never reads payloads; an apply without it is refused. The docs also show reading the payload inside Terraform with the ephemeral resource
`nebius_mysterybox_v1_secret_payload_entry`
([transfer credentials](https://docs.nebius.com/object-storage/transfer/access#credentials-for-s3-compatible-storage-services)).
This repository does not, because `terraform test` mock providers reject any configuration that
contains an ephemeral resource, and every stack and live root is plan-tested with mocks.

**Who may read.** Creating a secret or a version needs `editor`; reading a payload needs
`mysterybox.payload-viewer`, a sub-role of `admin` that `editor` does not include
([roles](https://docs.nebius.com/iam/authorization/roles#secretstash)). Secrets accept access
permits, so grant it per secret
([custom groups](https://docs.nebius.com/iam/authorization/groups#custom-groups)): list the ids in
the foundation input `stages.<stage>.ci_secret_ids`, which grants the stage's apply identity
(`editor`) payload access on those secrets only, through the group `<prefix>-ci-<stage>-secrets`.
Without the foundation, the same grant by hand:

```bash
nebius iam access-permit create --parent-id <group ID> --resource-id <secret ID> --role mysterybox.payload-viewer
```

1. Create the secret in the stage project
   ([create a secret with a version](https://docs.nebius.com/mysterybox/secrets/create#how-to-create-a-secret-with-a-version)).
   Read the value without echoing it, so it stays out of the shell history:

   ```bash
   read -rs VALUE   # Grafana: openssl rand -base64 24; R8: the access key's .status.secret
   nebius mysterybox secret create --name nip-<stage>-grafana-admin \
     --description 'Grafana admin password (modules/o11y)' \
     --secret-version-payload "$(jq -nc --arg v "$VALUE" '[{key: "admin-password", string_value: $v}]')"
   unset VALUE
   nebius mysterybox secret list                              # the mbsec-... id
   nebius mysterybox secret-version list --parent-id <secret ID>   # the mbsecver-... id
   ```

   For R8, put both keys in one payload (`destination-secret-access-key`, and
   `source-secret-access-key` when the source is not public).

2. Set the ids in the stage's tfvars (`grafana_admin_secret_id` and
   `grafana_admin_secret_version_id`, or `transfer_secret_id` and `transfer_secret_version_id`).
3. Before the plan you will apply, read the pinned version
   ([get a payload](https://docs.nebius.com/mysterybox/secrets/get#how-to-get-a-payload)):

   ```bash
   payload() {  # <secret ID> <version ID> <key>
     nebius mysterybox payload get --secret-id "$1" --version-id "$2" --format json |
       jq -er --arg k "$3" '.data[] | select(.key == $k) | .string_value'
   }
   export TF_VAR_grafana_admin_password=$(payload <secret ID> <version ID> admin-password)
   export TF_VAR_transfer_destination_secret_key=$(payload <secret ID> <version ID> destination-secret-access-key)
   ```

   The `jq` path assumes the payload JSON mirrors the provider's payload schema
   (`data[].key`, `data[].string_value`); check it on first use.

**CI.** `.github/workflows/terraform.yml` does not run step 3 yet. Until it does, a stage that
sets these ids is applied from an operator's shell (`make plan` then `make apply`), or the apply
job needs a step that runs step 3 with the CI token in the `<stage>` environment only, before its
re-plan.

Rotation: [runbooks/credential-rotation.md](../runbooks/credential-rotation.md#rotating-a-secretstash-secret).

## Billing export pull

This fills section 8 of `.env.example` (`NEBIUS_BILLING_EXPORT_*`). The portal reads the FOCUS
files a periodic export writes to a bucket; it never creates or changes the export.

1. **Periodic export (console only, `admin`).** Billing → Export → **Periodic export** tab →
   Create export: start month, project and bucket, optional prefix. One active periodic export per
   contract; files arrive about once an hour
   ([periodic export](https://docs.nebius.com/signup-billing/usage/export#periodic-export)).
2. **Read access.** Reading the files needs at least `storage.viewer` on the bucket, its project or
   the tenant ([access the files](https://docs.nebius.com/signup-billing/usage/export#how-to-access-the-export-files),
   [storage roles](https://docs.nebius.com/iam/authorization/roles#object-storage)). The portal
   account already has it through its project `viewer` permit when the bucket is in a listed
   project; otherwise add a `storage.viewer` permit on the bucket to its group.
3. **S3 key for the portal account** (`admin`;
   [access keys](https://docs.nebius.com/iam/service-accounts/access-keys#creating-a-key-pair)):

   ```bash
   export ACCESS_KEY_ID=$(nebius iam v2 access-key create --account-service-account-id "$SA_ID" \
     --name nip-portal-viewer-billing-$(date -u +%Y%m%d%H%M) \
     --expires-at <ISO 8601> --description 'portal billing export pull' --format jsonpath='{.metadata.id}')
   nebius iam v2 access-key get --id "$ACCESS_KEY_ID" --format json | jq -r '.status.aws_access_key_id'
   nebius iam v2 access-key get --id "$ACCESS_KEY_ID" --format json | jq -r '.status.secret'
   ```

| Value | Variable |
|---|---|
| bucket name, its region, the prefix from step 1 | `NEBIUS_BILLING_EXPORT_BUCKET`, `NEBIUS_BILLING_EXPORT_REGION`, `NEBIUS_BILLING_EXPORT_PREFIX` |
| `.status.aws_access_key_id` | `NEBIUS_BILLING_EXPORT_ACCESS_KEY_ID` |
| `.status.secret` | `NEBIUS_BILLING_EXPORT_SECRET_ACCESS_KEY` |

Restart the portal backend after editing `.env`: the connector reads the variables at start-up and
shows **not configured** until all of them are set. The pull is SigV4, path-style, against
`storage.<region>.nebius.cloud`.

## CI service-account keys

This fills `NIP_SA_ID`, `NIP_SA_KEY_ID` and `NIP_SA_KEY_FILE` locally, and `NIP_SA_PRIVATE_KEY`
in GitHub.

**Accounts:** the foundation root creates the apply (`editor`) and plan (`viewer`) accounts
per stage when `ci = true`. Their IDs are the outputs `ci_identities.<stage>.service_account_id`
and `ci_plan_identities.<stage>.service_account_id`.

**Keys:** the docs do not allow an account's first authorized key through Terraform
([upload](https://docs.nebius.com/iam/service-accounts/authorized-keys#uploading-the-public-key)).
Register keys with the CLI:

```bash
umask 077
openssl genrsa -out secrets/ci-<stage>.pem 4096
openssl rsa -in secrets/ci-<stage>.pem -outform PEM -pubout -out ci-<stage>.pub.pem
nebius iam auth-public-key create --account-service-account-id <service account ID> \
  --data "$(cat ci-<stage>.pub.pem)" --expires-at <ISO 8601, <= 90 days> --format jsonpath='{.metadata.id}'
```

| Value | Variable |
|---|---|
| service account ID | `NIP_SA_ID` (GitHub: `<stage>` or `<stage>-plan` environment) |
| printed key `.metadata.id` | `NIP_SA_KEY_ID` |
| `secrets/ci-<stage>.pem` | `NIP_SA_KEY_FILE` locally; its contents are the `NIP_SA_PRIVATE_KEY` environment secret |

The CI state keys (`NIP_STATE_ACCESS_KEY_ID` / `NIP_STATE_SECRET_ACCESS_KEY`) differ per environment:
`<stage>-plan` holds a key of the read-only state account (`ci_plan_state_identities`,
`storage.object-viewer`), `<stage>` one of the read-write account (`state_identities`). Mint them as in
[runbooks/credential-rotation.md](../runbooks/credential-rotation.md#rotating-the-ci-state-access-keys).

In a job the private key lives only until the token exists: `scripts/ci-token.sh` creates the CLI
profile in a throwaway config that reads the key by path (`--private-key-file-path`), mints the token and
deletes the config, and the setup action deletes the key file. Later steps hold only the short-lived
`TF_VAR_iam_token`.

**Federated path (R13), no key at all.** With the foundation's `ci_federation` set, each CI account
trusts its GitHub Environment's OIDC token (`sub` =
`repo:<owner>/<repo>:repository_owner_id:<id>:repository_id:<id>:environment:<stage>` or
`…:<stage>-plan`; the repository's OIDC `sub` template must include those ids first, and
`subject_claims = "name"` opts back into the name-only `repo:<owner>/<repo>:environment:<stage>`). The environment then holds `NIP_SA_ID` only (output `ci_federation`); delete
`NIP_SA_KEY_ID` and `NIP_SA_PRIVATE_KEY` there, and the job swaps its GitHub token for a short-lived
Nebius token at STS (`scripts/ci-token.sh`, `NIP_CI_FEDERATED=1`). Nothing to store or rotate; the
state key above stays. Steps, and retiring the authorized keys once both jobs run green:
[`runbooks/identity.md`](../runbooks/identity.md). Run live for the sandbox plan side on 2026-10-11 ([evidence](evidence/2026-10-11-sandbox-ci-federated-plan.md)); the apply side not yet.

## Other slots

| Variable | Source |
|---|---|
| `TF_VAR_allowed_cidrs` | your office or VPN egress addresses, as a JSON list; documentation ranges are refused |
| `TF_VAR_backups_password` | generate locally (`openssl rand -base64 24`); Soperator backups only |
| `TF_VAR_slurm_login_ssh_root_public_keys` | public SSH keys, not secret |
| `TF_VAR_ssh_public_key` | R10 GPU VM: your OpenSSH public key for `nip-admin`, not secret (CI: repository or environment variable `NIP_SSH_PUBLIC_KEY`, exported for `gpu-vm` only; on R1/R3 it would add a `NOPASSWD` sudo user to every node) |
| `TF_VAR_mlflow_admin_password` / `TF_VAR_postgresql_password` | R12, only when the service is enabled; read from the SecretStash secret above before the plan you apply (preferred), or generate locally. Ephemeral and write-only: never in tfvars, plan or state |
| `PROMETHEUS_TOKEN` | only when the Prometheus endpoint requires a bearer token |
| `NEBIUS_API_KEY` | Token Factory console → API keys (shown once; `scripts/store-credentials.sh NEBIUS_API_KEY`). Read by R11 [`recipes/token-factory`](../recipes/token-factory/README.md) (`list-models.sh`: free `GET /v1/models`; `smoke.py --yes`: one paid chat completion, owner's approval) and by the portal backend (connector `token-factory`, `nebiusEstate.ai.tokenFactory.apiKeyEnv`): `GET /v1/models` once per sync for the AI services page; never sent to the browser, never printed. Rotation: [`runbooks/token-factory.md`](../runbooks/token-factory.md) |
| `NIP_TF_BASE_URL` | optional, not secret: Token Factory base URL for the R11 scripts (empty = `https://api.tokenfactory.nebius.com/v1`) |
| `HF_TOKEN` | Hugging Face token settings; read-only (fine-grained: read access to gated repos). Read by the portal backend only (connector `huggingface`, `nebiusEstate.ai.huggingface.tokenEnv`): `whoami-v2`, the model API and a HEAD of each workload model's `config.json` once per sync; never downloads weights, never sent to the browser. No workload or script in this repository passes it to a model download (`grep HF_TOKEN workloads recipes`: none); the lab models are Apache-2.0 and need none |
| `GITHUB_TOKEN` | GitHub token settings; read-only scopes |
| `AUTH_GITHUB_CLIENT_ID` / `_SECRET` | the portal's GitHub OAuth app ([portal security](portal/security.md)) |
