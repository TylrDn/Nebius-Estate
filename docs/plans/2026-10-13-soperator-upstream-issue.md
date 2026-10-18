# Upstream issue draft: Soperator example and the v1 IAM data sources (2026-10-13)

**DRAFT, not posted.** Option A of the owner's decision "B patch + A issue"
([options](2026-10-13-soperator-options.md)). The owner posts it at
<https://github.com/nebius/nebius-solutions-library/issues/new> after reading it; nothing here has
been sent. Everything between the two rules below is the issue as it would be posted. It names no
project, tenant or other id of ours.

---

**Title:** `soperator/installations/example`: `data.nebius_iam_v1_project` and `data.nebius_iam_v1_tenant` stop working on 2026-12-16 (v1 IAM API deprecation)

### Versions

- Recipe: tag `soperator-v4.1.13-2` (commit `d1c15caa37d330db88cb20bfef8dfceee4852032`), the newest
  `soperator-v*` tag on 2026-10-13. `main` at `fba7148` (2026-10-09) has the same code.
- Provider: `nebius/nebius` 0.6.67 (the recipe's constraint is `>= 0.6.23`).
- Terraform 1.12.2.

### What

`soperator/installations/example/variables.tf` declares two data sources on the v1 IAM API:

```hcl
data "nebius_iam_v1_project" "this" {
  id = var.iam_project_id
}

data "nebius_iam_v1_tenant" "this" {
  id = var.iam_tenant_id
}
```

- `data.nebius_iam_v1_project.this` is read in five places of `main.tf` (`module "filestore"`,
  `module "nfs-server"`, `module "k8s"`, `module "nvidia_operator_network"`, `module "nvidia_operator_gpu"`),
  each only for `.id`, which is `var.iam_project_id` itself.
- `data.nebius_iam_v1_tenant.this` is never referenced.

The provider marks both deprecated with an end date. `terraform validate` on the example at the tag:

```text
Warning: Deprecated
  with data.nebius_iam_v1_project.this,
  on variables.tf line 34, in data "nebius_iam_v1_project" "this":
Supported until 2026-12-16. Project service v1 API is deprecated. Please use
the v2 API instead. All projects remain accessible through the v2 API.

(and one more similar warning elsewhere)
```

The folded second warning (`terraform validate -json`) is the tenant one:

```text
data.nebius_iam_v1_tenant.this  Supported until 2026-12-16. Tenant service v1 API is deprecated.
Please use the v2 API instead. All tenants remain accessible through the v2 API.
```

The provider release notes on docs.nebius.com (Terraform provider, "Release notes") list
"Deprecated data sources: nebius_iam_v1_project, nebius_iam_v1_tenant" (entry dated 2026-09-21). The
data source reference pages (`/terraform-provider/reference/data-sources/iam_v1_project`, `…/iam_v1_tenant`)
do not show the end date; it is in the provider's deprecation message only.

Since the date belongs to the API, pinning an older provider does not help: after 2026-12-16 every plan
of the example reads both data sources through the v1 API, so it can be expected to fail before it
creates or changes anything.

### Minimal fix

Use the variable the data source was looked up by, and drop the unused tenant data source. 2 files,
5 lines changed, 7 removed; behaviour is the same except that a wrong project id no longer fails at the
data source read but at the first resource that uses it (`iam_project_id` already has a `project-`
prefix validation):

```diff
diff --git a/soperator/installations/example/main.tf b/soperator/installations/example/main.tf
--- a/soperator/installations/example/main.tf
+++ b/soperator/installations/example/main.tf
@@ -137,7 +137,7 @@ module "filestore" {
-  iam_project_id = data.nebius_iam_v1_project.this.id
+  iam_project_id = var.iam_project_id
@@ -201,7 +201,7 @@ module "nfs-server" {
-  parent_id = data.nebius_iam_v1_project.this.id
+  parent_id = var.iam_project_id
@@ -264,7 +264,7 @@ module "k8s" {
-  iam_project_id  = data.nebius_iam_v1_project.this.id
+  iam_project_id  = var.iam_project_id
@@ -332,7 +332,7 @@ module "nvidia_operator_network" {
-  parent_id  = data.nebius_iam_v1_project.this.id
+  parent_id  = var.iam_project_id
@@ -349,7 +349,7 @@ module "nvidia_operator_gpu" {
-  parent_id  = data.nebius_iam_v1_project.this.id
+  parent_id  = var.iam_project_id
diff --git a/soperator/installations/example/variables.tf b/soperator/installations/example/variables.tf
--- a/soperator/installations/example/variables.tf
+++ b/soperator/installations/example/variables.tf
@@ -31,9 +31,6 @@ variable "iam_project_id" {
-data "nebius_iam_v1_project" "this" {
-  id = var.iam_project_id
-}
@@ -46,10 +43,6 @@ variable "iam_tenant_id" {
-data "nebius_iam_v1_tenant" "this" {
-  id = var.iam_tenant_id
-}
-
```

(Context lines trimmed; the full patch, which applies with `git apply` at `d1c15ca`, is attached.) If a
lookup is wanted to fail fast on a wrong id, `nebius_iam_v2_project` / `nebius_iam_v2_tenant` exist in
the provider; we did not test that variant.

### Evidence

At `d1c15ca` with the patch applied, offline (`terraform init -backend=false -lockfile=readonly`,
provider 0.6.67): no `nebius_iam_v1_project` / `nebius_iam_v1_tenant` left in
`installations/example/*.tf`; `terraform validate` reports "The configuration is valid." with no
deprecation warning; a mocked plan (`terraform test` with `mock_provider`) of the example with four
different var-file sets passes. We have not yet run a live plan or apply with the patch.

### Ask

A tag of the Soperator recipe without both v1 IAM data sources before 2026-12-16, so users of the
example do not have to patch it.

---

## For the owner (not part of the issue)

- **Attach** [`terraform/stacks/soperator/patches/0001-drop-iam-v1-data-sources.diff`](../../terraform/stacks/soperator/patches/0001-drop-iam-v1-data-sources.diff)
  (the full diff; the issue body trims context lines for reading, so the inline one does not apply as is).
- **Where each fact comes from.** Tag list: `git ls-remote --tags https://github.com/nebius/nebius-solutions-library.git 'soperator-v*'`
  (2026-10-13, [options](2026-10-13-soperator-options.md)). Warnings: `terraform-soperator validate` and
  `validate -json` in the toolbox image on the unpatched checkout at `d1c15ca`, provider 0.6.67
  (2026-10-13). Release notes: the docs mirror, `.cache/nebius-docs/terraform-provider/reference/release-notes.md`
  (fetched 2026-10-11), entry labelled `0.5.274`, "2026-09-21"; the label numbering does not match the
  0.6.x provider versions, so the issue quotes the date, not the label. The mirror's two data-source pages
  carry no deprecation notice or date (as R4-14 already records). Patched result: `make soperator-check`
  (validate, mocked plan for `sandbox`, `staging`, `prod`, `lab`), 2026-10-13.
- **After posting:** add the issue link to [R4-14](../upstream-findings.md) and the
  [stack README](../../terraform/stacks/soperator/README.md#patches). When a tag without both data
  sources exists, re-pin, delete `patches/0001` (the fetch stops on it anyway) and close R4-14.
