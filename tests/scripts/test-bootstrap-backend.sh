#!/usr/bin/env bash
# scripts/bootstrap-backend.sh is sourced into shells without pipefail: a failed or empty CLI
# answer at any create/lookup step must stop it, never continue with an empty id.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# Every call after the step under test fails too, so no run here can reach the end and write a
# backend.hcl into the working tree.
stub nebius '
step="${STEP:-}"
case "$*" in
  "iam get-access-token"*) echo tok ;;
  "vpc subnet list"*) echo "{\"items\":[{\"metadata\":{\"id\":\"vpcsubnet-e00default\",\"name\":\"default-subnet-abc\"}}]}" ;;
  "storage bucket list"*)
    [[ "${step}" == bucket-list ]] && exit 1
    [[ "${step}" == bucket-create* ]] && { echo "{\"items\":[]}"; exit 0; }
    [[ "${step}" == labels-other ]] && { echo "{\"items\":[{\"metadata\":{\"id\":\"storagebucket-e00mock\",\"name\":\"tfstate-nip-sandbox-${BUCKET_HASH}\",\"labels\":{\"team\":\"ml\",\"cost-center\":\"r1\"}},\"spec\":{\"versioning_policy\":\"ENABLED\"}}]}"; exit 0; }
    [[ "${step}" == bucket-region ]] && { echo "{\"items\":[{\"metadata\":{\"id\":\"storagebucket-e00mock\",\"name\":\"tfstate-nip-sandbox-${BUCKET_HASH}\"},\"spec\":{\"versioning_policy\":\"ENABLED\"},\"status\":{\"region\":\"eu-west2\"}}]}"; exit 0; }
    echo "{\"items\":[{\"metadata\":{\"id\":\"storagebucket-e00mock\",\"name\":\"tfstate-nip-sandbox-${BUCKET_HASH}\"},\"spec\":{\"versioning_policy\":\"ENABLED\"}}]}" ;;
  "storage bucket create"*) [[ "${step}" == bucket-create-empty ]] && { echo "{}"; exit 0; }; exit 1 ;;
  "iam service-account get-by-name"*) [[ "${step}" == group-* || "${step}" == editors ]] && { echo "{\"metadata\":{\"id\":\"serviceaccount-e00mock\"}}"; exit 0; }; exit 1 ;;
  "iam group get-by-name"*) [[ "${step}" == editors-empty ]] && { echo "{}"; exit 0; }; exit 1 ;;
  "iam group create"*) [[ "${step}" == group-create-empty ]] && { echo "{}"; exit 0; }; exit 1 ;;
  "iam service-account create"*) [[ "${step}" == sa-create-empty ]] && { echo "{}"; exit 0; }; exit 1 ;;
  *) exit 1 ;;
esac'
hash="$(printf '%s' "tenant-e00mock-project-e00mock" | { md5sum 2>/dev/null || md5 -q; } | awk '{print $1}')"
run_bootstrap() { # <step> [scope] -> prints output, returns the function's status
  NIP_TARGETS_DIR="${work}/targets-${1}" NIP_BOOTSTRAP_NEW_STAGE=1 NIP_STATE_PERMIT_SCOPE="${2:-bucket}" STEP="$1" BUCKET_HASH="${hash:0:12}" NEBIUS_TENANT_ID=tenant-e00mock NEBIUS_PROJECT_ID=project-e00mock NEBIUS_REGION=eu-north1 \
    TF_VAR_subnet_id=vpcsubnet-e00mock bash -c 'set +o pipefail +e; source "$1/scripts/bootstrap-backend.sh" sandbox inference; echo "rc=$?"' _ "${repo_root}" 2>&1
}
for step in bucket-list bucket-create bucket-create-empty sa-create sa-create-empty group-create group-create-empty editors editors-empty; do
  test_name="bootstrap-${step}"
  scope=bucket; [[ "${step}" == editors* ]] && scope=tenant-editors
  out="$(run_bootstrap "${step}" "${scope}")"
  grep -q '^rc=1$' <<<"${out}" || fail "a failed ${step} must return 1: ${out}"
  grep -qE 'Created (state bucket|service account|project group)|Granted ' <<<"${out}" && fail "${step} failed but the script reported a create: ${out}"
  ok "stops"
done

# Soperator's upstream recipe takes its ids from its own .envrc (iam_tenant_id, iam_project_id,
# o11y_iam_tenant_id, o11y_profile, vpc_subnet_id, all required); the bootstrap replaces that .envrc,
# so it must export them, or `make soperator-plan` stops with "No value for required variable"
# (live plan, 2026-10-11). The run stops at the bucket step; the exports come before it.
test_name="bootstrap-soperator-recipe-vars"
out="$(NIP_TARGETS_DIR="${work}/targets-soperator" STEP=bucket-list BUCKET_HASH="${hash:0:12}" NEBIUS_TENANT_ID=tenant-e00mock NEBIUS_PROJECT_ID=project-e00mock NEBIUS_REGION=eu-north1 \
  bash -c 'set +o pipefail +e; unset TF_VAR_subnet_id TF_VAR_vpc_subnet_id; source "$1/scripts/bootstrap-backend.sh" sandbox soperator
  echo "tenant=${TF_VAR_iam_tenant_id:-} project=${TF_VAR_iam_project_id:-} o11y=${TF_VAR_o11y_iam_tenant_id:-} profile=${TF_VAR_o11y_profile-unset} subnet=${TF_VAR_vpc_subnet_id:-}"' _ "${repo_root}" 2>&1)"
grep -q 'tenant=tenant-e00mock project=project-e00mock o11y=tenant-e00mock profile= subnet=vpcsubnet-e00default' <<<"${out}" \
  || fail "soperator needs the recipe's TF_VARs from the bootstrap: ${out}"
ok "exports the recipe's ids"

# Wrong target (2026-10-11): an .env aimed at another project made the bootstrap create a second
# state bucket and identity there. A stage is bound to its first project and region; a new bucket
# needs NIP_BOOTSTRAP_NEW_STAGE=1; an existing bucket in another region is refused.
boot() { # <targets dir> <project> <step> [new-stage] -> output with rc
  NIP_TARGETS_DIR="$1" NIP_BOOTSTRAP_NEW_STAGE="${4:-}" STEP="$3" BUCKET_HASH="${hash:0:12}" NEBIUS_TENANT_ID=tenant-e00mock \
    NEBIUS_PROJECT_ID="$2" NEBIUS_REGION=eu-north1 TF_VAR_subnet_id=vpcsubnet-e00mock \
    bash -c 'set +o pipefail +e; source "$1/scripts/bootstrap-backend.sh" sandbox inference; echo "rc=$?"' _ "${repo_root}" 2>&1
}
test_name="bootstrap-new-bucket-needs-opt-in"
: > "${LOG}"
out="$(boot "${work}/t1" project-e00mock bucket-create)"
{ grep -q '^rc=1$' <<<"${out}" && grep -q 'NIP_BOOTSTRAP_NEW_STAGE=1' <<<"${out}"; } || fail "a missing bucket must stop without the opt-in: ${out}"
grep -q 'storage bucket create' "${LOG}" && fail "created a bucket without the opt-in"
[[ -e "${work}/t1/sandbox" ]] && fail "bound the stage although no bucket was found"
ok "refuses, creates nothing"

test_name="bootstrap-binds-stage-on-first-run"
out="$(boot "${work}/t2" project-e00mock sa-create)"
[[ "$(cat "${work}/t2/sandbox" 2>/dev/null)" == "project-e00mock eu-north1" ]] || fail "the stage was not bound after its bucket was found: ${out}"
ok "records project and region"

test_name="bootstrap-refuses-another-project"
: > "${LOG}"
out="$(boot "${work}/t2" project-e00other sa-create)"
{ grep -q '^rc=1$' <<<"${out}" && grep -q 'is bound to project-e00mock in eu-north1' <<<"${out}"; } || fail "a different project must be refused: ${out}"
grep -q '^nebius ' "${LOG}" && fail "the bound-target check must come before any cloud call: $(cat "${LOG}")"
ok "refuses before any cloud call"

test_name="bootstrap-refuses-bucket-in-another-region"
out="$(boot "${work}/t3" project-e00mock bucket-region)"
{ grep -q '^rc=1$' <<<"${out}" && grep -q 'is in eu-west2, but NEBIUS_REGION is eu-north1' <<<"${out}"; } || fail "a bucket in another region must be refused: ${out}"
[[ -e "${work}/t3/sandbox" ]] && fail "bound the stage to a mismatched region"
ok "refuses"

# #55 (live 2026-10-12): the foundation's own state bucket was created here without labels, so the portal listed
# tfstate-nip-foundation-… as "unattributed" (Terraform labels a stage's bucket once the foundation adopts it; the
# foundation's own bucket is never adopted). The bucket is labelled when it is created; an existing one without
# nip-* labels is named, with the command that labels it (the script itself changes nothing on an existing bucket).
test_name="bootstrap-labels-a-new-bucket"
: > "${LOG}"
run_bootstrap bucket-create-empty >/dev/null
grep -qE '^nebius storage bucket create .*--labels nip-owner=platform,nip-layer=foundation,nip-stage=sandbox( |$)' "${LOG}" \
  || fail "a new stage bucket must carry the foundation's labels"
ok "nip-owner, nip-layer, nip-stage"

test_name="bootstrap-labels-the-foundation-bucket"
: > "${LOG}"
NIP_TARGETS_DIR="${work}/targets-foundation" NIP_BOOTSTRAP_NEW_STAGE=1 STEP=bucket-create-empty BUCKET_HASH="${hash:0:12}" NEBIUS_TENANT_ID=tenant-e00mock \
  NEBIUS_PROJECT_ID=project-e00mock NEBIUS_REGION=eu-north1 bash -c 'set +o pipefail +e; source "$1/scripts/bootstrap-backend.sh" foundation foundation; echo "rc=$?"' _ "${repo_root}" >/dev/null 2>&1
grep -qE '^nebius storage bucket create .*--labels nip-owner=platform,nip-layer=foundation( |$)' "${LOG}" \
  || fail "the foundation's bucket must carry nip-owner and nip-layer (foundation is not a stage, so no nip-stage)"
ok "nip-owner, nip-layer"

test_name="bootstrap-names-an-unlabelled-bucket"
out="$(run_bootstrap sa-create)"
{ grep -q "has no nip-\* labels" <<<"${out}" && grep -q "nebius storage bucket update --id storagebucket-e00mock --labels nip-owner=platform,nip-layer=foundation,nip-stage=sandbox" <<<"${out}"; } \
  || fail "an existing bucket without nip-* labels must be named with the command that labels it: ${out}"
grep -q '^nebius storage bucket update' "${LOG}" && fail "the script must not change an existing bucket"
ok "says how to label it, changes nothing"

# --labels on an update may replace the bucket's whole label map; the printed command keeps the labels it already has.
test_name="bootstrap-label-command-keeps-other-labels"
: > "${LOG}"
out="$(run_bootstrap labels-other)"
{ grep -q "nebius storage bucket update --id storagebucket-e00mock --labels team=ml,cost-center=r1,nip-owner=platform,nip-layer=foundation,nip-stage=sandbox" <<<"${out}" \
  && grep -q "replaces all of the bucket's labels" <<<"${out}"; } \
  || fail "the label command must carry the bucket's existing labels and say why: ${out}"
grep -q '^nebius storage bucket update' "${LOG}" && fail "the script must not change an existing bucket"
ok "existing labels kept in the command"

# lab (platform/stages.yaml) is its own project and region: its first bootstrap creates its own bucket
# (opt-in), in uk-south1 with the region's only class, ENHANCED_THROUGHPUT (no Standard there:
# object-storage/storage-classes); a region with Standard gets no class flag (the API default).
# The stub refuses the create, so nothing is bound and no backend.hcl is written.
lab_boot() { # <region> <targets dir> -> output with rc
  NIP_TARGETS_DIR="$2" NIP_BOOTSTRAP_NEW_STAGE=1 STEP=bucket-create BUCKET_HASH="${hash:0:12}" NEBIUS_TENANT_ID=tenant-e00mock \
    NEBIUS_PROJECT_ID=project-e00lab NEBIUS_REGION="$1" \
    bash -c 'set +o pipefail +e; source "$1/scripts/bootstrap-backend.sh" lab network; echo "rc=$?"' _ "${repo_root}" 2>&1
}
test_name="bootstrap-lab-storage-class"
: > "${LOG}"
out="$(lab_boot uk-south1 "${work}/t4")"
grep -q '^rc=1$' <<<"${out}" || fail "the stubbed create fails, so the run stops: ${out}"
grep -q '^nebius storage bucket create --name tfstate-nip-lab-.* --versioning-policy enabled --default-storage-class ENHANCED_THROUGHPUT ' "${LOG}" \
  || fail "uk-south1 offers only ENHANCED_THROUGHPUT; the create must name it: $(cat "${LOG}")"
grep -qE '^nebius storage bucket create .*--labels nip-owner=platform,nip-layer=foundation,nip-stage=lab( |$)' "${LOG}" \
  || fail "the class flag must not displace the bucket's labels (#55): $(cat "${LOG}")"
[[ -e "${work}/t4/lab" ]] && fail "bound lab although its bucket was never created"
: > "${LOG}"
lab_boot eu-north1 "${work}/t5" >/dev/null
grep -q '^nebius storage bucket create ' "${LOG}" || fail "the create is attempted in eu-north1 too: $(cat "${LOG}")"
grep -q 'default-storage-class' "${LOG}" && fail "a region with Standard keeps the API default class: $(cat "${LOG}")"
ok "lab's state bucket uses the region's offered class"

# One project per stage, both ways: lab (a new project, nip-lab) is refused in a project already bound
# to another stage, before any cloud call; the foundation's own binding never counts as a stage's.
test_name="bootstrap-refuses-a-project-bound-to-another-stage"
mkdir -p "${work}/t6" && printf 'project-e00lab uk-south1\n' > "${work}/t6/sandbox"
: > "${LOG}"
out="$(lab_boot uk-south1 "${work}/t6")"
{ grep -q '^rc=1$' <<<"${out}" && grep -q 'project-e00lab is already bound to stage sandbox' <<<"${out}"; } || fail "lab in the sandbox's project must be refused: ${out}"
grep -q '^nebius ' "${LOG}" && fail "the check must come before any cloud call: $(cat "${LOG}")"
[[ -e "${work}/t6/lab" ]] && fail "bound lab to another stage's project"
mkdir -p "${work}/t7" && printf 'project-e00lab uk-south1\n' > "${work}/t7/foundation"
: > "${LOG}"
lab_boot uk-south1 "${work}/t7" >/dev/null
grep -q '^nebius storage bucket create ' "${LOG}" || fail "a foundation binding in the same project does not block a stage: $(cat "${LOG}")"
ok "refuses a project bound to another stage; foundation does not count"
