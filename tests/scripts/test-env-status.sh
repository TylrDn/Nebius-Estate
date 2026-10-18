#!/usr/bin/env bash
# scripts/env-status.sh (make env-status), offline part: the CI key expiries recorded in
# platform/ci-keys.yaml are reported, with a warning 14 days before an expiry that names the rotation
# runbook, and a failure once one has passed. NIP_DOTENV points away from the repository's .env, so
# the test never loads real credentials.
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=scripts/lib-time.sh
source "${repo_root}/scripts/lib-time.sh"
export NIP_DOTENV="${work}/no.env" NIP_SECRETS_DIR="${work}/no-secrets"
keys="${work}/ci-keys.yaml"
cat > "${keys}" <<'EOF'
keys:
  - { environment: sandbox-plan, secret: NIP_STATE_ACCESS_KEY_ID, what: "read-only state access key", expires: 2026-11-10, rotate: "runbooks/credential-rotation.md#rotating-the-ci-state-access-keys" }
  - { environment: staging, secret: NIP_SA_PRIVATE_KEY, what: "CI service-account key", expires: 2027-01-31, rotate: "runbooks/credential-rotation.md#rotating-the-ci-service-account-key" }
EOF
es() { NIP_CI_KEYS="${keys}" "${repo_root}/scripts/env-status.sh"; }

test_name=env-status-ci-key-far
out="$(NIP_NOW="$(nip_epoch 2026-10-12T00:00:00Z)" es 2>&1)" || fail "no key near expiry must pass: ${out}"
grep -q 'ok sandbox-plan .*expires 2026-11-10 (in 29 days)' <<<"${out}" || fail "a key 29 days out is ok: ${out}"
grep -q '!' <<<"$(sed -n '/^CI keys/,$p' <<<"${out}")" && fail "nothing is within 14 days: ${out}"
grep -q 'no .env yet' <<<"${out}" || fail "NIP_DOTENV must replace the repository .env: ${out}"
ok "keys more than 14 days out are reported ok"

test_name=env-status-ci-key-warns-14-days
out="$(NIP_NOW="$(nip_epoch 2026-10-27T00:00:00Z)" es 2>&1)" || fail "a warning must not fail env-status: ${out}"
grep -q '!  sandbox-plan read-only state access key expires 2026-11-10 (in 14 days): rotate before then (runbooks/credential-rotation.md#rotating-the-ci-state-access-keys)' <<<"${out}" \
  || fail "14 days before the expiry env-status warns and names the rotation: ${out}"
grep -q 'ok staging' <<<"${out}" || fail "the other key is still ok: ${out}"
out="$(NIP_NOW="$(nip_epoch 2026-10-26T23:59:59Z)" es 2>&1)"
grep -q 'ok sandbox-plan' <<<"${out}" || fail "just over 14 days out is not yet a warning: ${out}"
ok "warns from 14 days before an expiry, naming the runbook"

test_name=env-status-ci-key-expired
set +e; out="$(NIP_NOW="$(nip_epoch 2026-11-10T00:00:01Z)" es 2>&1)"; rc=$?; set -e
(( rc == 1 )) || fail "an expired CI key must fail env-status (rc ${rc}): ${out}"
grep -q '!  sandbox-plan read-only state access key expired 2026-11-10: rotate now' <<<"${out}" || fail "the expired key is named: ${out}"
ok "an expired key fails"

test_name=env-status-ci-keys-committed
out="$(NIP_NOW="$(nip_epoch 2026-10-12T00:00:00Z)" "${repo_root}/scripts/env-status.sh" 2>&1)" || fail "committed record: ${out}"
grep -qE '(ok|!)  ?sandbox-plan .*state access key expires 20[0-9]{2}-' <<<"${out}" || fail "platform/ci-keys.yaml records the sandbox-plan state key: ${out}"
grep -qE 'e00[a-z0-9]{6,}' "${repo_root}/platform/ci-keys.yaml" && fail "the record holds dates only, never ids"
ok "the committed record parses and holds no ids"

test_name=env-status-git-cannot-answer
mkdir -p "${work}/sec"
stub git 'exit 128'   # not a repository, or one owned by another user (the toolbox mount)
out="$(NIP_SECRETS_DIR="${work}/sec" NIP_NOW="$(nip_epoch 2026-10-12T00:00:00Z)" es 2>&1)" || fail "env-status failed: ${out}"
grep -q "could not check that ${work}/sec/ is git-ignored (git exited 128" <<<"${out}" || fail "a git error must be said as such: ${out}"
grep -q 'NOT git-ignored' <<<"${out}" && fail "a git error is not 'NOT git-ignored': ${out}"
stub git 'exit 1'
out="$(NIP_SECRETS_DIR="${work}/sec" NIP_NOW="$(nip_epoch 2026-10-12T00:00:00Z)" es 2>&1)" || fail "env-status failed: ${out}"
grep -q "WARNING: ${work}/sec/ is NOT git-ignored" <<<"${out}" || fail "a path git does not ignore is reported: ${out}"
ok "secrets dir: 'not ignored' and 'git cannot answer' are told apart"
