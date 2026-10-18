# foundation + GitHub OIDC federation for sandbox (R13) — 2026-10-11

- **Kind:** run of this repository (`terraform/live/foundation`, R13), the first apply of the foundation;
  IAM only, approved by the owner and run by the owner from a script (plan, review, apply).
- **Date / region:** 2026-10-11, `eu-north1`; one stage (`sandbox`, `ci = true`). $0: nothing billable.
- **Versions:** provider `nebius/nebius` 0.6.67, Terraform 1.16.3.
- **Inputs:** `ci_federation = { repository = "<owner>/<repo>", repository_id, repository_owner_id,
  subject_claims = "immutable" }`; `adopt_bootstrap` for the sandbox state bucket, state account, group and
  membership that `scripts/bootstrap-backend.sh` had created. The foundation's own state: a bucket
  bootstrapped once (`NIP_BOOTSTRAP_NEW_STAGE=1 source scripts/bootstrap-backend.sh foundation foundation`).

## Results

| Check | Result |
|---|---|
| GitHub subject format | the repository reports `use_immutable_subject: true`; its tokens carry `repo:<owner>@<owner id>/<repo>@<repository id>:environment:<env>`. The module's `ids` shape would never have matched; `subject_claims = "immutable"` added (module tests) and used here. No GitHub setting was changed |
| Plan | 18 to create, 3 import with an in-place update (labels, a description, the state bucket's noncurrent-version lifecycle rule), 0 to destroy |
| Apply 1 | 20 of 21 done, including both federated credentials; failed on the state identity's group membership: **"Group membership already exists"** (the bootstrap made it; a duplicate permit, by contrast, was accepted). Fixed: `adopt_bootstrap.membership_id` imports it, and the bootstrap prints it |
| Plan 2 / apply 2 | `1 to import, 0 to add, 0 to change, 0 to destroy`; applied: `1 imported` |
| Read back (portal's read-only identity) | `nip-sandbox-gha-apply` and `nip-sandbox-gha-plan`, issuer `https://token.actions.githubusercontent.com`, subjects `…:environment:sandbox` and `…:environment:sandbox-plan`, each on its own service account; permits: `editor` (apply) and `viewer` (plan) on the sandbox project, `storage.object-editor` / `storage.object-viewer` on the state bucket for the state identities |

## What this does and does not show

- Shows: the foundation applies on a bootstrapped stage after the membership fix, and the federated
  credentials exist with the subject GitHub actually sends.
- Does not show: a token exchange from a workflow. That needs the `sandbox` and `sandbox-plan` GitHub
  Environments with `NIP_SA_ID` and no `NIP_SA_PRIVATE_KEY` (runbooks/identity.md, step 4 onwards), then a
  dispatched plan run.
