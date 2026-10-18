#!/usr/bin/env bash
# The offline checks (make validate / test / soperator-check) must pass in a root that a live run
# has initialised: a live `init` leaves .terraform/terraform.tfstate pointing at the S3 backend, and
# `init -backend=false` on that data dir still configures the saved backend, so it asks for cloud
# credentials ("No valid credential sources found"; 2026-10-11, after a live soperator plan). The
# Makefile gives the checks their own data dir (TF_CHECK, .terraform/check). This plants that stale pointer in a probe root with an S3 backend
# and runs the real `make validate test` on it. Builtin provider only: offline, no cloud. Skipped
# when terraform is not installed.
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
test_name=offline-checks-ignore-live-backend-pointer
command -v terraform >/dev/null || { echo "skip ${test_name}: terraform not installed"; exit 0; }
root="${work}/probe"
mkdir -p "${root}/tests" "${root}/.terraform"
cat > "${root}/main.tf" <<'EOF'
terraform {
  backend "s3" {}
}

resource "terraform_data" "probe" {
  input = "ok"
}
EOF
cat > "${root}/tests/probe.tftest.hcl" <<'EOF'
run "plan" {
  command = plan
  assert {
    condition     = terraform_data.probe.input == "ok"
    error_message = "probe input"
  }
}
EOF
# What a live `init` against the stage bucket leaves behind (fake bucket; the endpoint is unroutable).
cat > "${root}/.terraform/terraform.tfstate" <<'EOF'
{"version":3,"terraform_version":"1.16.3","backend":{"type":"s3","config":{"bucket":"nip-tfstate-example","key":"probe.tfstate","region":"eu-north1","endpoints":{"s3":"https://127.0.0.1:9"},"skip_region_validation":true,"skip_credentials_validation":true,"skip_requesting_account_id":true},"hash":1}}
EOF
# No credentials anywhere, as in CI.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE AWS_SHARED_CREDENTIALS_FILE
export AWS_EC2_METADATA_DISABLED=true
out="$(make -s -f "${repo_root}/Makefile" -C "${work}" validate test TF_ROOTS=probe/ 2>&1)" \
  || { echo "${out}" >&2; fail "make validate test failed on a root holding a live backend pointer"; }
grep -q "1 passed, 0 failed" <<<"${out}" || { echo "${out}" >&2; fail "the probe test did not run"; }
grep -q '"type":"s3"' "${root}/.terraform/terraform.tfstate" || fail "the live backend pointer was modified"
ok "validate and test pass beside a live S3 backend pointer, and leave it untouched"
