#!/usr/bin/env bash
# scripts/leftovers.sh lists every billable kind the stacks create (R12 MLflow/PostgreSQL and
# registry, R15 NVL instance groups, disks that are not CSI pvc-*), lists ALL disks with --stage,
# and still stops (exit 2) when a listing fails.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
stub nebius '
item() { echo "{\"metadata\":{\"id\":\"$1\",\"name\":\"$2\",\"labels\":$3}}"; }
lab="{\"nip-stack\":\"ml-services\",\"nip-stage\":\"sandbox\"}"
lab_nvl="{\"nip-stack\":\"nvl\",\"nip-stage\":\"sandbox\"}"
lab_vm="{\"nip-stack\":\"gpu-vm\",\"nip-stage\":\"sandbox\"}"
[[ -n "${FAIL_ON:-}" && "$*" == "${FAIL_ON}"* ]] && exit 1
case "$*" in
  "msp mlflow v1alpha1 cluster list"*)    echo "{\"items\":[$(item mlflowcluster-e00a mlflow-a "${lab}")]}" ;;
  "msp postgresql v1alpha1 cluster list"*) echo "{\"items\":[$(item postgresqlcluster-e00a pg-a "${lab}")]}" ;;
  "registry list"*)                        echo "{\"items\":[$(item registry-e00a registry-a "${lab}")]}" ;;
  "compute nvl-instance-group list"*)      echo "{\"items\":[$(item nvlinstancegroup-e00a nvl-rack-a "${lab_nvl}")]}" ;;
  "compute disk list"*) echo "{\"items\":[$(item computedisk-e00a pvc-abc null),$(item computedisk-e00b gpu-vm-boot "${lab_vm}"),$(item computedisk-e00c orphan-data null)]}" ;;
  *" list "*) echo "{\"items\":[]}" ;;
  *) exit 1 ;;
esac'
export NEBIUS_PROJECT_ID=project-e00mock

test_name=leftovers-kinds
out="$("${repo_root}/scripts/leftovers.sh" 2>&1)" || fail "leftovers.sh failed: ${out}"
for name in mlflow-a pg-a registry-a nvl-rack-a gpu-vm-boot pvc-abc; do
  grep -q " ${name} " <<<"${out} " || fail "missing ${name} in: ${out}"
done
grep -q orphan-data <<<"${out}" && fail "an unlabelled non-pvc disk belongs to no stack: listed only with --stage"
[[ "$(grep -c 'pvc-abc' <<<"${out}")" -eq 1 ]] || fail "pvc-abc listed more than once"
ok "MLflow, PostgreSQL, registry, NVL groups and labelled disks are listed"

test_name=leftovers-stage-all-disks
out="$("${repo_root}/scripts/leftovers.sh" --stage sandbox 2>&1)" || fail "leftovers.sh --stage failed: ${out}"
for name in orphan-data pvc-abc gpu-vm-boot; do grep -q " ${name} " <<<"${out} " || fail "--stage must list every disk; missing ${name}"; done
[[ "$(grep -c 'pvc-abc' <<<"${out}")" -eq 1 ]] || fail "pvc-abc listed more than once with --stage"
ok "--stage lists every disk once"

test_name=leftovers-fail-loud
for kind in "msp postgresql v1alpha1 cluster" "compute nvl-instance-group" "registry"; do
  set +e; FAIL_ON="${kind} list" "${repo_root}/scripts/leftovers.sh" >/dev/null 2>&1; rc=$?; set -e
  [[ "${rc}" -eq 2 ]] || fail "a failed '${kind} list' must stop the check with exit 2 (got ${rc})"
done
ok "a failed listing still stops the check"

# The MLflow API keeps no labels (live apply 2026-10-11), so a stack-scoped check must still list
# every MLflow cluster in the project, unlabelled, like GPU clusters; once, also with --stage.
stub nebius '
case "$*" in
  "msp mlflow v1alpha1 cluster list"*) echo "{\"items\":[{\"metadata\":{\"id\":\"mlflowcluster-e00u\",\"name\":\"nip-sandbox-mlflow\",\"labels\":null}}]}" ;;
  *" list "*) echo "{\"items\":[]}" ;;
  *) exit 1 ;;
esac'
test_name=leftovers-unlabelled-mlflow
out="$("${repo_root}/scripts/leftovers.sh" --stack ml-services 2>&1)" || fail "leftovers.sh failed: ${out}"
grep -q " nip-sandbox-mlflow" <<<"${out}" || fail "an unlabelled MLflow cluster must be listed for --stack: ${out}"
out="$("${repo_root}/scripts/leftovers.sh" --stage sandbox 2>&1)" || fail "leftovers.sh --stage failed: ${out}"
[[ "$(grep -c 'nip-sandbox-mlflow' <<<"${out}")" -eq 1 ]] || fail "listed once with --stage: ${out}"
ok "unlabelled MLflow clusters are listed"

# `msp postgresql v1alpha1 cluster list` answers {"clusters": [...]}, not {"items": [...]} (CLI, live
# 2026-10-11): reading only .items hid a running PostgreSQL cluster from the residue check.
stub nebius '
case "$*" in
  "msp postgresql v1alpha1 cluster list"*) echo "{\"clusters\":[{\"metadata\":{\"id\":\"postgresql-e00c\",\"name\":\"nip-sandbox-pg\",\"labels\":{\"nip-stack\":\"ml-services\",\"nip-stage\":\"sandbox\"}}}]}" ;;
  *" list "*) echo "{\"items\":[]}" ;;
  *) exit 1 ;;
esac'
test_name=leftovers-postgresql-clusters-key
for args in "--stack ml-services" "--stage sandbox"; do
  # shellcheck disable=SC2086  # two words on purpose
  out="$("${repo_root}/scripts/leftovers.sh" ${args} 2>&1)" || fail "leftovers.sh ${args} failed: ${out}"
  grep -q " nip-sandbox-pg " <<<"${out} " || fail "PostgreSQL cluster under .clusters must be listed (${args}): ${out}"
done
ok "PostgreSQL clusters listed from the .clusters key"

# R9 pricing policies keep no labels either (live apply 2026-10-11): listed by their -spot-gpu- name
# for a stack-scoped check, once with --stage.
stub nebius '
case "$*" in
  "billing v1 pricing-policy list"*) echo "{\"items\":[{\"metadata\":{\"id\":\"pricingpolicy-e00u\",\"name\":\"nip-sandbox-spot-gpu-h100-sxm\",\"labels\":null}}]}" ;;
  *" list "*) echo "{\"items\":[]}" ;;
  *) exit 1 ;;
esac'
test_name=leftovers-unlabelled-pricing-policy
out="$("${repo_root}/scripts/leftovers.sh" --stack governance 2>&1)" || fail "leftovers.sh failed: ${out}"
grep -q " nip-sandbox-spot-gpu-h100-sxm" <<<"${out}" || fail "an unlabelled pricing policy must be listed for --stack: ${out}"
out="$("${repo_root}/scripts/leftovers.sh" --stage sandbox 2>&1)" || fail "leftovers.sh --stage failed: ${out}"
[[ "$(grep -c 'nip-sandbox-spot-gpu-h100-sxm' <<<"${out}")" -eq 1 ]] || fail "listed once with --stage: ${out}"
ok "unlabelled pricing policies are listed"
