#!/usr/bin/env bash
# .github/actions/nebius-stage-setup "Backend config, run labels" step: the R10 login key reaches
# Terraform only for the gpu-vm stack, never as a sudo user on every cluster node.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
script="${work}/labels.sh"
# The step's run: block, de-indented (the action is YAML; the block is plain bash).
awk '/- name: Backend config, run labels/{f=1} f && /run: \|/{r=1; next} r && /^    - name:/{exit} r' \
  "${repo_root}/.github/actions/nebius-stage-setup/action.yml" | sed 's/^        //' > "${script}"
grep -q 'TF_VAR_labels' "${script}" || fail "could not extract the labels step"
for stack in inference gpu-vm; do
  test_name="stage-setup-ssh-${stack}"
  env_file="${work}/env-${stack}"; out_file="${work}/out-${stack}"; : > "${env_file}"
  mkdir -p "${work}/repo/terraform/live/sandbox/${stack}"
  (cd "${work}/repo" && STAGE=sandbox STACK="${stack}" STATE_BUCKET=b RUN_LABEL=r TTL_HOURS=4 TTL_EXPIRES=2026-01-01T00:00:00Z \
    NEBIUS_REGION=eu-north1 NEBIUS_PROJECT_ID=project-e00mock GITHUB_ENV="${env_file}" GITHUB_OUTPUT="${out_file}" GITHUB_RUN_ID=1 \
    RUNNER_TEMP="${work}" NIP_SSH_PUBLIC_KEY="ssh-ed25519 AAAAmock" bash -euo pipefail "${script}" >/dev/null)
  if [[ "${stack}" == gpu-vm ]]; then
    grep -q '^TF_VAR_ssh_public_key=ssh-ed25519 AAAAmock$' "${env_file}" || fail "gpu-vm must get TF_VAR_ssh_public_key"
  else
    grep -q '^TF_VAR_ssh_public_key=' "${env_file}" && fail "${stack} must not get TF_VAR_ssh_public_key (it would add a NOPASSWD sudo user to every node)"
  fi
  ok "ssh key exported only where it belongs"
done
