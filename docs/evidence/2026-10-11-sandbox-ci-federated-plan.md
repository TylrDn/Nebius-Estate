# First federated CI plan for sandbox (R13) — 2026-10-11

- **Kind:** run of this repository (`.github/workflows/terraform.yml`, `action=plan`) on the federated
  path: no service-account key in the GitHub Environment. Set up and dispatched by the owner; plan only,
  the apply job was skipped. $0: nothing created.
- **Date / region:** 2026-10-11 (03:23–03:24Z on 2026-10-12 UTC), `eu-north1`, stage `sandbox`, stack `network`.
- **Environment `sandbox-plan`:** secrets `NIP_SA_ID` (the plan identity, `viewer` on the project),
  `NEBIUS_TENANT_ID`, `NEBIUS_PROJECT_ID`, and a read-only state key (`storage.object-viewer` on the
  bucket, 30-day expiry); variables `NEBIUS_REGION`, `NIP_STATE_BUCKET`. No `NIP_SA_PRIVATE_KEY` or
  `NIP_SA_KEY_ID`. Repository variable `NIP_TERRAFORM_ENABLED=true`. No reviewers, any ref.

## Results

| Check | Result |
|---|---|
| Run 1 (38195449653 (private development CI; not publicly accessible)) | gate passed; the plan job got its GitHub OIDC token; STS refused it: **"JWT audience is missing or unsupported: '[https://github.com/&lt;owner&gt;]'"** (HTTP 400). No token in the log |
| Audience probe (throwaway workflow on a branch, deleted) | one GitHub token per candidate `aud`, offered to STS for the same identity: `sts.nebius.com` → HTTP 200, access token, `expires_in` 43200; refused (400, same message): GitHub's default, `https://sts.nebius.com`, the exchange URL, `api.nebius.cloud`, `token-service.iam.new.nebiuscloud.net`, the service account id. Fix: `scripts/ci-token.sh` requests `audience=sts.nebius.com` (R13-3) |
| Run 2 (38199565479 (private development CI; not publicly accessible), plan job (private development CI; not publicly accessible)) | success. Token step: "Exported TF_VAR_iam_token for service account *** (federated; expires_in 43200 s)"; S3 backend configured with the read-only key; lock-free plan **18 to add, 0 to change, 0 to destroy** (the stack is not applied in sandbox) |
| Exchange shape that worked | `subject_token` = the service account id (`urn:nebius:params:oauth:token-type:subject_identifier`), `actor_token` = the GitHub JWT (`urn:ietf:params:oauth:token-type:jwt`), as in `scripts/ci-token.sh`; the alternative shape was not needed |
| Token hygiene | no token-shaped string in the full run log; the request token travels as a header from a file descriptor and the JWT on stdin (`tests/scripts/test-ci-token.sh`) |

## What this does and does not show

- Shows: a GitHub job with no stored Nebius key signs in as the stage's plan identity through
  federation, reads Terraform state with the read-only key and plans against the real API.
- Does not show: the apply side. The `sandbox` environment (apply identity, read-write state key) is not
  created yet; runbook step 4 runs `action=apply` on a no-op plan. The CI service-account keys can be
  retired only after both jobs run green (runbooks/identity.md "Retire the authorized keys").
