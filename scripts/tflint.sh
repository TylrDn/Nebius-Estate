#!/usr/bin/env bash
# Run tflint on every Terraform directory this repo ships, with the repo's config.
# Shared by `make lint` and CI so both lint exactly the same set:
#   - terraform/modules/*, terraform/stacks/* (and their tests' module dirs)
#   - NOT terraform/stacks/soperator/upstream/ (the vendored recipe, git-ignored, linted upstream)
#   - NOT terraform/stacks/soperator/overrides/ (*_override.tf fragments merge into vendored
#     modules and only make sense there; terraform fmt still covers them)
# Usage: scripts/tflint.sh
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"
tflint --init >/dev/null
rc=0
while IFS= read -r dir; do
  echo "== ${dir}"
  tflint --chdir="${dir}" --config="${repo_root}/.tflint.hcl" --minimum-failure-severity=warning || rc=1
done < <(find terraform -name '*.tf' -not -path '*/.terraform/*' -not -path '*/upstream/*' -not -path '*/overrides/*' -exec dirname {} \; | sort -u)
exit "${rc}"
