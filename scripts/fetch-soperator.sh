#!/usr/bin/env bash
# Fetch the upstream Soperator Terraform recipe at the pinned tag into
# terraform/stacks/soperator/upstream/ (git-ignored), apply our patches (patches/*.diff), install
# our override fragments, and render
# the S3 backend override from the backend.hcl that scripts/bootstrap-backend.sh <stage> soperator
# wrote into terraform/live/<stage>/soperator/.
# Usage: scripts/fetch-soperator.sh [--stage <sandbox|staging|prod|lab>] [--no-backend]
set -euo pipefail
stage="sandbox"; with_backend=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage) stage="${2:?--stage needs a value}"; shift 2 ;;
    --no-backend) with_backend=0; shift ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

TAG="${SOPERATOR_RECIPE_TAG:-soperator-v4.1.13-2}" # see platform/versions.yaml
# The commit that tag pointed to when it was reviewed (upstream.nebius-solutions-library.ref): a tag
# can be moved, a commit cannot, so the checkout must be exactly this commit (make pins checks both).
COMMIT="${SOPERATOR_RECIPE_COMMIT:-d1c15caa37d330db88cb20bfef8dfceee4852032}"
command -v git >/dev/null || { echo "missing: git" >&2; exit 2; }
# The recipe's destroy-time cleanup (CSI disks) runs python3 >= 3.11 and the nebius CLI; say so
# before the first apply rather than at teardown.
if ! command -v python3 >/dev/null; then
  echo "Warning: python3 not found; the recipe's destroy-time cleanup needs python3 >= 3.11 (runbooks/soperator-jobs.md)" >&2
elif ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
  echo "Warning: python3 < 3.11 found; the recipe's destroy-time cleanup needs >= 3.11 (runbooks/soperator-jobs.md)" >&2
fi
REPO="${NIP_SOPERATOR_REPO:-https://github.com/nebius/nebius-solutions-library.git}" # override: tests only
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_dir="${repo_root}/terraform/stacks/soperator"
stage_dir="${repo_root}/terraform/live/${stage}/soperator"
[[ -d "${stage_dir}" ]] || { echo "unknown stage '${stage}': ${stage_dir} does not exist (platform/stages.yaml)" >&2; exit 2; }
dest="${NIP_SOPERATOR_DEST:-${env_dir}/upstream}" # NIP_SOPERATOR_DEST: tests only (tests/scripts)
# The one deviation from "wrapped, not forked" (ADR-0008): patches/*.diff, applied in name order to the
# pinned commit. Each says why it exists and when to drop it (terraform/stacks/soperator/README.md).
patches_dir="${NIP_SOPERATOR_PATCHES:-${env_dir}/patches}" # NIP_SOPERATOR_PATCHES: tests only
patches=()
for p in "${patches_dir}"/*.diff; do [[ -f "${p}" ]] && patches+=("${p}"); done
# What a reused checkout must match: the patch set, and the tracked-file diff right after applying it
# (both recorded in .git/ when the patches are applied). Untracked files (overrides, tests-nip, the
# lock file, the backend override) are ours and re-copied on every run.
patch_set() { for p in ${patches[@]+"${patches[@]}"}; do printf '== %s\n' "$(basename "${p}")"; cat "${p}"; done; }
stamp_set="${dest}/.git/nip-patch-set"; stamp_diff="${dest}/.git/nip-patched.diff"

if [[ -d "${dest}/.git" ]]; then
  current="$(git -C "${dest}" describe --tags --exact-match 2>/dev/null || echo none)"
  head="$(git -C "${dest}" rev-parse HEAD 2>/dev/null || echo none)"
  if [[ "${current}" != "${TAG}" || "${head}" != "${COMMIT}" ]]; then
    echo "upstream/ is at ${current} (${head}), expected ${TAG} (${COMMIT}); removing and re-fetching" >&2
    rm -rf "${dest}"
  elif ! cmp -s <(patch_set) "${stamp_set}" 2>/dev/null || ! cmp -s <(git -C "${dest}" diff HEAD) "${stamp_diff}" 2>/dev/null; then
    echo "upstream/ differs from ${TAG} plus the patch set (${#patches[@]} in ${patches_dir}): a local edit, a missing or changed patch; removing and re-fetching" >&2
    rm -rf "${dest}"
  fi
fi
if [[ ! -d "${dest}/.git" ]]; then
  git clone --quiet --depth 1 --filter=blob:none --sparse --branch "${TAG}" "${REPO}" "${dest}"
  head="$(git -C "${dest}" rev-parse HEAD 2>/dev/null || echo none)"
  if [[ "${head}" != "${COMMIT}" ]]; then
    rm -rf "${dest}"
    echo "refusing: tag ${TAG} now points to ${head}, not the reviewed commit ${COMMIT} (platform/versions.yaml upstream.nebius-solutions-library.ref). Review the new commit before re-pinning both." >&2
    exit 1
  fi
  git -C "${dest}" sparse-checkout set soperator modules # the recipe references ../../../modules
  # Patches go on the clean checkout, before the overrides. --check first, so a patch that no longer
  # applies (a re-pin, or upstream fixed it) stops the fetch and removes the checkout, so nothing
  # half-patched is left to reuse.
  for p in ${patches[@]+"${patches[@]}"}; do
    if ! err="$(git -C "${dest}" apply --check "${p}" 2>&1)"; then
      echo "${err}" >&2; rm -rf "${dest}"
      echo "refusing: patch $(basename "${p}") no longer applies to ${TAG} (${COMMIT}). Re-review it against this tag: if upstream already made the change, delete the patch (terraform/stacks/soperator/README.md#patches); otherwise rebase it." >&2
      exit 1
    fi
    git -C "${dest}" apply "${p}"
  done
  patch_set > "${stamp_set}"
  git -C "${dest}" diff HEAD > "${stamp_diff}"
fi
# Cone-mode sparse checkout retains root files, including LICENSE and any NOTICE.
# Check the actual resulting tree on fresh and reused fetches before installing overrides:
# a future re-pin or checkout-mode change must not silently produce an unlicensed artifact.
if [[ ! -s "${dest}/LICENSE" ]]; then
  rm -rf "${dest}"
  echo "refusing: upstream LICENSE is missing or empty at ${COMMIT}; review source distribution terms before re-pinning" >&2
  exit 1
fi
echo "Soperator recipe ${TAG} (${COMMIT}) at ${dest}/soperator (VERSION $(cat "${dest}/soperator/VERSION"))"
echo "Patches applied: $(if (( ${#patches[@]} )); then for p in "${patches[@]}"; do printf '%s ' "$(basename "${p}")"; done; else echo none; fi)"

install_dir="${dest}/soperator/installations/example"
# Pin the recipe's floating provider constraints (nebius >= 0.6.23, helm < 3, flux >= 1.5) to
# the versions CI tested: the committed lock file is copied in and init runs read-only on it.
cp "${env_dir}/.terraform.lock.hcl" "${install_dir}/.terraform.lock.hcl"
# Our mocked plan test lives beside the recipe so `terraform test` can find it.
mkdir -p "${install_dir}/tests-nip"
cp "${env_dir}/tests/overrides.tftest.hcl" "${install_dir}/tests-nip/"
# Override files (Terraform *_override.tf merge semantics) that fix findings from the live
# runs without forking the recipe; one directory per vendored module they target.
for f in "${env_dir}"/overrides/modules/*/*.tf; do
  module_dir="${dest}/soperator/modules/$(basename "$(dirname "${f}")")"
  [[ -d "${module_dir}" ]] || { echo "Override target ${module_dir} does not exist at ${TAG}; re-check ${f}" >&2; exit 1; }
  cp "${f}" "${module_dir}/"
done
echo "Overrides installed: $(find "${env_dir}/overrides/modules" -name '*.tf' -exec basename {} \; | tr '\n' ' ')"
if [[ "${with_backend}" == 1 ]]; then
  backend="${stage_dir}/backend.hcl"
  if [[ ! -f "${backend}" ]]; then
    echo "No ${backend}: run 'source scripts/bootstrap-backend.sh ${stage} soperator' first (or pass --no-backend for static checks)" >&2
    exit 1
  fi
  bucket="$(awk -F'"' '/^bucket/ {print $2}' "${backend}")"
  key="$(awk -F'"' '/^key/ {print $2}' "${backend}")"
  region="$(awk -F'"' '/^region/ {print $2}' "${backend}")"
  cat > "${install_dir}/terraform_backend_override.tf" <<EOT
# Generated by scripts/fetch-soperator.sh from terraform/live/${stage}/soperator/backend.hcl. Do not commit.
terraform {
  backend "s3" {
    bucket = "${bucket}"
    key    = "${key}"
    region = "${region}"
    endpoints = {
      s3 = "https://storage.${region}.nebius.cloud:443"
    }
    skip_region_validation      = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    skip_metadata_api_check     = true
    use_lockfile                = true
  }
}
EOT
  echo "Backend override written to ${install_dir}/terraform_backend_override.tf"
fi
var_files="-var-file=terraform.tfvars -var-file=${env_dir}/profiles/lab.tfvars -var-file=${stage_dir}/stage.tfvars"
echo "Static check: cd ${install_dir} && export TF_DATA_DIR=.terraform/check && terraform init -backend=false -lockfile=readonly && terraform test -test-directory=tests-nip ${var_files}"
echo "Next:         cd ${install_dir} && terraform init && terraform plan ${var_files} -out=soperator-${stage}.tfplan   (stage ${stage}; prod also needs -var iam_merge_request_url=<url>)"
