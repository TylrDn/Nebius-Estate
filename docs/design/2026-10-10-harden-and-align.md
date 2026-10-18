# Harden and align — design (2026-10-10)

**Goal:** make every recipe production-repeatable, explainable and grounded in current Nebius
documentation. The pass fixes everything that would break a real first deploy, removes what does not
earn its place, and adds the two documented topologies the repository does not yet cover.

**Inputs:** three read-only audits on 2026-10-10:
- the Nebius documentation catalog (docs.nebius.com sitemap, nebius/nebius provider v0.6.67, the
  `nebius/nebius-solutions-library` main branch at fba7148 and tag `soperator-v4.1.13-2`);
- an infrastructure audit (all roots validated; every mocked test passed in a scratch copy);
- a portal audit.

**Decisions:**

| # | Decision |
|---|---|
| 1 | Harden R1–R6, keep their IDs, add **R7 private network perimeter and hybrid connectivity** and **R8 dataset and checkpoint data plane**. Everything else documented by Nebius is a building block inside an existing recipe, or out of scope |
| 2 | Portal consolidates to five workspaces; the GitHub PR adapter is removed |
| 3 | `comparisons/` becomes `recipes/` (`physical-ai` → `team-platform`, `serverless` unchanged); R2 is labelled "Foundation & lifecycle" |
| 4 | Tool versions are pinned through a Docker toolbox image built from `platform/versions.yaml`, and a pin checker enforces them |

**Not in scope:**
- Live applies, and any new live-evidence claim.
- Git history rewrites.
- Renaming the GitHub repository. The "patters" spelling is noted in the README only; a rename breaks
  remotes, links and local paths.
- An NVIDIA OSMO recipe. Managed Spark is out because it is deprecated upstream.

---

## 1. End-state layout

| Path | Purpose |
|---|---|
| `terraform/modules/` | Building blocks; each has one owner layer. New: `stage-policy`, `network-perimeter`, `data-plane` |
| `terraform/stacks/` | One root per recipe: `inference` (R1), `training` (R3), `soperator` (R4 wrapper of the upstream recipe), `network` (R7), `data` (R8) |
| `terraform/live/` | Generated stage × stack roots plus `foundation` (R2) |
| `recipes/` | Recipes that are not Terraform stacks: `team-platform` (R5), `serverless` (R6) |
| `workloads/` | Kubernetes manifests per recipe (vLLM, NCCL/DDP, R8 copy job) |
| `platform/` | Authoritative YAML: stages, regions, versions, alerts |
| `policy/` | conftest rules over stage policy and sizing |
| `tests/` | Bottom-up validation and load |
| `runbooks/` | Operator procedures, one per lifecycle step |
| `scripts/` | Helpers invoked by make or CI only |
| `tools/toolbox/` | Pinned tool image |
| `portal/` | Nebius Estate (app, backend, `nebius-domain`, `nebius-estate`, `nebius-estate-backend`) |
| `docs/` | Primer, architecture, ADRs, evidence, building blocks, portal docs, design notes |

**Recipe contract.** A recipe is a stack or recipe directory, plus workload manifests, a validation
step, a runbook, an evidence slot, and a citation of the Nebius doc or solutions-library path it
mirrors. The README table lists R1–R8 in ID order, one row each.

## 2. Workstreams

Each workstream ends green on its verification gate (§4) before the next starts. Items name the audit
finding they close.

### A. Fix what breaks a real deploy

| # | Change | Acceptance |
|---|---|---|
| A1 | Prod pipeline: document that prod plan/apply runs on a self-hosted runner inside the stage VPC (private endpoint). The workflow input `runner` defaults to the GitHub-hosted runner, which the gate job refuses for any stage with `public_endpoint: false` | gate refuses prod on a hosted runner; `change-management.md` describes the runner |
| A2 | Policy rejects RFC 5737 documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) in `allowed_cidrs` for staging and prod (conftest + stack precondition). Staging tfvars keep the placeholder commented, with instructions | `make policy` fails on the placeholder; the tests cover it |
| A3 | `terraform.yml` gains `run` and `ttl` inputs; the setup action exports `TF_VAR_labels` (with `nip-ttl-expires` for sandbox) | an action dry run renders labels; the sandbox policy is satisfied |
| A4 | The foundation root adopts resources made by `bootstrap-backend.sh` through name-keyed `import` blocks behind an `adopt_bootstrap` variable. `terraform/README.md` and the script header agree | mocked test covers both paths |
| A5 | CI state credentials: the setup action mints a short-lived state access key per job (as the local path does) instead of a static secret. The foundation adds a **viewer** CI identity for `<stage>-plan` | foundation test asserts two identities per stage; workflow uses the plan identity in plan jobs |
| A6 | The plan artifact is no longer uploaded (it embeds prior state). The plan job publishes the summary and the saved plan's sha256; the apply job re-plans, compares summary and hash, and refuses on change | workflow reviewed; no `.tfplan` artifact |
| A7 | Lock files cover linux_amd64, darwin_arm64 and darwin_amd64 for every locked root and module | `make validate test` passes on macOS and in the toolbox |
| A8 | `platform/versions.yaml` has a single `tooling:` block. Trivy action, `busybox` (NCCL MPIJob) and image pins agree with it | `check-pins.py` passes |
| A9 | Prod teardown: `runbooks/teardown.md` covers prod (release process, `forbid_deletion` order, data export). The Makefile refusal message points to it | runbook section exists; message accurate |
| A10 | `wait-for-ofed.sh` reuses the endpoint choice of `get-kubeconfig.sh`; CLI calls honour `NEBIUS_PROFILE`; `ci-token.sh` fails loudly | shellcheck plus a dry-run read |
| A11 | Soperator: `make soperator-plan/apply` route through `tf-run.sh` (plan-age guard). The iam token is passed so it does not land in the plan where the recipe allows it; otherwise the limitation is stated. The `nebius_iam_v1_project` deprecation (supported until 2026-12-16) is recorded in `upstream-findings.md`. The generated README includes `init` | targets exist; docs consistent |

### B. Repeatability

| # | Change | Acceptance |
|---|---|---|
| B1 | `tools/toolbox/Dockerfile`: Terraform (main and Soperator versions), tflint, conftest, kubectl, shellcheck, trivy, gitleaks, jq, python3 and the nebius CLI, each at its `versions.yaml` version with sha256 verification. `make toolbox` builds it; `make ci-docker` runs `make ci` inside it with the repository mounted read-write (Terraform writes `.terraform/` per root) and provider and plugin caches in a named volume | `make ci-docker` green |
| B2 | `scripts/check-pins.py`: every version or image referenced in workflows, scripts, manifests, fetch scripts and the toolbox matches `versions.yaml`. Added to `make ci` | intentionally drifted pin fails; current tree passes |
| B3 | Portable shell: no `find -printf`, no GNU-only `date`; `make kustomize` fails when it builds nothing | macOS and Linux runs build every kustomization |
| B4 | `ci.yml` calls make targets (`make ci`, `make soperator-check`) inside the toolbox image; the root list lives only in the Makefile | `ci.yml` has no duplicated loops |
| B5 | All third-party actions pinned by commit SHA with a version comment | `check-pins.py` verifies the comment matches `versions.yaml` |
| B6 | Node boot no longer depends on `package_update`, unless a step needs packages (documented) | cloud-init test updated |
| B7 | `results/` policy is consistent: summaries committed deliberately; everything else ignored; `docs/evidence/README.md` matches `.gitignore` | grep check |

### C. De-bloat and refactor

| # | Change | Acceptance |
|---|---|---|
| C1 | `modules/stage-policy` (inputs: stage, stack, sizing flags; outputs: resolved policy, preconditions) replaces the duplicated blocks in `stacks/inference` and `stacks/training`, and is used by R7/R8 | existing 37 + 25 mocked tests still pass unchanged in intent |
| C2 | Delete the `moved` blocks (roots never applied), `.gitkeep` files in non-empty directories, and the unused `serverless-job-base-image` pin | grep shows none |
| C3 | One quickstart: `runbooks/deploy.md`. README and `walkthrough.md` link to it instead of repeating it. Each stack README follows the template *purpose · upstream reference · inputs that matter · run · validate · teardown · limits*, at most ~400 words | `wc -w` check in the docs gate |
| C4 | `nebius-primer.md` trimmed to service → repository mapping, workload flow, glossary and gotchas; overlap with `architecture.md` removed | no duplicated tables |
| C5 | The two run-log evidence files fold into `docs/evidence/costs.md` | evidence index updated |
| C6 | R1 claims match code: optional node-group autoscaling (`gpu_autoscaling = {min,max}` mapped to `NodeGroupAutoscalingSpec`, mutually exclusive with fixed count, off by default), and a prod overlay with replicas equal to GPU nodes and `RollingUpdate` where capacity allows | mocked tests cover both modes; overlay builds |
| C7 | Remove the `aws` CLI from CONTRIBUTING if no path needs it; fix the `STAGE=foundation` plan filename | grep check |

### D. Security hardening

| # | Change | Acceptance |
|---|---|---|
| D1 | State bucket: `prevent_destroy`; versioning cannot be disabled by the CI identity (state access stays bucket-scoped; project editor is not used for state) | foundation test |
| D2 | NetworkPolicy default deny + required allows for `training`, `nccl-test`, team namespaces and Soperator namespaces where the recipe permits it. Where the upstream recipe prevents it, `security.md` says so | kustomize build plus a policy unit test (rendered manifest contains a default deny per namespace) |
| D3 | vLLM runs non-root with a writable cache volume; model-download egress is limited to 443 and documented as the remaining wide rule | manifest test |
| D4 | Validation and NCCL images pinned by digest in `versions.yaml` | `check-pins.py` |
| D5 | Grafana password no longer in any uploaded artifact (follows from A6); MysteryBox is the documented upgrade path | — |

### E. New recipes

**R7 — Private network perimeter and hybrid connectivity** (`terraform/stacks/network`, generated
`terraform/live/<stage>/network`).

- **Builds:**
  - a VPC network and private subnet with no public IPs on workload nodes;
  - security groups (default deny ingress; intra-subnet allow; SSH or WireGuard only from the bastion);
  - a custom NAT egress (a NAT VM plus a route table sending `0.0.0.0/0` to it, as in Nebius's custom
    NAT gateway docs);
  - a WireGuard bastion with one public allocation (mirrors solutions-library `wireguard/` and `bastion/`).
- **Outputs:** `subnet_id` and `security_group_ids`, consumed by R1 and R3 through their existing
  variables.
- **Variant:** site-to-site VPN is documented as a variant that cites the Nebius VPN Gateway service.
  It is not built here.
- **Policy:** per stage, whether the bastion is allowed (prod: bastion only through the allowlist) and
  the allowed CIDRs (A2 applies).
- **Tests:** mocked plan tests for subnet, security groups, route table and bastion allocation, and the
  stage policy. Validation `tests/validate/network.sh` checks that a node has no public IP and that
  egress goes through NAT.
- **Runbook and evidence:** `runbooks/network.md`; empty evidence slot.

**R8 — Dataset and checkpoint data plane** (`terraform/stacks/data`, generated
`terraform/live/<stage>/data`).

- **Builds:**
  - Object Storage buckets for datasets and checkpoints, with versioning on checkpoints and lifecycle
    expiry of non-current versions;
  - a shared filesystem sized per stage;
  - an optional `nebius_storage_v1_transfer` from an external S3 source (credentials by variable,
    never committed).
- **Workloads:**
  - `workloads/data/copy-job`: a pinned rclone Job that stages a bucket prefix onto the shared
    filesystem;
  - a checkpoint guidance note with a pointer to the ml-cookbook object-storage-checkpointing pattern.
- **Validation:** `tests/validate/03-storage.sh` (fio) reused, plus a copy-throughput step.
- **Upstream references:** solutions-library `data-transfer/` and `nfs-server/`; Object Storage docs
  (transfer, filesystem buckets, Mountpoint for S3).
- **Tests and docs:** mocked plan tests, `runbooks/data.md`, empty evidence slot.

Both recipes are added to `platform/stages.yaml` (per-stack caps where relevant),
`render-live-roots.py`, the README table, the portal's recipe list (read-only cards; provisioning
forms only for R1, R3 and R4 as today), and the capability matrix.

### F. Portal

| # | Change | Acceptance |
|---|---|---|
| F1 | Five workspaces: `nebius-commercial` and `nebius-ui` fold into `plugins/nebius-estate` (`src/commercial/`, `src/ui/`); `nebius-commercial-backend` and `nebius-estate-node` fold into `plugins/nebius-estate-backend` (`src/commercial/`, `src/lib/`). The permission policy imports the config reader through a small exported entry | `yarn tsc`, all tests green; `/internal/*` routes removed |
| F2 | Config: `app-config.yaml` is mode-neutral; demo settings (guest provider, loopback bind, sqlite, demo roles, `mode: demo`) move to `app-config.demo.yaml`, which `yarn start` and `make portal-dev` load | test loads base + production config through `readEstateConfig` and does not throw |
| F3 | Billing supersession slot includes the container (project); importers with a restricted scope cannot supersede other projects' rows | domain + router tests |
| F4 | knex migrations replace `hasTable/createTable`. Billing rows store `container_id`, `charge_period_start`, `region`, `service_name` and `superseded_by` as indexed columns, and summaries filter in SQL; no whole-ledger load | migration test on sqlite; summary test unchanged |
| F5 | Deterministic default rate book (`nebiusEstate.commercial.defaultRateBook`, else ordered by id) | test |
| F6 | Removed: GitHub PR adapter (route, states `pr-requested`/`pr-open`, permission, config, docs), demo `integrations.json` (statuses generated from the connector definitions with fixture overrides), dead types and helpers, unused dependencies, unused CSS, placeholder tests, scaffold leftovers (manifest name, favicons replaced by a neutral mark) | dependency check script finds no unused deps |
| F7 | Shared contracts: response types in `nebius-domain/src/api.ts`, one `parse()`, one filter schema, one test permission helper; `config.d.ts` for the `nebiusEstate` block; budgets parsed in the config reader | grep checks |
| F8 | Correctness: provisioning transitions use compare-and-set; `/estimate` uses the portal clock; the provisioning estimate is built by a domain function | tests |
| F9 | Repeatability: committed `.nvmrc` (24), Node image pinned by digest, single-replica deployment stated in `architecture.md` and the Dockerfile; a `portal` job in `ci.yml` (install --immutable, tsc, lint, test, build) | CI job runs make targets |

### G. Documentation and explainability

- **README:** the recipe table orders R1–R8, with an upstream-citation column, and a 12-line repository
  map. A note records the repository name spelling.
- **`docs/building-blocks.md`:** one paragraph and doc link each for GPU slicing (MIG/MPS/time-slice),
  Ray (KubeRay, Ray Serve), reservations and capacity blocks, MysteryBox and external-secrets, KMS,
  Token Factory dedicated endpoints, observability (Marketplace stack, observability agent, Monitoring
  and Logging previews), budgets and audit logs, alternative orchestrators (dstack, Run:ai, Kubeflow).
- **Contradictions fixed:**
  - image pinning claims in `security.md`;
  - the bootstrap reuse instructions;
  - the evidence/`.gitignore` mismatch;
  - R1's upstream reference (`k8s-inference` was removed from the solutions library on 2025-03-18; R1
    now cites the MK8s GPU docs and the `vllm` chart in `nebius-k8s-applications`);
  - the solutions-library name (`nebius-solutions-library`).

## 3. Risks

| Risk | Mitigation |
|---|---|
| Refactoring stage policy changes plan behaviour | the existing mocked tests are the contract; they must pass with the same assertions |
| Toolbox downloads change upstream | sha256 pins; the toolbox build fails loudly |
| New stacks (R7/R8) use resources not yet exercised live | mocked tests only; evidence slots stay empty; README says so |
| Portal consolidation regresses UI | the unit, e2e and axe suites must pass unchanged in intent |
| Scope is large | workstreams land independently; A and B form the first checkpoint |

## 4. Verification gates

- **Infrastructure (after every workstream):** `make ci` (fmt, render check, validate, tflint, mocked
  tests for every stack including R7/R8, conftest, shellcheck, kustomize, NCCL selftest,
  `check-pins.py`) and `make soperator-check`, both inside the toolbox. Also gitleaks, and a link check
  (lychee in CI; the relative-link check locally).
- **Portal (after F):** `make portal-build portal-test portal-e2e` (tsc, lint, 120+ unit and integration
  tests, production build, Playwright with axe in both themes).
- **Commits:** one per workstream, no AI attribution, made only on the owner's go-ahead.

## 5. Order and checkpoints

**A → B** is checkpoint 1: every recipe can be planned repeatably and the first deploy path is
correct. **C → D** is checkpoint 2. **E** is checkpoint 3 (R7, R8). **F** is checkpoint 4 (portal).
**G** runs alongside each checkpoint and closes at the end.
