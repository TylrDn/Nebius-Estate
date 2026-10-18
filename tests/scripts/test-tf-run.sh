#!/usr/bin/env bash
# scripts/tf-run.sh in CI (NIP_CI=1): both credential paths carry the token in TF_VAR_iam_token
# and no CLI profile exists, so the preflight checks the token and never calls nebius.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
test_name=tf-run-ci-key-path
stub terraform 'exit 0'
stub nebius 'echo "nebius must not be called in CI" >&2; exit 1'
mkdir -p "${work}/root"; : > "${work}/root/s.tfplan"
if NIP_CI=1 NIP_CI_FEDERATED=0 TF_VAR_iam_token="" "${repo_root}/scripts/tf-run.sh" "${work}/root" s.tfplan >/dev/null 2>"${work}/err"; then
  fail "the key path in CI must refuse an empty TF_VAR_iam_token"
fi
grep -q 'TF_VAR_iam_token' "${work}/err" || fail "the refusal must name TF_VAR_iam_token"
NIP_CI=1 NIP_CI_FEDERATED=0 TF_VAR_iam_token=tok "${repo_root}/scripts/tf-run.sh" "${work}/root" s.tfplan >/dev/null 2>&1 || fail "apply with a token must run"
grep -q '^nebius ' "${LOG}" && fail "the CI preflight must not use a CLI profile"
grep -q '^terraform .*apply' "${LOG}" || fail "terraform apply did not run"
ok "CI key path needs TF_VAR_iam_token, not a CLI profile"
