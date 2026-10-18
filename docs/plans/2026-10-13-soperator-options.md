# Soperator and the v1 IAM data sources — options, 2026-10-13

**Decided 2026-10-13: B patch + A issue** (bottom of this file). The text below is the state before
the decision; what shipped is listed under "Owner decision".

## Facts (re-checked 2026-10-13)

- **Upstream tags.** `git ls-remote --tags https://github.com/nebius/nebius-solutions-library.git 'soperator-v*'`
  (2026-10-13): 91 refs, the newest `soperator-v4.1.13-2`, the tag this repository pins
  ([`platform/versions.yaml`](../../platform/versions.yaml), commit `d1c15ca`, 2026-10-07). **No newer
  tag exists.** Upstream `main` (`fba7148`, 2026-10-09) still declares both data sources below.
- **What breaks on 2026-12-16.** `soperator/installations/example/variables.tf` at the pinned tag declares
  `data "nebius_iam_v1_project" "this"` (read in five places of `main.tf`, each only for its `.id`, which
  is `var.iam_project_id` itself) **and** `data "nebius_iam_v1_tenant" "this"` (declared, never
  referenced). The provider marks both "Supported until 2026-12-16" ("Project service v1 API is
  deprecated", "Tenant service v1 API is deprecated"); the tenant one was hidden until now because
  Terraform folds repeated deprecation warnings into one ([R4-14](../upstream-findings.md)). The date
  is the **API's**, so pinning the provider (0.6.67) does not protect a plan after it: the data sources'
  reads go to the v1 API.
- **Our check.** `make soperator-check` prints a notice and fails from `SOPERATOR_V1_PROJECT_DEADLINE`
  = 2026-11-16 ([`Makefile`](../../Makefile)), a month before the API date, so the re-pin is
  scheduled. From today it greps for both data sources (`nebius_iam_v1_(project|tenant)`), so a future
  tag that drops only the project one cannot pass it by accident.
- **Who is affected.** Run 4's R4 apply in `lab` (plan "Run 4"), and every Soperator plan after
  2026-12-16. R4 has not been applied by this repository yet.

## Option A — wait for an upstream tag

Keep `soperator-v4.1.13-2`; re-run the Z3 check (`git ls-remote …`, then the grep of the plan's Z3 row,
now for both names) weekly; when a tag without both data sources appears, re-pin per
[`runbooks/upgrade.md`](../../runbooks/upgrade.md#soperator) (tag + commit in `platform/versions.yaml`
and `scripts/fetch-soperator.sh`, re-verify the override fragments, `make soperator-check`).

- For: no fork, no drift from upstream (ADR-0008: the recipe is wrapped, not forked).
- Against: no tag up to `soperator-v4.1.13-2` (2026-10-07) drops either data source, and `main`
  (2026-10-09) still has both. From 2026-11-16 `make ci-docker TARGETS="… soperator-check"` fails; if nothing lands by
  2026-12-16, Soperator cannot be planned at all. Open an upstream issue now either way.

## Option B — patch the vendored copy (drop both data sources)

The exact change, against the pinned commit `d1c15caa37d330db88cb20bfef8dfceee4852032`
(`soperator-v4.1.13-2`). It replaces each `data.nebius_iam_v1_project.this.id` with the variable the
data source was looked up by (the same string), and deletes the unused tenant data source:

```diff
diff --git a/soperator/installations/example/main.tf b/soperator/installations/example/main.tf
index 1fe852c..fbd93ee 100644
--- a/soperator/installations/example/main.tf
+++ b/soperator/installations/example/main.tf
@@ -137,7 +137,7 @@ module "filestore" {
     terraform_data.check_variables,
   ]
 
-  iam_project_id = data.nebius_iam_v1_project.this.id
+  iam_project_id = var.iam_project_id
 
   k8s_cluster_name = local.k8s_cluster_name
 
@@ -201,7 +201,7 @@ module "nfs-server" {
 
   source = "../../../modules/nfs-server"
 
-  parent_id = data.nebius_iam_v1_project.this.id
+  parent_id = var.iam_project_id
   subnet_id = data.nebius_vpc_v1_subnet.this.id
 
   platform      = var.nfs.resource.platform
@@ -264,7 +264,7 @@ module "k8s" {
 
   source = "../../modules/k8s"
 
-  iam_project_id  = data.nebius_iam_v1_project.this.id
+  iam_project_id  = var.iam_project_id
   vpc_subnet_id   = data.nebius_vpc_v1_subnet.this.id
   login_public_ip = var.slurm_login_public_ip
 
@@ -332,7 +332,7 @@ module "nvidia_operator_network" {
   source = "../../../modules/network-operator"
 
   cluster_id = module.k8s.cluster_id
-  parent_id  = data.nebius_iam_v1_project.this.id
+  parent_id  = var.iam_project_id
 
   providers = {
     nebius = nebius
@@ -349,7 +349,7 @@ module "nvidia_operator_gpu" {
   source = "../../../modules/gpu-operator"
 
   cluster_id = module.k8s.cluster_id
-  parent_id  = data.nebius_iam_v1_project.this.id
+  parent_id  = var.iam_project_id
 
   enable_dcgm_exporter        = var.dcgm_job_mapping_enabled == false && var.telemetry_enabled
   enable_dcgm_service_monitor = var.dcgm_job_mapping_enabled == false && var.telemetry_enabled
diff --git a/soperator/installations/example/variables.tf b/soperator/installations/example/variables.tf
index e453848..f0f02dc 100644
--- a/soperator/installations/example/variables.tf
+++ b/soperator/installations/example/variables.tf
@@ -31,9 +31,6 @@ variable "iam_project_id" {
     error_message = "ID of the IAM project must start with `project-`."
   }
 }
-data "nebius_iam_v1_project" "this" {
-  id = var.iam_project_id
-}
 
 variable "iam_tenant_id" {
   description = "ID of the IAM tenant."
@@ -46,10 +43,6 @@ variable "iam_tenant_id" {
   }
 }
 
-data "nebius_iam_v1_tenant" "this" {
-  id = var.iam_tenant_id
-}
-
 variable "o11y_iam_tenant_id" {
   description = "ID of the IAM tenant for O11y."
   type        = string
```

**Test (run 2026-10-13, offline, toolbox image):** the recipe fetched at the pinned commit by
`scripts/fetch-soperator.sh --no-backend`, the diff applied with `git apply --check` then `git apply`,
then the same steps as `make soperator-check`: no `nebius_iam_v1_project` / `nebius_iam_v1_tenant`
left in `installations/example/*.tf`; `terraform-soperator fmt -check` on both files; `init
-backend=false -lockfile=readonly`; `validate` → "Success! The configuration is valid." **with no
deprecation warning** (unpatched, `validate` warns for the project data source on every plan); the
mocked plan test (`tests-nip`, our overrides) for `sandbox`, `staging`, `prod` and `lab` → 1 passed, 0
failed each; then the checkout was restored to the pinned commit (0 tracked files differ). Re-run it:

```bash
# from the repo root; the diff above saved as .cache/sop-patch/soperator-drop-v1-project.diff
docker run --rm --platform linux/amd64 --user "$(id -u):$(id -g)" -v "$PWD:/repo" -v nip-tf-cache:/cache/terraform nip-toolbox bash -c '
  set -euo pipefail; cd /repo; scripts/fetch-soperator.sh --no-backend >/dev/null
  U=/repo/terraform/stacks/soperator/upstream; D=$U/soperator/installations/example
  trap "git -C $U checkout -q -- ." EXIT
  git -C $U apply /repo/.cache/sop-patch/soperator-drop-v1-project.diff
  ! grep -nE "nebius_iam_v1_(project|tenant)" $D/*.tf
  cd $D; export TF_DATA_DIR=.terraform/check
  terraform-soperator init -backend=false -input=false -lockfile=readonly >/dev/null && terraform-soperator validate
  for s in sandbox staging prod lab; do terraform-soperator test -test-directory=tests-nip -var-file=terraform.tfvars \
    -var-file=/repo/terraform/stacks/soperator/profiles/lab.tfvars -var-file=/repo/terraform/live/$s/soperator/stage.tfvars \
    -var iam_merge_request_url=https://example.invalid/mr/1; done'
```

**How it would ship (not done):** commit the diff as `terraform/stacks/soperator/patches/0001-drop-iam-v1-data-sources.diff`;
in `scripts/fetch-soperator.sh`, after the sparse checkout and before the overrides,
`git -C "${dest}" apply --check "${env_dir}/patches/"*.diff && git -C "${dest}" apply "${env_dir}/patches/"*.diff`
(a patch that no longer applies stops the fetch, so a re-pin re-reviews it); make the re-fetch test
compare `git diff` to the patch, since today it checks only the tag and HEAD and would keep a dirty tree;
record it in [`terraform/stacks/soperator/README.md`](../../terraform/stacks/soperator/README.md) and
ADR-0008 as the one deviation from "wrapped, not forked"; drop the patch at the first upstream tag that
needs it no more.

- For: removes the date risk now; semantics unchanged (the data source only echoed the id it was given;
  the plan no longer fails fast on a wrong project id, the first resource does instead); 2 files,
  5 lines changed and 7 removed; tested on every stage's mocked plan.
- Against: a 12-line fork to carry until upstream catches up; the live plan and apply with the patch
  have not run (R4 in `lab` would be the first); a re-pin must re-check it.

## Option C — move `SOPERATOR_V1_PROJECT_DEADLINE` to 2026-12-09

Change the one Makefile line from 2026-11-16 to **2026-12-09** (one week before the API date, not after
it): `soperator-check` keeps printing the notice until then and fails from it.

- Rationale: the 2026-11-16 date was chosen a month before the API date to schedule a re-pin, assuming a
  tag would exist; none does, and failing CI from 2026-11-16 forces A or B anyway, three weeks before
  anything breaks. A week of margin still leaves time to apply B (tested above) before 2026-12-16.
- Against: it only moves the alarm; on its own it fixes nothing, and every day after 2026-11-16 without
  A or B narrows the window for R4. Not later than 2026-12-09: after 2026-12-16 the check would pass
  while every Soperator plan fails.

## Recommendation

**B now, A in parallel, C only if B is declined.** Ship the tested patch through `fetch-soperator.sh`
(reviewed, reversible, drops cleanly when upstream catches up) before run 4's R4 apply, so the first live
Soperator apply in `lab` runs on the code that survives 2026-12-16; open the upstream issue the same day
(A) and remove the patch at the first tag without both data sources. If the owner prefers not to carry a
fork, take C (2026-12-09) and decide again on 2026-12-01.

## Owner decision

`DECISION (owner, 2026-10-13): [x] B patch + A issue   [ ] C deadline 2026-12-09 + A   [ ] A only (accept CI failing from 2026-11-16)`

Shipped as described in "How it would ship" (2026-10-13): [`patches/0001-drop-iam-v1-data-sources.diff`](../../terraform/stacks/soperator/patches/0001-drop-iam-v1-data-sources.diff),
applied by `scripts/fetch-soperator.sh`; `make soperator-check` now fails if either data source is left
(the `SOPERATOR_V1_PROJECT_DEADLINE` notice is gone); [README](../../terraform/stacks/soperator/README.md#patches),
ADR-0008, R4-14. The upstream issue (A) is drafted, not posted:
[2026-10-13-soperator-upstream-issue.md](2026-10-13-soperator-upstream-issue.md).
