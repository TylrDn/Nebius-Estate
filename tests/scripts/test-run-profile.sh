#!/usr/bin/env bash
# Committed run profiles (platform/profiles/<stack>/<name>.json) replace the git-ignored zz-run
# overrides of the 2026-10-11 sandbox runs: scripts/run-profile.py renders a profile's inputs plus
# generated nip-run / nip-ttl-expires labels, and `make plan PROFILE=<name>` passes the rendered file
# as -var-file. The rendered tfvars must equal the inputs the evidence runs used.
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
unset TF_VAR_labels NEBIUS_REGION TF_VAR_region RUN TTL_HOURS PROFILE
rp() { python3 "${repo_root}/scripts/run-profile.py" "$@"; }

test_name=run-profile-l40s-gpu-only-matches-evidence
# docs/evidence/2026-10-11-sandbox-inference-{populate,serving,teardown-verify}.md: gpu-l40s-a /
# 1gpu-8vcpu-32gb x 1, preemptible, cpu_node_count = 0, 64 GiB shared filesystem, a 3 h TTL.
out="$(rp --stage sandbox --stack inference --profile l40s-gpu-only --run portal-populate-2026-10-11 --now 2026-10-11T07:44:28Z)" \
  || fail "render failed: ${out}"
want='{
  "cpu_node_count": 0,
  "enable_filestore": true,
  "enable_o11y": true,
  "filestore_size_gib": 64,
  "gpu_node_count": 1,
  "gpu_platform": "gpu-l40s-a",
  "gpu_preemptible": true,
  "gpu_preset": "1gpu-8vcpu-32gb",
  "labels": {
    "nip-owner": "platform",
    "nip-run": "portal-populate-2026-10-11",
    "nip-ttl-expires": "2026-10-11T10:44:28Z"
  }
}'
[[ "${out}" == "${want}" ]] || fail "rendered tfvars differ from the evidence runs' inputs:
${out}"
ok "l40s-gpu-only renders the evidence runs' inputs and a 3 h TTL"

test_name=run-profile-defaults-and-overrides
out="$(TZ=Asia/Kolkata rp --stage sandbox --stack inference --profile l40s-gpu-only --now 2026-10-11T23:30:00Z --ttl-hours 2)"
jq -e '.labels["nip-ttl-expires"] == "2026-10-12T01:30:00Z"' <<<"${out}" >/dev/null || fail "--ttl-hours 2 from the UTC now: ${out}"
jq -e '.labels["nip-run"] == "l40s-gpu-only-202610112330"' <<<"${out}" >/dev/null || fail "default nip-run is <profile>-<UTC yyyymmddhhmm>: ${out}"
out="$(TF_VAR_labels='{"nip-owner":"team-a","nip-cost-center":"cc1","nip-run":"old"}' rp --stage sandbox --stack inference --profile l40s-gpu-only --run r1 --now 2026-10-11T07:44:28Z)"
jq -e '.labels == {"nip-owner":"team-a","nip-cost-center":"cc1","nip-run":"r1","nip-ttl-expires":"2026-10-11T10:44:28Z"}' <<<"${out}" >/dev/null \
  || fail "TF_VAR_labels is kept (a -var-file would otherwise replace it); the profile sets run and TTL: ${out}"
dst="${work}/out.json"
rp --stage sandbox --stack inference --profile l40s-gpu-only --run r1 --now 2026-10-11T07:44:28Z --out "${dst}" >/dev/null
jq -e '.gpu_platform == "gpu-l40s-a"' "${dst}" >/dev/null || fail "--out writes the file"
ok "TTL hours, default run name, TF_VAR_labels merge and --out"

test_name=run-profile-refusals
refused() { # <pattern> <args...>
  local pat="$1" out rc; shift
  set +e; out="$(rp "$@" 2>&1)"; rc=$?; set -e
  (( rc != 0 )) || fail "must refuse: $*: ${out}"
  grep -q -- "${pat}" <<<"${out}" || fail "refusal for '$*' must say '${pat}': ${out}"
}
refused 'no profile nope for stack inference (have: .*l40s-gpu-only' --stage sandbox --stack inference --profile nope
refused 'is for stages sandbox, not staging' --stage staging --stack inference --profile l40s-gpu-only
refused 'ttl-hours must be 1-24' --stage sandbox --stack inference --profile l40s-gpu-only --ttl-hours 25
NEBIUS_REGION=eu-west2 refused 'profile l40s-gpu-only needs region eu-north1, but NEBIUS_REGION is eu-west2' --stage sandbox --stack inference --profile l40s-gpu-only
ok "unknown profile, wrong stage, TTL out of range and region mismatch are refused"

test_name=run-profile-make-wiring
mk() { make -s -n -C "${repo_root}" "$@"; }
out="$(mk plan STAGE=sandbox STACK=inference PROFILE=l40s-gpu-only RUN=r1 TTL_HOURS=2)"
grep -q 'scripts/run-profile.py --stage sandbox --stack inference --profile l40s-gpu-only --run r1 --ttl-hours 2 --out terraform/live/sandbox/inference/.run-profile.tfvars.json' <<<"${out}" \
  || fail "make plan PROFILE= renders the profile first: ${out}"
grep -q 'plan -input=false .*-var-file=.run-profile.tfvars.json .*-out=sandbox-inference.tfplan' <<<"${out}" || fail "make plan passes the rendered file: ${out}"
out="$(mk plan STAGE=sandbox STACK=inference)"
grep -q 'run-profile' <<<"${out}" && fail "without PROFILE nothing is rendered or passed: ${out}"
out="$(mk destroy-plan STAGE=sandbox STACK=inference PROFILE=l40s-gpu-only)"
grep -q 'plan -destroy .*-var-file=.run-profile.tfvars.json' <<<"${out}" || fail "destroy-plan reuses the rendered profile: ${out}"
ok "make plan / destroy-plan render and pass the profile"

test_name=run-profile-every-profile-is-valid
for f in "${repo_root}"/platform/profiles/*/*.json; do
  stack="$(basename "$(dirname "${f}")")" name="$(basename "${f}" .json)"
  jq -e --arg s "${stack}" '.stack == $s and (.stages | length > 0) and (.evidence | length > 0) and (.vars | type == "object")' "${f}" >/dev/null \
    || fail "${f}: needs stack, stages, evidence and vars"
  for stage in $(jq -r '.stages[]' "${f}"); do
    vars="${repo_root}/terraform/live/${stage}/${stack}/variables.tf"
    [[ -f "${vars}" ]] || fail "${f}: no live root ${stage}/${stack}"
    rp --stage "${stage}" --stack "${stack}" --profile "${name}" --run x --now 2026-10-11T00:00:00Z >/dev/null 2>&1 || fail "${f} does not render for ${stage}"
    for v in $(jq -r '.vars | keys[]' "${f}"); do
      grep -q "^variable \"${v}\"" "${vars}" || fail "${f}: ${v} is not a variable of ${stage}/${stack}"
    done
  done
  for e in $(jq -r '.evidence[]' "${f}"); do [[ -f "${repo_root}/${e}" ]] || fail "${f}: evidence ${e} missing"; done
done
ok "every committed profile names its evidence and only declared variables"
