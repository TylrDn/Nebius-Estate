# Contributing

## Rules

Cite a rule by its name, not its number.

| # | Rule | What it means |
|---|---|---|
| 1 | **Pin it or don't ship it** | New images, charts, providers, tools, actions and upstream refs go in `platform/versions.yaml` with a `source` and `verified` date; run `make compat-matrix`. `make pins` (part of `make ci`) fails when anything drifts from it. |
| 2 | **Mirror upstream, cite the commit** | Terraform that reproduces a Nebius recipe names the `nebius-solutions-library` tag or commit in a comment. A divergence gets an ADR or an entry in [`docs/upstream-findings.md`](docs/upstream-findings.md). |
| 3 | **One reconciler per resource** | Never add a second owner for a Helm or Marketplace release ([ADR-0006](docs/decisions/0006-reconciler-ownership.md)). |
| 4 | **No apply from CI, no credentials in git** | `ci.yml` (every PR) is static and credential-free (`make ci`). The one exception, `.github/workflows/terraform.yml`, ships disabled, is manual-dispatch only and is enabled only by the repo owner ([`docs/change-management.md`](docs/change-management.md#enabling-the-pipeline)). State, plans, `backend.hcl`, kubeconfigs and uncommitted `*.tfvars` are git-ignored. |
| 5 | **Evidence over adjectives** | A number needs a method (`tests/load/README.md`), exact versions and a file in `results/` or `docs/evidence/`. |
| 6 | **Default to the smallest GPU footprint** | New roots plan the minimum (training 0 GPU nodes; Soperator one CPU worker); raising a count is a reviewed change ([`docs/cost.md`](docs/cost.md#spend-controls)). |
| 7 | **No secrets, keys, kubeconfigs, state or real IDs** | Including tenant, project and resource IDs (`project-…`, `mk8scluster-…`) and IP addresses. Real values live only in the git-ignored `.env` and `secrets/` ([`docs/credentials.md`](docs/credentials.md); `make env-status` checks they are set and private). Run `make scan` (gitleaks + Trivy, CI on every PR) before every push; fixtures use obvious fakes (`project-e00mock`), and example CIDRs are never RFC 5737 ranges in an `allowed_cidrs` that policy evaluates (`make policy`). |
| 8 | **Docs beat notes; evidence beats docs only for observed behaviour** | A claim cites docs.nebius.com or the pinned upstream tag + sha. `make docs-links` (part of `make ci`) fails when a cited docs.nebius.com page or `#anchor` is not in the committed catalog ([`docs/reference/nebius-docs.md`](docs/reference/nebius-docs.md)); `make md-links` (part of `make ci`, offline) fails when a relative Markdown link does not resolve to a file or its `#anchor` to a heading; `make links` (lychee, CI) checks every other external link. When a live run contradicts the docs, record the conflict (`docs/upstream-findings.md`, the ADR, or `docs/evidence/`). |
| 9 | **Nothing billable without approval** | No `apply` or `destroy` without an explicit, written spend approval from the repo owner; the disabled pipeline gets credentials only from GitHub Environments the owner creates. |

## Workflow

- Never push to `main`: branch, open a PR, `make ci-docker` (or `make ci`) green locally first.
- Resolve every review thread before merge; security findings stay open until the repo owner decides.
- One PR per change kind ([`docs/change-management.md`](docs/change-management.md#kinds-of-change-and-their-blast-radius)).
- Runbooks are tested by running them; a step that cannot be run yet says so.
- Add or supersede an ADR → update [`docs/decisions/README.md`](docs/decisions/README.md).
- Edit `platform/stages.yaml` or a stack's variables → `make render-live`; edit `platform/versions.yaml` → `make compat-matrix`;
  cite a new docs.nebius.com page → `make docs-catalog` if `make docs-links` does not know it yet.

## Local tooling

The simplest path is the toolbox image, which carries every check tool below plus the `nebius` CLI and
`jq`, each at its pinned version and sha256:
`make toolbox`, then `make ci-docker TARGETS="<targets>"`. It is linux/amd64 only; Apple silicon runs it
under emulation, more slowly. To run targets directly instead, install:

| Purpose | Tools |
|---|---|
| Static checks (`make ci`, `soperator-check`, `scan`, `links`) | Terraform (plus a second, older version, 1.12.2, installed as `terraform-soperator` for `make soperator-check`; `platform/versions.yaml` `terraform-soperator`), tflint, conftest, shellcheck, kubectl (kustomize), trivy, gitleaks, lychee, python3 ≥ 3.11 (stdlib only) |
| Deploy and teardown | `nebius` CLI, `jq`, kubectl; python3 ≥ 3.11 for the Soperator destroy; the `aws` CLI only for a state restore ([`runbooks/backup-restore.md`](runbooks/backup-restore.md)) |

Exact versions: [`docs/compatibility-matrix.md`](docs/compatibility-matrix.md), generated from
`platform/versions.yaml`. Targets: `make help`.
