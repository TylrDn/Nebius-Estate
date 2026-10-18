# `modules/foundation/ci-federation` — Identity and CI federation (R13)

**Purpose.** GitHub Actions jobs act as the stage CI service accounts **without a private key**.
Each plan (`viewer`) and apply (`editor`) account gets a federated credential that trusts GitHub's
OIDC issuer for exactly one `sub` claim. The job swaps its GitHub ID token for a short-lived
Nebius access token at Nebius STS. The module also holds a reusable pattern for least-privilege
team groups that are scoped to a project.

**Used by.** [S5](../../../../solutions/S5-slurm-migration/README.md) Slurm migration ([all solutions](../../../../solutions/README.md)).

Status: applied live for sandbox on 2026-10-11 and the first federated CI plan ran green; the apply side has not run ([Evidence](#evidence)).

## Why a foundation module, not `terraform/stacks/identity`

- The CI service accounts are created by `terraform/live/foundation`, which runs on an
  administrator's token. The federated credentials have to reference those accounts, so they
  belong in the same root and the same state.
- A stage stack is applied by the stage's own CI identity. That identity holds `editor`, and
  `editor` cannot manage IAM membership: adding group members needs `admin`
  ([roles](https://docs.nebius.com/iam/authorization/roles#general-roles)). It also must never
  edit its own trust.
- A module adds no new root, backend, state or provider configuration. Because it carries a lock
  file, `make validate` and `make test` pick it up automatically
  (`TF_ROOTS` includes `terraform/modules/foundation/*/`).

## What it builds

| Resource | Notes |
|---|---|
| `nebius_iam_v1_federated_credentials.ci["<stage>/apply"]` | `subject_id` = the apply (`editor`) account; accepts `sub` = `repo:<owner>/<repo>:repository_owner_id:<id>:repository_id:<id>:environment:<stage>` (default `subject_claims = "ids"`) |
| `nebius_iam_v1_federated_credentials.ci["<stage>/plan"]` | `subject_id` = the plan (`viewer`) account; accepts `sub` = `repo:<owner>/<repo>:repository_owner_id:<id>:repository_id:<id>:environment:<stage>-plan` |
| `nebius_iam_v1_group.team[<key>]` + permits + memberships | optional team groups (`groups`), created **inside a project**, `<prefix>-team-<key>` |

A federated credential has three binding fields: `subject_id` (the service account to
impersonate), `oidc_provider.issuer_url`, which must serve `/.well-known/openid-configuration`
with a `jwks_uri` (or set `jwk_set_json`), and `federated_subject_id`, which is compared with the
token's `sub` claim
([schema](https://docs.nebius.com/terraform-provider/reference/resources/iam_v1_federated_credentials#optional),
[oidc_provider](https://docs.nebius.com/terraform-provider/reference/resources/iam_v1_federated_credentials#nested-schema-for-oidc_provider)).
The provider schema (0.6.67, checked with `terraform providers schema -json`) has no audience
field and no other claim condition. STS itself checks `aud` against a fixed value: the GitHub token
must be requested with `audience=sts.nebius.com` (R13-3, below).

## Claim scoping

The only claim that can be scoped is `sub`, so repository, ref and environment scoping must all
come from `sub`. Repositories with GitHub's immutable subject (`use_immutable_subject: true` in
`gh api repos/<owner>/<repo>/actions/oidc/customization/sub`) already send
`repo:<owner>@<owner id>/<repo>@<repository id>:environment:<env>`: use `subject_claims = "immutable"`
and leave the template alone. Otherwise:

| Scope | How it is enforced |
|---|---|
| Repository | every subject starts with `repo:<repository>:`; overrides from another repository are refused (validation). By default (`subject_claims = "ids"`) it also carries the immutable `repository_owner_id` and `repository_id`, both required inputs |
| Environment | the default subjects name the environment the job runs in. These are the same environments `.github/workflows/terraform.yml` already uses: `<stage>-plan` for plan, `<stage>` for apply |
| Ref | **through the environment**: its deployment branch/tag rules (sandbox any ref, staging `main`, prod `vX.Y.Z` tags, as the workflow's gate already requires). An environment `sub` carries no ref, so GitHub's environment rules decide which ref can reach it |
| Plan vs apply | different subjects, different accounts; a precondition refuses two identities on one subject |
| Refused | `*` in a subject (the docs describe no pattern matching, so a `*` would be matched literally or worse); `:pull_request` subjects; an apply subject without `:environment:` |

The `sub` format is GitHub's, **not in the Nebius docs**: for a job that names an environment its
default is `repo:<owner>/<repo>:environment:<name>`, which anyone who later holds that owner/name
matches (a rename, a transfer, a deleted and re-registered account). The module therefore defaults to
`subject_claims = "ids"`: the subjects carry GitHub's immutable ids,
`repo:<owner>/<repo>:repository_owner_id:<id>:repository_id:<id>:environment:<name>`, and
`repository_id` / `repository_owner_id` are required. GitHub emits that shape only after the
repository's OIDC `sub` template is set to `include_claim_keys = ["repo", "repository_owner_id",
"repository_id", "context"]`
([GitHub OIDC](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect);
steps in [`runbooks/identity.md`](../../../../runbooks/identity.md#turn-on-federation-in-the-foundation)).
Customising it changes `sub` for every workflow; until both sides match, CI fails closed.
`subject_claims = "name"` keeps the name-only default: an explicit opt-in that accepts the
re-registration risk.

## What replaces `NIP_SA_PRIVATE_KEY`

| GitHub Environment entry | Key path (today) | Federated path |
|---|---|---|
| `NIP_SA_ID` | service account id | **kept**: the account the exchange impersonates (output `github_environments.<env>.NIP_SA_ID`) |
| `NIP_SA_KEY_ID` | authorized key id | **removed** |
| `NIP_SA_PRIVATE_KEY` | PEM private key | **removed**; the job requests `id-token: write` instead |
| `NIP_STATE_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | S3 key of a state account: read-only (`ci_plan_state_identities`) in `<stage>-plan`, read-write (`state_identities`) in `<stage>` | **unchanged**: federation yields an IAM token, not an S3 key. Minting an access key per job needs `admin` ([roles](https://docs.nebius.com/iam/authorization/roles#general-roles)) |

Once a stage runs green on the federated path, delete its accounts' authorized keys
([runbook](../../../../runbooks/identity.md#retire-the-authorized-keys)). Until then both paths
work side by side.

## Token exchange in the workflow (documentation only)

Nebius STS exchanges identity credentials for short-lived Nebius access tokens or ID tokens at
`https://sts.nebius.com/oauth2/token/exchange` (RFC 8693). An external JWT is a supported token
type and can be sent as `subject_token` or `actor_token`. The default issued type is an access
token, returned in `access_token`
([STS and token exchange](https://docs.nebius.com/iam/wif#how-it-works)).
The docs show the exchange only in the outbound direction (Nebius to Google Cloud,
[example](https://docs.nebius.com/iam/wif/configure#exchange-a-nebius-access-token-for-a-nebius-id-token)).
The inbound request below is **assembled from the parameter table**: the GitHub JWT is the
actor and the service account is the subject (`subject_identifier`). Confirm it on the first live
run ([runbook](../../../../runbooks/identity.md#first-federated-run)).

```yaml
jobs:
  plan:
    environment: ${{ inputs.stage }}-plan   # sub: repo:<owner>/<repo>:repository_owner_id:<id>:repository_id:<id>:environment:<stage>-plan
    permissions:
      contents: read
      id-token: write                       # lets this job request a GitHub OIDC token; nothing else gets it
    env:
      NIP_SA_ID: ${{ secrets.NIP_SA_ID }}   # the plan account; no key id, no private key
    steps:
      - name: Nebius token from GitHub OIDC (no static key)
        run: |
          set -euo pipefail
          # tokens never in argv: the header comes from a file descriptor, the JWT from stdin
          gh_jwt="$(curl -sSf -H @<(printf 'Authorization: bearer %s\n' "${ACTIONS_ID_TOKEN_REQUEST_TOKEN}") \
            "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=sts.nebius.com" | jq -er .value)"
          echo "::add-mask::${gh_jwt}"
          resp="$(printf '%s' "${gh_jwt}" | curl -sSf -X POST https://sts.nebius.com/oauth2/token/exchange \
            -H 'Content-Type: application/x-www-form-urlencoded' \
            --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
            --data-urlencode 'requested_token_type=urn:ietf:params:oauth:token-type:access_token' \
            --data-urlencode 'subject_token_type=urn:nebius:params:oauth:token-type:subject_identifier' \
            --data-urlencode "subject_token=${NIP_SA_ID}" \
            --data-urlencode 'actor_token_type=urn:ietf:params:oauth:token-type:jwt' \
            --data-urlencode 'actor_token@-')"
          token="$(jq -er 'select(.issued_token_type == "urn:ietf:params:oauth:token-type:access_token") | .access_token' <<<"${resp}")" \
            || { echo "::error::STS refused the exchange: $(jq -c 'del(.access_token)' <<<"${resp}")"; exit 1; }
          echo "::add-mask::${token}"
          echo "TF_VAR_iam_token=${token}" >> "$GITHUB_ENV"
```

The apply job is the same with `environment: ${{ inputs.stage }}` and the apply account's
`NIP_SA_ID`. Never print the raw tokens
([security recommendations](https://docs.nebius.com/iam/wif#security-recommendations)). The
pipeline carries this as `_nip_ci_token_federated` in `scripts/ci-token.sh`, used when
`NIP_CI_FEDERATED=1`; the setup action sets it when the environment holds no private key, and
`scripts/tf-run.sh` then checks the token instead of a CLI profile (as it does on the key path in CI,
`NIP_CI=1`)
([runbook](../../../../runbooks/identity.md#how-the-pipeline-picks-a-path)).

## Threat model

| Threat | Mitigation | Residual |
|---|---|---|
| A workflow in another repository asks for the identity | `sub` begins with this repository's `owner/name` and, by default, its immutable owner and repository ids; validation refuses foreign overrides | with `subject_claims = "name"` only: a deleted repository name re-registered by someone else matches by name |
| A feature branch or fork PR runs an apply | the apply subject names the `<stage>` environment. Its deployment rules and reviewers (prod) decide which ref may run there, and `pull_request` subjects are refused | environment rules live in GitHub, not in Terraform: check them in the runbook |
| Any branch runs a plan | plan account is `viewer` only, on the stage project only (`ci-service-account`), and its state key is read-only (`storage.object-viewer`, foundation `state_reader_identity`) | `viewer` can read data, for example download bucket objects ([roles](https://docs.nebius.com/iam/authorization/roles#general-roles)); unchanged from the key path |
| A compromised step inside an allowed job | `id-token: write` only on the plan and apply jobs; third-party actions pinned by SHA (`make pins`) | that step can mint a token for the job's lifetime: same exposure as the key path, without a key to steal for later |
| A stolen long-lived key | there is none for CI: nothing to leak, nothing to rotate | the state S3 key stays static (table above) |
| Plan identity used for apply | separate accounts and subjects; precondition against a shared subject | — |
| Someone adds another trust to the account | only the foundation (admin token) manages these credentials; drift shows in its plan | IAM is among the services Audit Logs record ([services](https://docs.nebius.com/audit-logs/services)) |
| GitHub signing keys rotate | `jwk_set_json` left null, so the issuer's discovery document is used | a pinned JWKS would break CI silently: do not set it for GitHub |

## Rotation

Federated credentials hold **no secret**, so there is nothing to rotate. GitHub signs a fresh token
for each job, and STS returns a short-lived access token. The docs give 12 h for a
service-account token from a JWT exchange
([access token](https://docs.nebius.com/grpc-api/auth#get-an-access-token)); trust the response's
`expires_in` for the federated case. Revoking access is a delete: remove the credential (or the
account's group membership) in the foundation and apply. The state S3 key keeps its rotation
procedure in [`runbooks/credential-rotation.md`](../../../../runbooks/credential-rotation.md).

## Team groups (least privilege, project-scoped)

The docs' least-privilege rule: use custom groups with the narrowest roles, not the tenant-wide
default groups ([groups](https://docs.nebius.com/iam/authorization/groups#default-groups)). A
group created **in a project** can only hold permits for that project and its resources
([setting up custom groups](https://docs.nebius.com/iam/authorization/groups/manage#setting-up-custom-groups)).
Permits can target the project or a resource that accepts them: buckets, secrets, registries,
VMs and IAM objects ([custom groups](https://docs.nebius.com/iam/authorization/groups#custom-groups)).
A service account belongs to one project, but the groups it joins decide what it can reach
([accounts and members](https://docs.nebius.com/iam/overview#accounts-and-members)).

```hcl
groups = {
  ml-readers = {
    project_id = "project-e00example"
    permits = { # label => permit; labels key the objects, so IDs may be known only at apply
      project = { role = "viewer" }                                                 # the project
      data    = { role = "storage.object-viewer", resource_id = "<bucket ID>" }     # one bucket
      token   = { role = "mysterybox.payload-viewer", resource_id = "<secret ID>" } # one secret
    }
    members = { trainer = "serviceaccount-e00example" }
  }
}
```

Validation refuses `admin` and `dsr.admin`, tenant parents and tenant targets, and empty permit
lists. Roles must come from the documented list
([roles](https://docs.nebius.com/iam/authorization/roles#list-of-roles)).

## Inputs that matter

| Variable | Default | Meaning |
|---|---|---|
| `repository` | — | `owner/name`; the prefix of every subject |
| `stages` | `{}` | per stage: `project_id`, `apply_service_account_id`, `plan_service_account_id`, `jobs` (default `["apply", "plan"]`: which accounts get a credential), optional `apply_subject` / `plan_subject` |
| `issuer_url` | `https://token.actions.githubusercontent.com` | GitHub's issuer (**not in the Nebius docs**); must equal the token's `iss` |
| `jwk_set_json` | `null` | leave null for GitHub |
| `groups` | `{}` | team groups as above |

## Outputs and composition

`github_environments` maps each GitHub Environment (`<stage>`, `<stage>-plan`) to its `NIP_SA_ID`
and expected `sub`. `federated_credentials` and `team_groups` list what exists. The foundation root
calls the module as `module.ci_federation` with the outputs of `ci_identity` / `ci_plan_identity`,
off unless `ci_federation` or `team_groups` is set; its outputs `ci_federation` and `team_groups`
pass these through.

## Quotas and cost

IAM objects only: no compute, storage or network. The docs list no quota for federated
credentials or groups; if the API refuses with a quota error, record it in
`docs/upstream-findings.md`.

## Validate

- Static: `terraform test` (mocked, 15 runs): default subjects per environment, apply/plan
  mapped to editor/viewer accounts, issuer, parent project, overrides, `jobs`, and refusal of
  foreign repositories, wildcards, `pull_request`, ref-only apply subjects, shared subjects,
  missing accounts and tenant parents; team groups project-scoped, with no `admin` and no tenant
  permits. The foundation root's own tests plan the wiring (mocked): off by default, two
  credentials for a `ci = true` stage with the right subjects and none for a `ci = false` stage,
  team groups without a repository; every `for_each` key is known at plan time while the
  service-account ids are not.
- Live: [`runbooks/identity.md`](../../../../runbooks/identity.md#first-federated-run). Plan side run on sandbox 2026-10-11 ([evidence](../../../../docs/evidence/2026-10-11-sandbox-ci-federated-plan.md)); apply side not yet.

## Limits and unknowns (the docs are silent)

| Question | What this module does |
|---|---|
| Exact inbound exchange request (GitHub JWT → Nebius access token) | the snippet's shape (subject identifier + JWT actor) returned an access token on 2026-10-11 |
| Does STS check `aud`, and against what? | yes, against `sts.nebius.com` only (observed 2026-10-11: GitHub's default `https://github.com/<owner>`, `https://sts.nebius.com`, the exchange URL, `api.nebius.cloud`, `token-service.iam.new.nebiuscloud.net` and the service account id were refused with "JWT audience is missing or unsupported"); the snippet requests it (`docs/upstream-findings.md` R13-3) |
| Is `federated_subject_id` exact match or a pattern? | treated as exact; `*` refused |
| Which parent the API expects for a federated credential | the service account's (stage) project |
| Which role may create federated credentials | not in the roles table; the foundation runs as `admin` |
| Lifetime of the issued token | `expires_in` was 43200 s (12 h) on 2026-10-11; read it per run, a stage apply longer than it would fail mid-run |
| Can the Nebius CLI run on that token alone? (`scripts/tf-run.sh` preflight) | not in the cached docs; the runbook gives a token-only preflight instead |
| Are exchanges recorded in Audit Logs? | IAM is a covered service ([services](https://docs.nebius.com/audit-logs/services)); the docs do not name a token-exchange event |

## Evidence

- 2026-10-11: the foundation applied with `ci_federation` for sandbox; both federated credentials exist with the subject GitHub sends (immutable ids, `subject_claims = "immutable"`) ([evidence](../../../../docs/evidence/2026-10-11-foundation-ci-federation-live.md)).
- 2026-10-11: the first federated `terraform.yml` plan (sandbox/network) signed in with no stored key once the GitHub token asked for audience `sts.nebius.com`, the only one of seven audiences tried that STS accepted (R13-3 in [upstream findings](../../../../docs/upstream-findings.md)); `expires_in` 43200 s ([evidence](../../../../docs/evidence/2026-10-11-sandbox-ci-federated-plan.md)).
- Not yet: the apply side (the `sandbox` environment) and retiring the CI service-account keys ([runbook](../../../../runbooks/identity.md#retire-the-authorized-keys)).

## Teardown

Remove the module call (or the stage) from the foundation and apply as an administrator. CI for
that stage then fails closed until keys are registered again
([credentials](../../../../docs/credentials.md#ci-service-account-keys)). Delete credentials
before the service accounts they reference.

## Upstream references

[Workload identity (STS)](https://docs.nebius.com/iam/wif#how-it-works) ·
[federated credentials resource](https://docs.nebius.com/terraform-provider/reference/resources/iam_v1_federated_credentials#schema) ·
[custom groups](https://docs.nebius.com/iam/authorization/groups#custom-groups) ·
[roles](https://docs.nebius.com/iam/authorization/roles#list-of-roles) ·
[adding a service account to a group](https://docs.nebius.com/iam/authorization/groups/members#adding-a-service-account) ·
[authorized keys](https://docs.nebius.com/iam/service-accounts/authorized-keys#uploading-the-public-key).
