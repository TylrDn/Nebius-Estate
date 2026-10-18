#!/usr/bin/env bash
# scripts/fetch-soperator.sh: the checked-out recipe must be the commit pinned in
# platform/versions.yaml (upstream.nebius-solutions-library.ref), not merely the tag name.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
pinned="$(awk '/nebius-solutions-library:/{f=1} f && /ref:/{gsub(/"/,"",$2); print $2; exit}' "${repo_root}/platform/versions.yaml")"
[[ "${pinned}" =~ ^[0-9a-f]{40}$ ]] || fail "could not read the pinned ref"
export NIP_SOPERATOR_DEST="${work}/upstream" OVERRIDES_DIR="${repo_root}/terraform/stacks/soperator/overrides/modules"
stub git '
case "$*" in
  clone*) d="${@: -1}"; mkdir -p "${d}/.git" "${d}/soperator/installations/example"; echo 4.1.13 > "${d}/soperator/VERSION"; echo "test license" > "${d}/LICENSE"
          for m in "${OVERRIDES_DIR}"/*/; do mkdir -p "${d}/soperator/modules/$(basename "${m}")"; done ;;
  *"rev-parse HEAD"*) echo "${FAKE_HEAD}" ;;
  *"describe"*) echo soperator-v4.1.13-2 ;;
esac'
test_name=fetch-soperator-refuses-moved-tag
set +e; FAKE_HEAD=0000000000000000000000000000000000000000 "${repo_root}/scripts/fetch-soperator.sh" --no-backend >/dev/null 2>"${work}/err"; rc=$?; set -e
[[ "${rc}" -ne 0 ]] || fail "a checkout at another commit must fail"
grep -q "${pinned}" "${work}/err" || fail "the error must name the pinned commit: $(cat "${work}/err")"
[[ ! -e "${NIP_SOPERATOR_DEST}" ]] || fail "a mismatched checkout must be removed, not reused"
ok "refused"
test_name=fetch-soperator-accepts-pinned-commit
FAKE_HEAD="${pinned}" "${repo_root}/scripts/fetch-soperator.sh" --no-backend >/dev/null 2>"${work}/err" || fail "the pinned commit must be accepted: $(cat "${work}/err")"
ok "accepted"
