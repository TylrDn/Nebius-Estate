#!/usr/bin/env bash
# workloads/training/install-training-operator.sh installs the commit pinned in
# platform/versions.yaml (workloads.kubeflow-training-operator.ref), not a movable tag.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
test_name=training-operator-pinned-commit
pinned="$(grep 'kubeflow-training-operator:' "${repo_root}/platform/versions.yaml" | grep -oE 'ref: "[0-9a-f]{40}"' | grep -oE '[0-9a-f]{40}')" \
  || fail "platform/versions.yaml pins no commit (ref) for kubeflow-training-operator"
stub kubectl 'exit 0'
"${repo_root}/workloads/training/install-training-operator.sh" >/dev/null 2>&1 || fail "install script failed"
grep '^kubectl apply' "${LOG}" | grep -q "ref=${pinned}" || fail "kubectl apply must use ?ref=<pinned commit>: $(grep '^kubectl apply' "${LOG}")"
ok "applies the pinned commit"
