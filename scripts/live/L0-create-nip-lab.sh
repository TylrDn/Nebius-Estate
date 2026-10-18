#!/usr/bin/env bash
# L0: create the dedicated project for the `lab` stage (run 4: R7, R4). Free; IAM only.
#   L0-create-nip-lab.sh [--region uk-south1] [--name nip-lab]            dry run: shows whether it exists
#   L0-create-nip-lab.sh [--region uk-south1] [--name nip-lab] --apply    creates it (refuses if one of that name exists)
# Then reads, without changing anything, its non-GPU vCPU allowance and that it is empty. The region
# defaults to the lab stage's, uk-south1 (platform/stages.yaml lab; a project's region is fixed at
# creation: iam/manage-projects); another must be one of platform/regions.yaml. Labels nip-owner=platform,
# nip-env=lab. Uses `nebius iam v2 project` (the docs' command; `iam project` is deprecated, removed
# 2026-12-16 per the CLI). The tenant and the CLI profile come from .env (NEBIUS_TENANT_ID, NEBIUS_PROFILE).
# Paste back: everything from "=== RESULT" down (the ids it prints stay out of git).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
apply=0 name=nip-lab region=uk-south1
while (( $# )); do
  case "$1" in
    --apply) apply=1; shift ;;
    --name) name="${2:-}"; shift 2 ;;
    --region) region="${2:-}"; shift 2 ;;
    *) die "usage: $0 [--region <region>] [--name <project name>] [--apply]" ;;
  esac
done
if ! [[ "${region}" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || ! grep -qE "^  ${region}:" "${REPO}/platform/regions.yaml"; then die "--region '${region}' is not a region of platform/regions.yaml (the lab stage's is uk-south1)"; fi
[[ "${name}" =~ ^nip-[a-z0-9-]+$ ]] || die "the project name must follow docs/naming.md (nip-...)"
need nebius jq
cd "${REPO}"
TENANT="$(env_get NEBIUS_TENANT_ID)"; PROFILE_NAME="${NEBIUS_PROFILE:-$(env_get NEBIUS_PROFILE)}"
[[ -n "${TENANT}" ]] || die "NEBIUS_TENANT_ID is empty in .env"
N=(nebius); [[ -n "${PROFILE_NAME}" ]] && N+=(--profile "${PROFILE_NAME}")
find_project() {
  "${N[@]}" iam v2 project list --parent-id "${TENANT}" --all --format json \
    | jq -r --arg n "${name}" '(.items // [])[] | select(.metadata.name == $n) | "\(.metadata.id) \(.spec.region // .status.region // "?")"'
}
existing="$(find_project 2>/dev/null || true)"
say "existing ${name}: ${existing:-none}"
if (( apply )) && [[ -z "${existing}" ]]; then
  "${N[@]}" iam v2 project create --parent-id "${TENANT}" --name "${name}" --region "${region}" \
    --labels nip-owner=platform,nip-env=lab --format json | jq -r '"created: \(.metadata.id)"'
  existing="$(find_project)"
elif (( ! apply )); then
  say "dry run: would create ${name} in ${region} (labels nip-owner=platform, nip-env=lab). Re-run with --apply."
fi
[[ -n "${existing}" ]] || exit 0
pid="${existing%% *}"
say "=== RESULT"
say "${name}: ${existing}"
say "--- non-GPU vCPU allowances (tenant + this project, ${region})"
"${N[@]}" quotas quota-allowance list --parent-id "${TENANT}" --all --format json \
  | jq -r --arg r "${region}" '.items[] | select(.metadata.name=="compute.instance.non-gpu.vcpu" and .spec.region==$r) | "tenant  limit=\(.spec.limit // 0)"'
"${N[@]}" quotas quota-allowance list --parent-id "${pid}" --all --format json 2>/dev/null \
  | jq -r '.items[] | select(.metadata.name|test("non-gpu.vcpu|instance.count|filesystem|disk.ssd|public|mk8s")) | "project \(.metadata.name) limit=\(.spec.limit // 0) region=\(.spec.region)"' | sort | head -20
say "--- contents (expect none)"
"${N[@]}" compute instance list --parent-id "${pid}" --all --format json 2>/dev/null | jq -r '"instances: \(.items | length)"'
"${N[@]}" storage bucket list --parent-id "${pid}" --all --format json 2>/dev/null | jq -r '"buckets: \(.items | length)"'
