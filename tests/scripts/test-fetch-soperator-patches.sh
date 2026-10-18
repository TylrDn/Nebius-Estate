#!/usr/bin/env bash
# scripts/fetch-soperator.sh applies terraform/stacks/soperator/patches/*.diff to the pinned recipe
# (after the sparse checkout, before the overrides) with real git against a fake local upstream:
# a patch that no longer applies stops the fetch; a reused checkout must be exactly the pinned
# commit plus the patch set (a dirty tree or a changed patch set is re-fetched).
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
command -v git >/dev/null || { echo "skip test-fetch-soperator-patches: no git"; exit 0; }
export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
fetch="${repo_root}/scripts/fetch-soperator.sh"

# Fake upstream: the files the script touches, the override targets, one tag.
up="${work}/fake-upstream"; mkdir -p "${up}/soperator/installations/example" "${up}/modules/x"
echo 4.1.13 > "${up}/soperator/VERSION"
printf "Test upstream license\nCopyright test contributors\n" > "${up}/LICENSE"
echo "Test upstream notice" > "${up}/NOTICE"
printf 'module "k8s" {\n  iam_project_id = data.nebius_iam_v1_project.this.id\n}\n' > "${up}/soperator/installations/example/main.tf"
printf 'data "nebius_iam_v1_project" "this" {\n  id = var.iam_project_id\n}\n' > "${up}/soperator/installations/example/variables.tf"
echo '# x' > "${up}/modules/x/main.tf"
for m in "${repo_root}"/terraform/stacks/soperator/overrides/modules/*/; do
  mkdir -p "${up}/soperator/modules/$(basename "${m}")"; echo '# m' > "${up}/soperator/modules/$(basename "${m}")/main.tf"
done
git -C "${up}" init -q -b main && git -C "${up}" add -A && git -C "${up}" commit -qm upstream && git -C "${up}" tag soperator-vtest
git -C "${up}" config uploadpack.allowFilter true
export SOPERATOR_RECIPE_TAG=soperator-vtest SOPERATOR_RECIPE_COMMIT
SOPERATOR_RECIPE_COMMIT="$(git -C "${up}" rev-parse HEAD)"
export NIP_SOPERATOR_REPO="file://${up}" NIP_SOPERATOR_DEST="${work}/upstream" NIP_SOPERATOR_PATCHES="${work}/patches"
ex="${NIP_SOPERATOR_DEST}/soperator/installations/example"

# Two patches in the format of patches/0001 (git diff, paths from the upstream repo root).
mkdir -p "${NIP_SOPERATOR_PATCHES}"
cat > "${NIP_SOPERATOR_PATCHES}/0001-main.diff" <<'EOF'
diff --git a/soperator/installations/example/main.tf b/soperator/installations/example/main.tf
--- a/soperator/installations/example/main.tf
+++ b/soperator/installations/example/main.tf
@@ -1,3 +1,3 @@
 module "k8s" {
-  iam_project_id = data.nebius_iam_v1_project.this.id
+  iam_project_id = var.iam_project_id
 }
EOF
cat > "${NIP_SOPERATOR_PATCHES}/0002-variables.diff" <<'EOF'
diff --git a/soperator/installations/example/variables.tf b/soperator/installations/example/variables.tf
--- a/soperator/installations/example/variables.tf
+++ b/soperator/installations/example/variables.tf
@@ -1,3 +0,0 @@
-data "nebius_iam_v1_project" "this" {
-  id = var.iam_project_id
-}
EOF
run() { set +e; "${fetch}" --no-backend >"${work}/out" 2>"${work}/err"; rc=$?; set -e; }

test_name="fetch-soperator-applies-patches"
run
[[ "${rc}" -eq 0 ]] || fail "rc=${rc}: $(cat "${work}/err")"
grep -q 'iam_project_id = var.iam_project_id' "${ex}/main.tf" || fail "0001 not applied: $(cat "${ex}/main.tf")"
[[ ! -s "${ex}/variables.tf" ]] || fail "0002 not applied: $(cat "${ex}/variables.tf")"
for n in 0001-main.diff 0002-variables.diff; do grep -q "${n}" "${work}/out" || fail "the applied patches must be named (${n}): $(cat "${work}/out")"; done
[[ -f "${NIP_SOPERATOR_DEST}/soperator/modules/slurm/nip_monitoring_override.tf" ]] || fail "overrides must still be installed after the patches"
cmp -s "${up}/LICENSE" "${NIP_SOPERATOR_DEST}/LICENSE" || fail "the exact upstream license must accompany the fetched tree"
cmp -s "${up}/NOTICE" "${NIP_SOPERATOR_DEST}/NOTICE" || fail "the upstream notice must accompany the fetched tree"
ok "both patches applied, overrides installed, source notices retained"

test_name="fetch-soperator-reuses-patched-checkout"
echo marker > "${NIP_SOPERATOR_DEST}/.git/nip-test-marker"
run
[[ "${rc}" -eq 0 ]] || fail "re-run rc=${rc}: $(cat "${work}/err")"
[[ -f "${NIP_SOPERATOR_DEST}/.git/nip-test-marker" ]] || fail "an unchanged patched checkout must be reused, not re-cloned: $(cat "${work}/err")"
grep -c 'iam_project_id = var.iam_project_id' "${ex}/main.tf" | grep -qx 1 || fail "the patch must not be applied twice"
ok "reused, patched once"

test_name="fetch-soperator-refetches-dirty-tree"
echo '# local edit' >> "${ex}/main.tf"
run
[[ "${rc}" -eq 0 ]] || fail "rc=${rc}: $(cat "${work}/err")"
grep -q 'differs from' "${work}/err" || fail "a dirty tree must be reported: $(cat "${work}/err")"
[[ ! -e "${NIP_SOPERATOR_DEST}/.git/nip-test-marker" ]] || fail "a dirty tree must be re-fetched, not reused"
! grep -q 'local edit' "${ex}/main.tf" || fail "the local edit survived the re-fetch"
grep -q 'iam_project_id = var.iam_project_id' "${ex}/main.tf" || fail "the re-fetched tree must be patched again"
ok "dirty tree caught and re-fetched"

test_name="fetch-soperator-refetches-staged-edit"
echo marker > "${NIP_SOPERATOR_DEST}/.git/nip-test-marker"
other="$(find "${NIP_SOPERATOR_DEST}/soperator/modules" -name main.tf -type f | sort | head -1)"
echo '# staged edit' >> "${other}"; git -C "${NIP_SOPERATOR_DEST}" add -- "${other}"
run
[[ "${rc}" -eq 0 ]] || fail "rc=${rc}: $(cat "${work}/err")"
grep -q 'differs from' "${work}/err" || fail "a staged edit in a file no patch touches must be reported: $(cat "${work}/err")"
[[ ! -e "${NIP_SOPERATOR_DEST}/.git/nip-test-marker" ]] || fail "a checkout with a staged edit must be re-fetched, not reused"
ok "staged edit in an unpatched file caught"

test_name="fetch-soperator-refetches-unpatched-tree"
git -C "${NIP_SOPERATOR_DEST}" checkout -q -- .
run
[[ "${rc}" -eq 0 ]] || fail "rc=${rc}: $(cat "${work}/err")"
grep -q 'differs from' "${work}/err" || fail "a checkout missing the patches must be reported: $(cat "${work}/err")"
grep -q 'iam_project_id = var.iam_project_id' "${ex}/main.tf" || fail "the re-fetched tree must be patched"
ok "unpatched tree caught"

test_name="fetch-soperator-refetches-changed-patch-set"
echo marker > "${NIP_SOPERATOR_DEST}/.git/nip-test-marker"
mv "${NIP_SOPERATOR_PATCHES}/0002-variables.diff" "${work}/0002.held"
run
[[ "${rc}" -eq 0 ]] || fail "rc=${rc}: $(cat "${work}/err")"
[[ ! -e "${NIP_SOPERATOR_DEST}/.git/nip-test-marker" ]] || fail "a changed patch set must re-fetch"
grep -q 'nebius_iam_v1_project' "${ex}/variables.tf" || fail "a removed patch must no longer be applied"
mv "${work}/0002.held" "${NIP_SOPERATOR_PATCHES}/0002-variables.diff"
ok "patch set change re-fetched"

test_name="fetch-soperator-stops-on-stale-patch"
cat > "${NIP_SOPERATOR_PATCHES}/0003-stale.diff" <<'EOF'
diff --git a/soperator/installations/example/main.tf b/soperator/installations/example/main.tf
--- a/soperator/installations/example/main.tf
+++ b/soperator/installations/example/main.tf
@@ -1,3 +1,3 @@
 module "k8s" {
-  iam_project_id = something.that.upstream.no.longer.has
+  iam_project_id = var.iam_project_id
 }
EOF
run
[[ "${rc}" -ne 0 ]] || fail "a patch that no longer applies must stop the fetch: $(cat "${work}/out")"
grep -q 'patch 0003-stale.diff no longer applies' "${work}/err" || fail "the error must name the patch: $(cat "${work}/err")"
! grep -q 'Overrides installed' "${work}/out" || fail "overrides must not be installed after a failed patch"
[[ ! -e "${NIP_SOPERATOR_DEST}" ]] || fail "a checkout whose patches failed must be removed, not left half-patched"
rm "${NIP_SOPERATOR_PATCHES}/0003-stale.diff"
ok "stopped with the patch named"

test_name="fetch-soperator-no-patches"
rm -f "${NIP_SOPERATOR_PATCHES}"/*.diff
run
[[ "${rc}" -eq 0 ]] || fail "an empty patch set must fetch the recipe as-is: $(cat "${work}/err")"
grep -q 'nebius_iam_v1_project.this.id' "${ex}/main.tf" || fail "with no patches the recipe must be unchanged"
ok "no patches, recipe as-is"

test_name="fetch-soperator-real-patch-set"
real="${repo_root}/terraform/stacks/soperator/patches"
[[ -f "${real}/0001-drop-iam-v1-data-sources.diff" ]] || fail "patches/0001-drop-iam-v1-data-sources.diff is missing"
for p in "${real}"/*.diff; do
  grep -q '^diff --git a/soperator/' "${p}" || fail "${p}: paths must be relative to the upstream repo root (a/soperator/...)"
done
for t in project tenant; do
  grep -q "^-data \"nebius_iam_v1_${t}\" \"this\"" "${real}/0001-drop-iam-v1-data-sources.diff" || fail "0001 must drop data.nebius_iam_v1_${t}"
done
! grep -q '^+.*nebius_iam_v1_' "${real}/0001-drop-iam-v1-data-sources.diff" || fail "0001 must not add a v1 IAM reference"
ok "patches/0001 drops both data sources (it applies to the real recipe in make soperator-check)"

# A new pinned source without its license must never become a distributable tree.
test_name="fetch-soperator-rejects-missing-license"
git -C "${up}" rm -q LICENSE
git -C "${up}" commit -qm 'fixture without license'
git -C "${up}" tag soperator-vtest-no-license
export SOPERATOR_RECIPE_TAG=soperator-vtest-no-license
SOPERATOR_RECIPE_COMMIT="$(git -C "${up}" rev-parse HEAD)"
run
[[ "${rc}" -ne 0 ]] || fail "a source checkout missing its license must be rejected"
grep -q 'upstream LICENSE' "${work}/err" || fail "the error must identify the missing source license"
[[ ! -e "${NIP_SOPERATOR_DEST}" ]] || fail "an unlicensed checkout must not remain available for packaging"
ok "missing license rejected"
