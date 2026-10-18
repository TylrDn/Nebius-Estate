#!/usr/bin/env bash
# scripts/wait-for-ofed.sh (training local-exec): the CLI authenticates with the token Terraform
# already has (TF_VAR_iam_token -> NEBIUS_IAM_TOKEN). The CLI refuses to run without a config file
# even when NEBIUS_IAM_TOKEN is set, so in CI (no profile) the script makes a throwaway one.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
stub nebius '
cfg=""; prev=""
for a in "$@"; do [[ "${prev}" == --config || "${prev}" == -c ]] && cfg="${a}"; prev="${a}"; done
echo "NEBIUS_IAM_TOKEN=${NEBIUS_IAM_TOKEN:-unset} config=${cfg:-none}" >> "$LOG"
case "$*" in
  *"profile create"*) [[ -n "${cfg}" ]] && echo "profiles: {}" > "${cfg}" ;;
  *"cluster get --id"*) [[ -n "${NEED_CONFIG:-}" && ( -z "${cfg}" || ! -f "${cfg}" ) ]] && { echo "Error: missing configuration" >&2; exit 1; }
                        echo "{\"status\":{\"control_plane\":{\"endpoints\":{\"public_endpoint\":\"https://k8s.invalid\"}}}}" ;;
  *"get-credentials"*) [[ -n "${NEED_CONFIG:-}" && ( -z "${cfg}" || ! -f "${cfg}" ) ]] && { echo "Error: missing configuration" >&2; exit 1; }; exit 0 ;;
esac'
stub kubectl 'echo "{\"items\":[{\"status\":{\"appliedStates\":[{\"name\":\"state-OFED\",\"state\":\"ready\"}]}}]}"'

test_name=wait-for-ofed-token-locally
env -u NEBIUS_IAM_TOKEN TF_VAR_iam_token=tok-ofed-sentinel "${repo_root}/scripts/wait-for-ofed.sh" mk8scluster-e00mock 5 >/dev/null 2>&1 || fail "wait-for-ofed.sh failed"
grep -q 'NEBIUS_IAM_TOKEN=unset' "${LOG}" && fail "nebius ran without NEBIUS_IAM_TOKEN"
grep -q 'NEBIUS_IAM_TOKEN=tok-ofed-sentinel' "${LOG}" || fail "nebius must get TF_VAR_iam_token as NEBIUS_IAM_TOKEN"
ok "the CLI uses the Terraform token"

test_name=wait-for-ofed-token-in-ci
: > "${LOG}"
env -u NEBIUS_IAM_TOKEN -u NEBIUS_PROFILE NIP_CI=1 NEED_CONFIG=1 TF_VAR_iam_token=tok-ofed-sentinel \
  "${repo_root}/scripts/wait-for-ofed.sh" mk8scluster-e00mock 5 >/dev/null 2>"${work}/err" || fail "wait-for-ofed.sh failed in CI mode: $(cat "${work}/err")"
grep '^nebius ' "${LOG}" | grep -q -- 'profile create .*--token-file' || fail "CI mode must create a throwaway profile that reads the token from a file"
grep -q 'tok-ofed-sentinel' <(grep '^nebius ' "${LOG}") && fail "the token appeared in nebius argv"
cfg="$(sed -n 's/.* config=\(.*\)$/\1/p' "${LOG}" | grep -v '^none$' | sort -u)"
[[ -n "${cfg}" && "$(wc -l <<<"${cfg}")" -eq 1 ]] || fail "every CI call must use one throwaway --config (got: ${cfg:-none})"
[[ ! -e "${cfg}" ]] || fail "the throwaway config must be deleted on exit"
ok "CI mode: throwaway config with a token file, removed afterwards"
