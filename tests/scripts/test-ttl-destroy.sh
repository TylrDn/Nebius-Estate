#!/usr/bin/env bash
# The sandbox TTL rule (modules/stage-policy ttl_window, asserted by each stack's
# terraform_data.stage_policy precondition) must block a normal plan once nip-ttl-expires has
# passed, and must NOT block the teardown of that same root: a destroy plan does not evaluate
# resource preconditions (Terraform 1.16; docs/upstream-findings.md 2026-10-11). `terraform test`
# cannot express this (plan_options.mode accepts only normal and refresh-only), so this runs the
# real terraform against local state, with the real module and stages.yaml copied into a temp
# tree. Builtin provider only: offline, no cloud. Skipped when terraform is not installed.
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
test_name=ttl-expired-blocks-plan-not-destroy
command -v terraform >/dev/null || { echo "skip ${test_name}: terraform not installed"; exit 0; }
mkdir -p "${work}/platform" "${work}/terraform/modules" "${work}/terraform/stacks/probe"
cp "${repo_root}"/platform/{stages,regions}.yaml "${work}/platform/"
cp -R "${repo_root}/terraform/modules/stage-policy" "${work}/terraform/modules/"
rm -rf "${work}/terraform/modules/stage-policy/.terraform"
root="${work}/terraform/stacks/probe"
# The stacks' own wiring (terraform/stacks/inference/main.tf), reduced to the TTL rule.
cat > "${root}/main.tf" <<'EOF'
variable "expired" {
  type = bool
}

module "stage_policy" {
  source                      = "../../modules/stage-policy"
  stage                       = "sandbox"
  stack                       = "inference"
  has_cluster                 = false
  has_public_endpoint_control = false
  ttl_expires                 = var.expired ? "2020-01-01T00:00:00Z" : timeadd(plantimestamp(), "24h")
}

resource "terraform_data" "stage_policy" {
  lifecycle {
    precondition {
      condition     = length(module.stage_policy.violations) == 0
      error_message = "stage sandbox policy (platform/stages.yaml): ${join("; ", module.stage_policy.violations)}."
    }
  }
}
EOF
tf() { terraform -chdir="${root}" "$@" -no-color >"${work}/out" 2>&1; }
tf init -input=false || fail "init: $(cat "${work}/out")"
tf apply -input=false -auto-approve -var expired=false || fail "apply inside the TTL window: $(cat "${work}/out")"
if tf plan -input=false -var expired=true; then fail "a normal plan with an expired TTL must fail (the rule is live)"; fi
grep -q 'nip-ttl-expires' "${work}/out" || fail "the refusal must name nip-ttl-expires: $(cat "${work}/out")"
tf plan -destroy -input=false -var expired=true -out=destroy.tfplan || fail "destroy plan with an expired TTL failed: $(cat "${work}/out")"
grep -q '1 to destroy' "${work}/out" || fail "destroy plan should remove the resource: $(cat "${work}/out")"
tf apply -input=false destroy.tfplan || fail "applying the destroy plan failed: $(cat "${work}/out")"
ok "expired TTL: normal plan refused, destroy plan and its apply succeed ($(terraform version | head -n 1))"
