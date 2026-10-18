# Identity and CI federation runbook (R13)

Switch a stage's CI from authorized keys to GitHub OIDC federation, add a least-privilege team
group, revoke CI access fast, and fall back to keys. Module and threat model:
[`terraform/modules/foundation/ci-federation`](../terraform/modules/foundation/ci-federation/README.md).

**Status: plan side run live on sandbox** (2026-10-11,
[evidence](../docs/evidence/2026-10-11-sandbox-ci-federated-plan.md)); the apply side (step 4) and the
key retirement have not run. Record each next run in `docs/evidence/`, and any refusal in
`docs/upstream-findings.md`.

| Task | Duration | Risk |
|---|---|---|
| [Turn on federation in the foundation](#turn-on-federation-in-the-foundation) | 20 min | low (IAM only, admin apply) |
| [First federated run](#first-federated-run) | 30 min per stage | read-only (plan job) |
| [Retire the authorized keys](#retire-the-authorized-keys) | 10 min per stage | low; CI fails closed if federation is not working |
| [Add a team group](#add-a-team-group) | 15 min | low |
| [Revoke CI access now](#revoke-ci-access-now) | 5 min | stops that stage's pipeline |
| [Fall back to keys](#fall-back-to-keys) | 20 min | low |

Who runs it: an administrator. The foundation applies on an admin user token, and group
membership changes need `admin`
([roles](https://docs.nebius.com/iam/authorization/roles#general-roles)).

## Turn on federation in the foundation

The module is wired into `terraform/live/foundation` and **off by default**: `ci_federation = null`
and `team_groups = {}` create nothing (`module.ci_federation` has count 0; tested in
`terraform/live/foundation/tests/foundation.tftest.hcl`). Turning it on is a foundation / IAM change
([blast radius](../docs/change-management.md#kinds-of-change-and-their-blast-radius)).

1. Check which subject GitHub already sends:
   `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`. If it reports
   `"use_immutable_subject": true`, the `sub` already carries the ids
   (`<sub_claim_prefix>:environment:<env>`, prefix `repo:<owner>@<owner id>/<repo>@<repository id>`):
   set `subject_claims = "immutable"` in step 2 and **skip the template change below** (the "ids" shape
   would never match such a token; found on this repository 2026-10-11). Otherwise, pin the subject
   to the repository's immutable ids. A name-only `sub`
   (`repo:<owner>/<repo>:environment:<stage>`) is matched by whoever holds that owner/name, including
   after a rename, a transfer or a deleted-and-re-registered account. Read the ids and set the
   repository's OIDC `sub` template so GitHub puts them in every token (a repository admin; it changes
   `sub` for every workflow of the repository, so do it in the same change as step 2):

   ```bash
   gh api repos/<owner>/<repo> --jq '{repository_id: .id, repository_owner_id: .owner.id}'
   gh api -X PUT repos/<owner>/<repo>/actions/oidc/customization/sub --input - <<'JSON'
   {"use_default": false, "include_claim_keys": ["repo", "repository_owner_id", "repository_id", "context"]}
   JSON
   gh api repos/<owner>/<repo>/actions/oidc/customization/sub   # check
   ```

   With that template a job in the `prod` environment presents
   `repo:<owner>/<repo>:repository_owner_id:<id>:repository_id:<id>:environment:prod`
   ([GitHub OIDC](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect)).
   The format is GitHub's, not in the Nebius docs; the first federated run confirms it.
2. In the foundation's git-ignored `terraform.tfvars`:
   `ci_federation = { repository = "<owner>/<repo>", repository_id = "<id>", repository_owner_id = "<id>" }`
   (template in `terraform.tfvars.example`). Every stage with `ci = true` gets two credentials whose
   subjects are the template above for the `<stage>` (apply) and `<stage>-plan` (plan) environments;
   override per stage with `subjects = { <stage> = { apply = "...", plan = "..." } }`.
   `subject_claims = "name"` keeps the name-only default instead (no template change, no ids): an
   explicit opt-in that accepts the rename/re-registration risk above.
3. `make fmt-check validate test`, then as the administrator:
   `terraform -chdir=terraform/live/foundation plan`. Expect **only** creates:
   `nebius_iam_v1_federated_credentials` × 2 per CI stage (plus any team groups). Apply only with
   the written approval (CONTRIBUTING "Nothing billable without approval"; this creates nothing
   billable, but it changes who can act as the stage).
4. `terraform -chdir=terraform/live/foundation output -json ci_federation`: `NIP_SA_ID` and the
   expected `sub` per GitHub Environment.

## How the pipeline picks a path

Keys keep working throughout. The federated path is selected per GitHub Environment by the
absence of `NIP_SA_PRIVATE_KEY`:

| Piece | Key path | Federated path |
|---|---|---|
| `.github/workflows/terraform.yml` | `plan` and `apply` jobs pass the key secret | the same jobs carry `permissions: id-token: write` (only those two; `gate` and the workflow default stay `contents: read`) |
| `.github/actions/nebius-stage-setup` | writes the key to a temp file, mounts it into the toolbox for the mint only, deletes it after | `sa-private-key` empty: passes `ACTIONS_ID_TOKEN_REQUEST_URL` / `_TOKEN` and `NIP_CI_FEDERATED=1` into the toolbox, no `/secrets` mount. Both paths export `NIP_CI=1` and `NIP_CI_FEDERATED` to later toolbox runs |
| `scripts/ci-token.sh` | a CLI profile in a throwaway config that reads the key by path (`--private-key-file-path`), `nebius iam get-access-token`, then the config is deleted: no later step can mint again | `NIP_CI_FEDERATED=1`: GitHub OIDC token → `https://sts.nebius.com/oauth2/token/exchange` (shape in the [module README](../terraform/modules/foundation/ci-federation/README.md#token-exchange-in-the-workflow-documentation-only)); the request token travels as a header read from a file descriptor, the JWT on stdin |
| both | exports `TF_VAR_iam_token`, prints no token, puts none in argv; still refuses a set `NEBIUS_IAM_TOKEN` | |
| `scripts/tf-run.sh` | in CI (`NIP_CI=1`): checks `TF_VAR_iam_token` is set; the `nebius` CLI is not needed (locally: the CLI login preflight) | the same check (`NIP_CI_FEDERATED=1`) |
| `scripts/wait-for-ofed.sh` (training `enable_gpu_operator`) | in CI: a throwaway CLI config whose profile reads `TF_VAR_iam_token` from a 0600 file, deleted on exit | the same |

The CLI and a bare token: CLI 0.12.285 refuses to run without a config file even when
`NEBIUS_IAM_TOKEN` is set ("missing configuration"); with a config present it prints "token from
NEBIUS_IAM_TOKEN env is used", and a profile created with `--token-file` works (both observed
2026-10-11 with an invalid token, read-only `nebius iam whoami`). The Terraform provider takes the token
directly ([provider auth](https://docs.nebius.com/terraform-provider/authentication#authentication-for-a-service-account)).

If a federated job reaches the token step without `id-token: write`, the action stops with "neither
credential path is available".

## First federated run

Run this on sandbox first, then staging, then prod.

1. GitHub, environment `<stage>-plan`: keep `NIP_SA_ID` (= `terraform output -json ci_federation`
   → `["<stage>-plan"].NIP_SA_ID`), delete `NIP_SA_PRIVATE_KEY` and `NIP_SA_KEY_ID`.
   Check the environment's deployment branch/tag rules: sandbox any ref, staging `main`, prod
   `v*.*.*` tags. For `<stage>` (apply), leave the key in place until step 4.
2. Dispatch `terraform.yml` with `action=plan`. The token step must print no token.
3. If the exchange is refused, compare the claims, not the token. Print them in a throwaway
   debug step: the payload holds no signature and is not a credential on its own, but remove the
   step afterwards.

   ```bash
   curl -sSf -H @<(printf 'Authorization: bearer %s\n' "${ACTIONS_ID_TOKEN_REQUEST_TOKEN}") "${ACTIONS_ID_TOKEN_REQUEST_URL}" |
     jq -r .value | jq -R 'split(".")[1] | @base64d | fromjson | {iss, sub, aud, environment, ref, repository_id, repository_owner_id}'
   ```

   - `iss` must equal the credential's `issuer_url`, and `sub` its `federated_subject_id`
     (`terraform output -json ci_federation`). A `sub` without the ids means the repository's sub
     template is not set yet ([step 1](#turn-on-federation-in-the-foundation)).
   - If both match and STS still refuses, try the other documented shape: the GitHub JWT as
     `subject_token` with `subject_token_type=urn:ietf:params:oauth:token-type:jwt` and no actor
     ([STS parameters](https://docs.nebius.com/iam/wif#how-it-works)). Record which one worked in
     `docs/upstream-findings.md` and fix `scripts/ci-token.sh` and the module README.
   - "JWT audience is missing or unsupported": the GitHub token must carry `aud` `sts.nebius.com`,
     which `scripts/ci-token.sh` requests (`&audience=sts.nebius.com` on the request URL). GitHub's
     default audience is refused (R13-3); the docs do not name the value.
4. Plan green: repeat for the `<stage>` environment with `action=apply` on a no-op plan.
5. Record in `docs/evidence/`: the date, the stage, which exchange shape worked, `expires_in` from
   the STS response, and the job links.

## Retire the authorized keys

Only after both jobs of the stage have run green federated:

```bash
sa=$(terraform -chdir=terraform/live/foundation output -json ci_identities | jq -r '.["<stage>"].service_account_id')
nebius iam auth-public-key list-by-account --account-service-account-id "$sa" --format json
nebius iam auth-public-key delete --id <key id>
# repeat with ci_plan_identities for the plan account; shred secrets/ci-<stage>.pem locally
```

Update [`runbooks/credential-rotation.md`](credential-rotation.md): that stage no longer has a CI
service-account key to rotate. The CI state S3 key still does.

## Add a team group

1. Add an entry to `team_groups` in the foundation tfvars. Use the narrowest role on the
   narrowest resource: a bucket role on the bucket, `mysterybox.payload-viewer` on one secret,
   `viewer` on the project only when the team really needs to see everything in it
   ([custom groups](https://docs.nebius.com/iam/authorization/groups#custom-groups)).
2. Plan as the administrator. Expect one group, one access permit per `permits` label and one
   membership per `members` label. Labels, not IDs, key the objects, so changing an ID under a
   label replaces that one permit or membership. `admin`, `dsr.admin` and tenant targets are refused at plan time.
3. Apply, then check membership
   ([members](https://docs.nebius.com/iam/authorization/groups/members#adding-a-service-account)):
   `nebius iam group-membership list-members --parent-id <group ID>`.

Users join by their user account ID; service accounts by `serviceaccount-…`.

## Revoke CI access now

On suspicion of a compromised workflow or environment:

1. Fastest: in GitHub, remove `NIP_SA_ID` from the affected environment, or disable the workflow
   (`NIP_TERRAFORM_ENABLED` ≠ `true`). No new job can then name the account.
2. In Nebius, delete the stage's credentials as the administrator:
   `terraform -chdir=terraform/live/foundation apply -target='module.ci_federation[0].nebius_iam_v1_federated_credentials.ci["<stage>/apply"]' -destroy`.
   Do this only in an emergency; afterwards remove `ci_federation` for that stage in tfvars and
   apply normally, so state and config agree. A token already issued stays valid until it
   expires: the docs give no revocation call for it, so step 3 matters.
3. Remove the account from its group (`nebius iam group-membership delete`) to cut what any
   live token can do.
4. Check Audit Logs for what the account did
   ([services](https://docs.nebius.com/audit-logs/services)).

## Fall back to keys

If federation cannot work for a stage (STS refuses every shape), register keys again as in
[credentials](../docs/credentials.md#ci-service-account-keys), put `NIP_SA_PRIVATE_KEY` and
`NIP_SA_KEY_ID` back into the environment, and leave `ci_federation` unset for that stage. The
pipeline takes the key path whenever the key secret is present.
