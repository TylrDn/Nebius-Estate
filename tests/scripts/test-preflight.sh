#!/usr/bin/env bash
# scripts/preflight.py (make preflight): one go/no-go before `make plan`, chaining the key expiries
# (env-status), this plan's quota demand against quota-plan.py --json, the capacity advice for the GPU shape, the region/platform and
# spot-cap pairs (platform/regions.yaml), the stage caps and the TTL (platform/stages.yaml). Offline with
# the committed fixtures in tests/scripts/fixtures/preflight; every refusal is exercised once.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=scripts/lib-time.sh
source "${repo_root}/scripts/lib-time.sh"
unset TF_VAR_labels TF_VAR_region TF_VAR_gpu_preemptible TF_VAR_gpu_spot_pricing_policy_id NEBIUS_PROJECT_IDS NEBIUS_PROJECT_ID NEBIUS_TENANT_ID NEBIUS_IAM_TOKEN
stub nebius 'exit 1'   # offline: any CLI call is a test failure (checked below)
fx="${work}/fx"; cp -R "${repo_root}/tests/scripts/fixtures/preflight" "${fx}"
keys="${work}/ci-keys.yaml"
echo '  - { environment: sandbox-plan, what: "read-only state access key", expires: 2026-11-10, rotate: "runbooks/credential-rotation.md#rotating-the-ci-state-access-keys" }' > "${keys}"
export NIP_DOTENV="${work}/no.env" NIP_SECRETS_DIR="${work}/no-secrets" NIP_CI_KEYS="${keys}" NIP_NOW NEBIUS_REGION=eu-north1
NIP_NOW="$(nip_epoch 2026-10-12T00:00:00Z)"
pf() { python3 "${repo_root}/scripts/preflight.py" "$@"; }
pass() { local out; out="$(pf "$@" 2>&1)" || fail "preflight $* must pass: ${out}"; printf '%s' "${out}"; }
refused() { # <check> <pattern> <args...>: exit 1, a FAIL line for that check with the pattern
  local check="$1" pat="$2" out rc; shift 2
  set +e; out="$(pf "$@" 2>&1)"; rc=$?; set -e
  (( rc == 1 )) || fail "preflight $* must refuse (rc ${rc}): ${out}"
  grep -q "FAIL ${check}: .*${pat}" <<<"${out}" || fail "refusal for '$*' must be 'FAIL ${check}: ...${pat}': ${out}"
}

test_name=preflight-pass-offline-fixtures
out="$(pass --stage sandbox --stack inference --profile l40s-gpu-only --fixtures "${fx}")"
for c in keys region-platform spot-cap stage-caps ttl quota capacity; do
  grep -q "PASS ${c}:" <<<"${out}" || fail "check ${c} must pass: ${out}"
done
grep -q 'capacity: .*gpu-l40s-a 1gpu-8vcpu-32gb preemptible HIGH 7/8' <<<"${out}" || fail "the advice for the shape and offer is shown: ${out}"
grep -q 'Preflight sandbox/inference: GO' <<<"${out}" || fail "summary line: ${out}"
[[ -s "${LOG}" ]] && fail "offline must call nothing"
ok "the l40s-gpu-only profile passes every check from the fixtures"

test_name=preflight-offline-skips-cloud-checks
out="$(pass --stage sandbox --stack inference --profile l40s-gpu-only --offline)"
grep -q 'SKIP quota: offline' <<<"${out}" || fail "offline without fixtures skips quota, visibly: ${out}"
grep -q 'SKIP capacity: offline' <<<"${out}" || fail "offline without fixtures skips capacity, visibly: ${out}"
grep -q 'GO (offline: quota and capacity not checked)' <<<"${out}" || fail "an offline GO says what it did not check: ${out}"
ok "offline mode skips quota and capacity and says so"

test_name=preflight-key-expiry
NIP_NOW="$(nip_epoch 2026-10-30T00:00:00Z)"
out="$(pass --stage sandbox --stack inference --profile l40s-gpu-only --fixtures "${fx}")"
grep -q 'WARN keys: .*sandbox-plan .*expires 2026-11-10 (in 11 days)' <<<"${out}" || fail "a key within 14 days is a warning, not a refusal: ${out}"
NIP_NOW="$(nip_epoch 2026-11-11T00:00:00Z)"
refused keys 'sandbox-plan read-only state access key expired 2026-11-10' --stage sandbox --stack inference --profile l40s-gpu-only --fixtures "${fx}"
NIP_NOW="$(nip_epoch 2026-10-12T00:00:00Z)"
ok "a key near expiry warns; an expired key refuses"

test_name=preflight-region-platform
NEBIUS_REGION=eu-west2 refused region-platform 'gpu-h100-sxm is not offered in eu-west2' --stage sandbox --stack inference --set gpu_platform=gpu-h100-sxm --set 'labels={"nip-run":"x","nip-ttl-expires":"2026-10-12T03:00:00Z"}' --offline
NEBIUS_REGION=mars-1 refused region-platform 'region mars-1 is not in platform/regions.yaml' --stage sandbox --stack inference --offline --set 'labels={"nip-run":"x","nip-ttl-expires":"2026-10-12T03:00:00Z"}'
ok "a platform the region does not offer and an unknown region are refused"

test_name=preflight-spot-cap-pair
# 2026-10-11: the pricing-policy API refused a spot cap for gpu-l40s-a in eu-north1 (platform/regions.yaml spot_price_cap).
refused spot-cap 'no spot price cap for gpu-l40s-a in eu-north1' --stage sandbox --stack inference --profile l40s-gpu-only --set gpu_spot_pricing_policy_id=pricingpolicy-e00mock --offline
out="$(pass --stage sandbox --stack inference --set gpu_preemptible=true --set gpu_spot_pricing_policy_id=pricingpolicy-e00mock --set 'labels={"nip-run":"x","nip-ttl-expires":"2026-10-12T03:00:00Z"}' --offline)"
grep -q 'PASS spot-cap: gpu-h100-sxm in eu-north1 accepts a spot price cap' <<<"${out}" || fail "H100 in eu-north1 takes a cap: ${out}"
refused spot-cap 'no spot price cap for gpu-l40s-a in eu-north1' --stage sandbox --stack governance --set 'spot_price_caps={"gpu-l40s-a":"1.000"}' --set 'labels={"nip-run":"x","nip-ttl-expires":"2026-10-12T03:00:00Z"}' --offline
ok "spot caps only on the pairs the API accepts (inference policy id and governance caps)"

test_name=preflight-stage-caps
refused stage-caps 'gpu_node_count 3 exceeds the sandbox cap of 2 for inference' --stage sandbox --stack inference --profile l40s-gpu-only --set gpu_node_count=3 --offline
refused stage-caps 'staging does not allow preemptible GPU nodes' --stage staging --stack inference --set gpu_preemptible=true --offline
# Terraform precedence: staging.auto.tfvars sets gpu_preemptible = false, which wins over TF_VAR_gpu_preemptible.
out="$(TF_VAR_gpu_preemptible=true pf --stage staging --stack inference --offline 2>&1)" || fail "an auto.tfvars value wins over TF_VAR_*: ${out}"
ok "GPU count above the stage cap and preemptible nodes where the stage forbids them are refused"

test_name=preflight-ttl
refused ttl 'needs nip-run and nip-ttl-expires' --stage sandbox --stack inference --offline
refused ttl 'nip-ttl-expires 2026-10-11T00:00:00Z is not in the future' --stage sandbox --stack inference --set 'labels={"nip-run":"x","nip-ttl-expires":"2026-10-11T00:00:00Z"}' --offline
refused ttl 'more than 7 days ahead' --stage sandbox --stack inference --set 'labels={"nip-run":"x","nip-ttl-expires":"2026-10-30T00:00:00Z"}' --offline
out="$(pass --stage staging --stack inference --offline)"
grep -q 'PASS ttl: staging needs no TTL' <<<"${out}" || fail "staging requires no TTL: ${out}"
ok "a missing, past or too distant TTL is refused in sandbox"

test_name=preflight-lab-stage
# lab (platform/stages.yaml): CPU-only stacks in a second region, with the sandbox TTL rules.
NEBIUS_REGION=uk-south1 refused ttl 'lab needs nip-run and nip-ttl-expires' --stage lab --stack network --offline
out="$(NEBIUS_REGION=uk-south1 pass --stage lab --stack network --set 'labels={"nip-run":"x","nip-ttl-expires":"2026-10-12T03:00:00Z"}' --offline)"
grep -q 'PASS region-platform: uk-south1; network has no GPU shape' <<<"${out}" || fail "uk-south1 is a known region: ${out}"
grep -q 'Preflight lab/network: GO' <<<"${out}" || fail "summary: ${out}"
set +e; out="$(NEBIUS_REGION=uk-south1 pf --stage lab --stack inference --offline 2>&1)"; rc=$?; set -e
(( rc == 2 )) || fail "lab renders no inference root, so there is nothing to preflight (rc ${rc}): ${out}"
ok "lab/network needs a TTL like sandbox; lab has no GPU stack roots"

test_name=preflight-soperator
# The Soperator stage directory has stage.tfvars and no variables.tf; the recipe labels nothing, so a
# TTL stage gets a warning that names the safety net instead of a refusal it could never satisfy.
out="$(NEBIUS_REGION=uk-south1 pass --stage lab --stack soperator --offline)"
grep -q 'WARN ttl: lab needs a TTL, but the Soperator recipe sets no labels: .*make ttl-teardown STAGE=lab STACK=soperator' <<<"${out}" || fail "the TTL warning names the safety net: ${out}"
grep -q 'before make soperator-apply (it refuses until that job is running)' <<<"${out}" || fail "the warning says the TTL is armed before the apply, which enforces it: ${out}"
grep -q 'PASS stage-caps: soperator has no GPU nodes' <<<"${out}" || fail "no GPU shape: ${out}"
grep -q 'Preflight lab/soperator: GO (offline' <<<"${out}" || fail "summary: ${out}"
out="$(pass --stage staging --stack soperator --offline)"
grep -q 'PASS ttl: staging needs no TTL' <<<"${out}" || fail "a stage without a TTL rule passes: ${out}"
out="$(NEBIUS_REGION=uk-south1 pass --stage lab --stack soperator --fixtures "${fx}")"
grep -q 'SKIP quota' <<<"${out}" && fail "with fixtures the quota check runs for soperator, it is not skipped: ${out}"
grep -q 'WARN quota: not checked: soperator has no demand model' <<<"${out}" || fail "soperator's demand is not modelled: the quota line says so (a warning): ${out}"
ok "soperator preflights its stage directory: keys, region, quota (not modelled: a warning); the TTL is a warning"

test_name=preflight-quota-live-2026-10-12
# The live eu-north1 situation of 2026-10-12: project caps below the tenant (1 preemptible VM, 1 MK8s
# cluster, 1.5 TiB Network SSD, 0 GPU clusters, ...) and a tenant non-GPU vCPU limit of 0. The
# l40s-gpu-only plan needs none of what is missing: GO, every finding a warning.
cp "${repo_root}/tests/scripts/fixtures/preflight/quota-allowances-2026-10-12.json" "${fx}/quota-allowances.json"
out="$(pass --stage sandbox --stack inference --profile l40s-gpu-only --fixtures "${fx}")"
grep -q 'Preflight sandbox/inference: GO' <<<"${out}" || fail "the live 2026-10-12 situation is GO for the GPU-only plan: ${out}"
grep -q 'FAIL quota' <<<"${out}" && fail "no quota refusal: ${out}"
grep -q 'PASS quota: this plan fits in eu-north1: .*compute.instance.gpu.l40s 1 of 32.*compute.instance.preemptible.count 1 of 1 (project cap).*mk8s.cluster.count 1 of 1 (project cap)' <<<"${out}" \
  || fail "the PASS line states what was checked: ${out}"
grep -q 'WARN quota: .*compute.gpucluster.count: project cap 0, tenant 5 -> blocks this project (cap 0); intended?' <<<"${out}" || fail "a cap the plan does not need warns: ${out}"
grep -q 'WARN quota: .*compute.instance.non-gpu.vcpu eu-north1: tenant limit 0 -> request from Nebius' <<<"${out}" || fail "a tenant zero the plan does not need warns: ${out}"
grep -q 'WARN quota: .*compute.instance.non-gpu.vcpu: project cap 64, tenant 200' <<<"${out}" || fail "other regions' caps warn too: ${out}"
ok "2026-10-12 live quotas: the GPU-only plan is GO, the audit findings are warnings"

test_name=preflight-quota-gpu-only-vcpu-zero
jq '.allowances["tenant-e00mock"] |= map(if .metadata.name == "compute.instance.non-gpu.vcpu" then del(.spec.limit) else . end)' \
  "${repo_root}/tests/scripts/fixtures/preflight/quota-allowances.json" > "${fx}/quota-allowances.json"
out="$(pass --stage sandbox --stack inference --profile l40s-gpu-only --fixtures "${fx}")"
grep -q 'Preflight sandbox/inference: GO' <<<"${out}" || fail "0 CPU nodes needs no non-GPU vCPU: ${out}"
grep -q 'WARN quota: .*compute.instance.non-gpu.vcpu eu-north1: tenant limit 0' <<<"${out}" || fail "the zero is still reported, as a warning: ${out}"
refused quota 'compute.instance.non-gpu.vcpu eu-north1: this plan needs 16 (2 CPU node(s) x 8), limit 0 .*request from Nebius' \
  --stage sandbox --stack inference --profile l40s-gpu-only --set cpu_node_count=2 --fixtures "${fx}"
ok "tenant non-GPU vCPU 0: the GPU-only plan is GO, a plan with CPU nodes refuses naming the quota"

test_name=preflight-quota-preemptible-cap
cp "${repo_root}/tests/scripts/fixtures/preflight/quota-allowances-2026-10-12.json" "${fx}/quota-allowances.json"
refused quota 'compute.instance.preemptible.count eu-north1: this plan needs 2 (.*), limit 1 (project cap 1, tenant 8).*scripts/quota-plan.py --plan-align' \
  --stage sandbox --stack inference --profile l40s-gpu-only --set gpu_node_count=2 --fixtures "${fx}"
# Usage the allowance reports is subtracted: 8 of 8 in use leaves nothing for one more preemptible VM.
jq '.allowances["tenant-e00mock"] |= map(if .metadata.name == "compute.instance.preemptible.count" then .status.usage = "8" else . end)' \
  "${repo_root}/tests/scripts/fixtures/preflight/quota-allowances.json" > "${fx}/quota-allowances.json"
refused quota 'compute.instance.preemptible.count eu-north1: this plan needs 1 (.*), 0 free (tenant 8 of 8 in use)' \
  --stage sandbox --stack inference --profile l40s-gpu-only --fixtures "${fx}"
ok "preemptible demand above the project cap, or above what is free, refuses"

test_name=preflight-quota-mk8s-zero
jq '.allowances["tenant-e00mock"] |= map(if .metadata.name == "compute.disk.size.network-ssd" then del(.spec.limit) else . end)
  | .allowances["project-e00mock"] += [{"metadata":{"name":"mk8s.cluster.count","id":"quotaallowance-p9"},"spec":{"region":"eu-north1"},"status":{"unit":"count","state":"STATE_ACTIVE"}}]' \
  "${repo_root}/tests/scripts/fixtures/preflight/quota-allowances.json" > "${fx}/quota-allowances.json"
refused quota 'mk8s.cluster.count eu-north1: this plan needs 1 (.*), limit 0 (project cap 0, tenant 2).*--plan-align' --stage sandbox --stack inference --profile l40s-gpu-only --fixtures "${fx}"
refused quota 'compute.disk.size.network-ssd eu-north1: this plan needs 537 GiB (.*), limit 0 .*request from Nebius' --stage sandbox --stack inference --profile l40s-gpu-only --fixtures "${fx}"
ok "an MK8s project cap of 0 and a tenant Network SSD zero refuse the plan that needs them"

test_name=preflight-quota-not-checked
jq '.allowances["tenant-e00mock"] |= map(select(.metadata.name != "compute.instance.gpu.l40s"))' \
  "${repo_root}/tests/scripts/fixtures/preflight/quota-allowances.json" > "${fx}/quota-allowances.json"
out="$(pass --stage sandbox --stack inference --profile l40s-gpu-only --fixtures "${fx}")"
grep -q 'WARN quota: not checked: .*compute.instance.gpu.l40s (eu-north1: not listed by the quota service)' <<<"${out}" || fail "an unlisted quota is a warning, not checked: ${out}"
cp "${repo_root}/tests/scripts/fixtures/preflight/quota-allowances.json" "${fx}/"
out="$(pass --stage sandbox --stack ml-services --set 'labels={"nip-run":"x","nip-ttl-expires":"2026-10-12T03:00:00Z"}' --fixtures "${fx}")"
grep -q 'WARN quota: not checked: ml-services has no demand model' <<<"${out}" || fail "a stack without a demand model is not checked, a warning: ${out}"
ok "a quota the service does not list, or a stack without a demand model, warns 'not checked'"

test_name=preflight-capacity
jq '(.items[] | select(.spec.computeInstance.platform == "gpu-l40s-a") | .status.preemptible) |= (.availabilityLevel = "AVAILABILITY_LEVEL_LIMIT_REACHED" | .available = 0)' \
  "${repo_root}/tests/scripts/fixtures/preflight/resource-advice.json" > "${fx}/resource-advice.json"
refused capacity 'gpu-l40s-a 1gpu-8vcpu-32gb preemptible in eu-north1: LIMIT_REACHED' --stage sandbox --stack inference --profile l40s-gpu-only --fixtures "${fx}"
jq '.items |= map(select(.spec.computeInstance.platform != "gpu-l40s-a"))' "${repo_root}/tests/scripts/fixtures/preflight/resource-advice.json" > "${fx}/resource-advice.json"
out="$(pass --stage sandbox --stack inference --profile l40s-gpu-only --fixtures "${fx}")"
grep -q 'WARN capacity: no advice for gpu-l40s-a 1gpu-8vcpu-32gb in eu-north1' <<<"${out}" || fail "no advice row is unknown, a warning: ${out}"
jq '(.items[] | select(.spec.computeInstance.platform == "gpu-l40s-a") | .status) |= del(.preemptible)' \
  "${repo_root}/tests/scripts/fixtures/preflight/resource-advice.json" > "${fx}/resource-advice.json"
out="$(pass --stage sandbox --stack inference --profile l40s-gpu-only --fixtures "${fx}")"
grep -q 'WARN capacity: no preemptible advice for gpu-l40s-a 1gpu-8vcpu-32gb in eu-north1' <<<"${out}" || fail "a row without the offer's block is unknown, a warning: ${out}"
grep -q 'FAIL capacity' <<<"${out}" && fail "a missing offer block must not refuse: ${out}"
cp "${repo_root}/tests/scripts/fixtures/preflight/resource-advice.json" "${fx}/"
ok "LIMIT_REACHED for the shape and offer refuses; no advice, or none for the offer, warns"

test_name=preflight-capacity-zero-gpus
jq '(.items[] | select(.spec.computeInstance.platform == "gpu-l40s-a") | .status.preemptible) |= (.availabilityLevel = "AVAILABILITY_LEVEL_LIMIT_REACHED" | .available = 0)' \
  "${repo_root}/tests/scripts/fixtures/preflight/resource-advice.json" > "${fx}/resource-advice.json"
out="$(pass --stage sandbox --stack inference --profile l40s-gpu-only --set gpu_node_count=0 --fixtures "${fx}")"
grep -q 'SKIP capacity: no GPU nodes requested (gpu count 0)' <<<"${out}" || fail "0 GPU nodes needs no capacity, even at LIMIT_REACHED: ${out}"
grep -q 'Preflight sandbox/inference: GO' <<<"${out}" || fail "summary: ${out}"
grep -q 'Preflight sandbox/inference: GO (offline' <<<"${out}" && fail "a skip for 0 GPUs is not an offline skip: ${out}"
cp "${repo_root}/tests/scripts/fixtures/preflight/resource-advice.json" "${fx}/"
ok "0 GPU nodes: capacity skipped, not refused"

test_name=preflight-make-target
out="$(make -s -n -C "${repo_root}" preflight STAGE=sandbox STACK=inference PROFILE=l40s-gpu-only OFFLINE=1)"
grep -q 'scripts/preflight.py --stage sandbox --stack inference --profile l40s-gpu-only --offline' <<<"${out}" || fail "make preflight wiring: ${out}"
out="$(make -s -n -C "${repo_root}" preflight STAGE=sandbox STACK=inference FIXTURES=tests/scripts/fixtures/preflight)"
grep -q -- '--fixtures tests/scripts/fixtures/preflight' <<<"${out}" || fail "FIXTURES= passes through: ${out}"
ok "make preflight passes STAGE, STACK, PROFILE, OFFLINE and FIXTURES"
