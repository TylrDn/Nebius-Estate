#!/usr/bin/env bash
# Run 2 step 4: R8 acceptance. The fio baseline is step 3's results/03-storage-fio.json (no rerun).
# Restore drill: read the data outputs with the bootstrap's STATE key first, then give the R8 WRITE
# key (docs/credentials.md#object-storage-access-key-for-r8), read at silent prompts, to the drill
# only: never exported, unset after.
# Executed: bash run2-4-r8-acceptance.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init run2-4-r8-acceptance
header "Run 2 step 4 - R8 acceptance (baseline + checkpoint restore drill)" \
  "terraform outputs checkpoint_bucket/s3_endpoint; tests/validate/checkpoint-restore.sh with the R8 write key passed inline" \
  "\$0 extra (a few bytes written and removed)" "about 1-2 min" "the RESULT block (fio baseline figures, drill status)"
# `aws` runs in a container (bin/aws: amazon/aws-cli pinned by digest); nothing is installed on the host.
export PATH="${LIVE_DIR}/bin:${PATH}"
need terraform jq aws nebius docker
need_tty
check_repo
load_env
require_2d
[[ -f results/03-storage-fio.json && -f results/03-storage.json ]] || die "no step-3 storage results: run run2-3c-storage-workload.sh first"

boot data
CKPT_BUCKET="$(terraform -chdir=terraform/live/sandbox/data output -raw checkpoint_bucket)"
S3_ENDPOINT="$(terraform -chdir=terraform/live/sandbox/data output -raw s3_endpoint)"
[[ -n "${CKPT_BUCKET}" && -n "${S3_ENDPOINT}" ]] || die "empty checkpoint_bucket or s3_endpoint output"
say "CKPT_BUCKET=${CKPT_BUCKET} S3_ENDPOINT=${S3_ENDPOINT}"

# The drill needs a key that may write the checkpoint bucket. By default this step makes one that
# exists only for the drill: a service account, a group with storage.object-editor on THIS bucket
# only, and a 2 h key; the key goes straight into the drill (never printed, never typed), and all
# four are deleted afterwards, also on failure (subshell EXIT trap). R8_KEY_MANUAL=1: paste a key.
rc=0
if [[ "${R8_KEY_MANUAL:-0}" == 1 ]]; then
  read -rs -p "R8 write key: access key id (input hidden): " R8_KEY_ID; echo
  read -rs -p "R8 write key: secret (input hidden): " R8_SECRET; echo
  [[ -n "${R8_KEY_ID}" && -n "${R8_SECRET}" ]] || die "empty R8 key"
  [[ "${R8_KEY_ID}" != "${AWS_ACCESS_KEY_ID}" ]] || die "that is the Terraform state key, not the R8 write key"
  say ">>> AWS_ACCESS_KEY_ID=<R8> AWS_SECRET_ACCESS_KEY=<R8> CKPT_BUCKET=... S3_ENDPOINT=... tests/validate/checkpoint-restore.sh"
  AWS_ACCESS_KEY_ID="${R8_KEY_ID}" AWS_SECRET_ACCESS_KEY="${R8_SECRET}" CKPT_BUCKET="${CKPT_BUCKET}" S3_ENDPOINT="${S3_ENDPOINT}" \
    tests/validate/checkpoint-restore.sh || rc=$?
  unset R8_KEY_ID R8_SECRET
else
  (
    set -euo pipefail
    N=(nebius --profile "${NEBIUS_PROFILE}")
    P="${NEBIUS_PROJECT_ID}"
    name="nip-sandbox-ckpt-drill"
    sa="" grp="" permit="" member="" kid=""
    # shellcheck disable=SC2329  # run by the EXIT trap below
    r8_cleanup() {
      local ok=1
      [[ -n "${kid}" ]]    && { "${N[@]}" iam v2 access-key delete --id "${kid}" >/dev/null 2>&1 || ok=0; }
      [[ -n "${permit}" ]] && { "${N[@]}" iam access-permit delete --id "${permit}" >/dev/null 2>&1 || ok=0; }
      [[ -n "${member}" ]] && { "${N[@]}" iam group-membership delete --id "${member}" >/dev/null 2>&1 || ok=0; }
      [[ -n "${grp}" ]]    && { "${N[@]}" iam group delete --id "${grp}" >/dev/null 2>&1 || ok=0; }
      [[ -n "${sa}" ]]     && { "${N[@]}" iam service-account delete --id "${sa}" >/dev/null 2>&1 || ok=0; }
      if (( ok )); then say "  drill identity removed (key, permit, membership, group, service account)"
      else say "  CLEANUP INCOMPLETE: delete by hand in project ${P}: service account and group '${name}', its access key and permit"; fi
    }
    trap r8_cleanup EXIT
    # Refuse to reuse leftovers of an earlier attempt: names must be free.
    if "${N[@]}" iam service-account get-by-name --parent-id "${P}" --name "${name}" >/dev/null 2>&1 \
       || "${N[@]}" iam group get-by-name --parent-id "${P}" --name "${name}" >/dev/null 2>&1; then
      die "'${name}' already exists in the sandbox project (an earlier attempt?): delete it, then rerun"
    fi
    bucket_id="$("${N[@]}" storage bucket get-by-name --parent-id "${P}" --name "${CKPT_BUCKET}" --format json | jq -er .metadata.id)"
    say ">>> creating the drill identity '${name}' (storage.object-editor on ${CKPT_BUCKET} only, 2 h key)"
    sa="$("${N[@]}" iam service-account create --parent-id "${P}" --name "${name}" --format json | jq -er .metadata.id)"
    grp="$("${N[@]}" iam group create --parent-id "${P}" --name "${name}" --format json | jq -er .metadata.id)"
    permit="$("${N[@]}" iam access-permit create --parent-id "${grp}" --resource-id "${bucket_id}" --role storage.object-editor --format json | jq -er .metadata.id)"
    member="$("${N[@]}" iam group-membership create --parent-id "${grp}" --member-id "${sa}" --format json | jq -er .metadata.id)"
    exp="$(TZ=UTC date -v+2H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)"
    kid="$("${N[@]}" iam v2 access-key create --parent-id "${P}" --account-service-account-id "${sa}" \
      --name "${name}-drill-$(TZ=UTC date +%Y%m%d%H%M%S)" --description "R8 restore drill (deleted after the drill)" \
      --expires-at "${exp}" --format json | jq -er .metadata.id)"
    key="$("${N[@]}" iam v2 access-key get --id "${kid}" --format json)"
    # Permits can take a moment to apply; the drill's first call is a read of the bucket's versioning.
    sleep 15
    say ">>> AWS_ACCESS_KEY_ID=<drill> AWS_SECRET_ACCESS_KEY=<drill> CKPT_BUCKET=... S3_ENDPOINT=... tests/validate/checkpoint-restore.sh"
    AWS_ACCESS_KEY_ID="$(jq -r .status.aws_access_key_id <<<"${key}")" \
    AWS_SECRET_ACCESS_KEY="$(jq -r .status.secret <<<"${key}")" \
    CKPT_BUCKET="${CKPT_BUCKET}" S3_ENDPOINT="${S3_ENDPOINT}" tests/validate/checkpoint-restore.sh
  ) || rc=$?
fi

result_begin
jq -r '"  fio baseline (03-storage, \(.status)): write=\(.details.write_MiBps) read=\(.details.read_MiBps) MiB/s, \(.details.numjobs) jobs, bar=\(.details.min_MiBps)"' results/03-storage.json
say "  baseline file: results/03-storage-fio.json"
say "  checkpoint-restore exit ${rc}"
jq -c '{status, details}' results/checkpoint-restore.json 2>/dev/null || say "  results/checkpoint-restore.json missing"
say "evidence: docs/evidence/<date>-sandbox-data-acceptance.md"
(( rc == 0 )) || exit "${rc}"
say "next: bash ${LIVE_DIR}/run2-5-r12-acceptance.sh"
