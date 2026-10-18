#!/usr/bin/env bash
# scripts/destroy-providers-override.sh: a destroy plan of a live root whose state holds a cluster
# AND in-cluster resources gets zz_destroy_override.tf pinning helm/kubernetes/kubectl to the
# endpoint in state (else they dial localhost); no cluster or no in-cluster resources: no file;
# a private-only cluster gets its private endpoint and a VPC note. `terraform` is a stub that prints
# a fixture `show -json`.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
script="${repo_root}/scripts/destroy-providers-override.sh"
stub terraform 'case "$*" in *"show -json"*) cat "${FIXTURE}" ;; *) exit 1 ;; esac'
root="${work}/live/sandbox/inference"; mkdir -p "${root}"
out="${root}/zz_destroy_override.tf"
# A rendered live root's providers (helm v3 attribute syntax + kubernetes + kubectl).
cat > "${root}/providers.tf" <<'EOF'
provider "nebius" {
  token = var.iam_token
}
provider "helm" {
  kubernetes = {
    host = module.stack.k8s_host
  }
}
provider "kubernetes" {
  host = module.stack.k8s_host
}
provider "kubectl" {
  host = module.stack.k8s_host
}
EOF
ca=$'-----BEGIN CERTIFICATE-----\nMIIBfakefakefakeQ0FURQ==\n-----END CERTIFICATE-----\n'
# fixture <public endpoint|""> <private endpoint> <public_endpoint_enabled output: true|false|none> <with k8s: 1|0> <with cluster: 1|0>
fixture() {
  jq -n --arg pub "$1" --arg priv "$2" --arg pe "$3" --argjson k8s "$4" --argjson cl "$5" --arg ca "${ca}" '
    {format_version: "1.0", values: {
      outputs: (if $pe == "none" then {} else {public_endpoint_enabled: {value: ($pe == "true"), sensitive: false}} end),
      root_module: {child_modules: [{address: "module.stack", resources: [], child_modules: (
        [ {address: "module.stack.module.network", resources: [{address: "module.stack.module.network.nebius_vpc_v1_subnet.this", mode: "managed", type: "nebius_vpc_v1_subnet", values: {}}]} ]
        + (if $cl == 1 then [{address: "module.stack.module.cluster", resources: [{
            address: "module.stack.module.cluster.nebius_mk8s_v1_cluster.this", mode: "managed", type: "nebius_mk8s_v1_cluster",
            values: {status: {control_plane: {
              endpoints: {public_endpoint: (if $pub == "" then null else $pub end), private_endpoint: $priv},
              auth: {cluster_ca_certificate: $ca}}}}}]}] else [] end)
        + (if $k8s == 1 then [{address: "module.stack.module.filestore_csi[0]", resources: [
            {address: "module.stack.module.filestore_csi[0].helm_release.csi", mode: "managed", type: "helm_release", values: {}},
            {address: "module.stack.module.filestore_csi[0].kubernetes_annotations.default_off", mode: "managed", type: "kubernetes_annotations", values: {}}]}] else [] end)
      )}]}}}' > "${work}/state.json"
  export FIXTURE="${work}/state.json"
}

test_name=override-written-for-cluster-with-k8s-resources
fixture "https://pu.mk8scluster-e00mock.invalid" "https://pr.mk8scluster-e00mock.invalid" true 1 1
"${script}" --dir "${root}" >/dev/null 2>"${work}/err" || fail "script failed: $(cat "${work}/err")"
[[ -f "${out}" ]] || fail "no ${out##*/} for a cluster with in-cluster resources"
perm=$(stat -c %a "${out}" 2>/dev/null || stat -f %Lp "${out}")
[[ "${perm}" == 600 ]] || fail "override must be mode 600 (got ${perm})"
[[ $(grep -c 'host *= "https://pu.mk8scluster-e00mock.invalid"' "${out}") -eq 3 ]] || fail "helm, kubernetes and kubectl must all point at the public endpoint"
grep -q 'pr.mk8scluster' "${out}" && fail "the public stack must not get the private endpoint"
[[ $(grep -c 'token *= var.iam_token' "${out}") -eq 3 ]] || fail "the token must stay var.iam_token"
[[ $(grep -c 'BEGIN CERTIFICATE' "${out}") -eq 3 ]] || fail "each provider block needs the CA inline"
grep -q '^  kubernetes = {' "${out}" || fail "helm keeps the root's attribute syntax (kubernetes = {...})"
grep -q 'locals' "${out}" && fail "override files cannot add locals"
grep -q '^terraform .*show -json' "${LOG}" || fail "the state must come from terraform show -json"
"${script}" --dir "${root}" --remove >/dev/null || fail "--remove failed"
[[ -f "${out}" ]] && fail "--remove must delete the file it wrote"
ok "cluster + helm/kubernetes resources: override with the public endpoint, mode 600, removed by --remove"

test_name=no-override-without-k8s-resources
fixture "https://pu.mk8scluster-e00mock.invalid" "https://pr.mk8scluster-e00mock.invalid" true 0 1
"${script}" --dir "${root}" >/dev/null 2>&1 || fail "script failed without in-cluster resources"
[[ -f "${out}" ]] && fail "no in-cluster resources: no override (nothing dials the cluster)"
ok "cluster without in-cluster resources: no file"

test_name=no-override-without-cluster
fixture "" "" none 1 0
"${script}" --dir "${root}" >/dev/null 2>&1 || fail "script failed without a cluster"
[[ -f "${out}" ]] && fail "no cluster in state: no override"
ok "no cluster in state: no file"

test_name=private-only-cluster-gets-private-host
fixture "" "https://pr.mk8scluster-e00mock.invalid" none 1 1
"${script}" --dir "${root}" >/dev/null 2>"${work}/err" || fail "script failed: $(cat "${work}/err")"
[[ $(grep -c 'host *= "https://pr.mk8scluster-e00mock.invalid"' "${out}") -eq 3 ]] || fail "a private-only cluster must get its private endpoint"
grep -q 'VPC' "${work}/err" || fail "the private endpoint needs a note that it is reachable only from the VPC"
ok "private-only cluster: private host plus a VPC note"

test_name=stale-override-removed-hand-written-kept
"${script}" --dir "${root}" >/dev/null 2>&1
fixture "" "" none 0 0
"${script}" --dir "${root}" >/dev/null 2>&1 || fail "script failed on an empty state"
[[ -f "${out}" ]] && fail "a stale generated override must be removed when the state no longer needs it"
echo '# hand-written' > "${out}"
"${script}" --dir "${root}" --remove >/dev/null 2>&1
[[ -f "${out}" ]] || fail "--remove must keep an override it did not write"
rm -f "${out}"
fixture "https://pu.mk8scluster-e00mock.invalid" "" false 1 1
if "${script}" --dir "${root}" >/dev/null 2>&1; then fail "public_endpoint_enabled=false with no private endpoint must refuse (no host)"; fi
[[ -f "${out}" ]] && fail "a refusal must not leave a file"
ok "stale file removed; a hand-written one kept; no endpoint in state refuses"
