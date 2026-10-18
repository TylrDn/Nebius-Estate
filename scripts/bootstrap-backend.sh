#!/usr/bin/env bash
# Bootstrap remote Terraform state in Nebius Object Storage for one live root
# (terraform/live/<stage>/<stack>, ADR-0009), the way nebius-solutions-library/k8s-training/
# environment.sh does it:
#
#   1. IAM token from the Nebius CLI            -> TF_VAR_iam_token
#   2. Versioned Object Storage bucket           -> backend.hcl (bucket/key/endpoint)
#   3. Service account scoped to that bucket + 1-day key -> AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
#
# Usage:  source scripts/bootstrap-backend.sh [stage] [stack]   (default: sandbox inference)
#         First bootstrap of a stage (creates its bucket): NIP_BOOTSTRAP_NEW_STAGE=1. It binds the stage
#         to NEBIUS_PROJECT_ID / NEBIUS_REGION in .nip-targets/<stage> (git-ignored); later runs refuse others.
#         stage: sandbox | staging | prod | lab | foundation (lab: CPU-only, its own project and region; platform/stages.yaml);  stack: network | data | inference | training | gpu-vm | ml-services | governance | soperator
#         NEBIUS_PROJECT_ID must be the STAGE's project (one project per stage, ADR-0009).
# Needs:  NEBIUS_TENANT_ID, NEBIUS_PROJECT_ID, NEBIUS_REGION; nebius CLI (NEBIUS_PROFILE honoured); jq;
#         admin on the project for the group and permit (the default scope never touches tenant-level
#         IAM); the docs list tenant admin as the prerequisite for creating access keys
#         (iam/service-accounts/access-keys), so a project-only admin may be refused at step 3
#
# Order does not matter. After terraform/live/foundation is applied, this script finds the
# per-stage bucket, group and service account by name and reuses them. Run before the foundation,
# it creates them and prints an `adopt_bootstrap` entry; the foundation then imports them instead
# of failing on the name clash. NIP_NAME_PREFIX (default nip) must match the foundation's
# name_prefix input, or the names will not line up.
#
# Nothing secret is written to disk: backend.hcl holds only bucket/key/endpoint
# and is git-ignored anyway. Credentials live in this shell's environment and
# the access key expires after one day (ADR-0005, docs/security.md).

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "Run with: source ${0} [stage] [stack]  (it must export variables into your shell)" >&2
  exit 1
fi

_nip_bootstrap() {
  local stage="${1:-sandbox}" stack="${2:-inference}"
  local prefix="${NIP_NAME_PREFIX:-nip}"
  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  local tf_dir
  if [[ "${stage}" == "foundation" ]]; then
    stack="foundation"; tf_dir="${repo_root}/terraform/live/foundation"
  else
    tf_dir="${repo_root}/terraform/live/${stage}/${stack}"
  fi
  if [[ ! -d "${tf_dir}" ]]; then
    echo "Unknown live root '${stage}/${stack}': ${tf_dir} does not exist (stages: sandbox|staging|prod|lab|foundation; stacks: network|data|inference|training|gpu-vm|ml-services|governance|soperator)" >&2
    return 1
  fi

  # shellcheck source=scripts/lib-nebius.sh
  source "${repo_root}/scripts/lib-nebius.sh"

  local v
  for v in NEBIUS_TENANT_ID NEBIUS_PROJECT_ID NEBIUS_REGION; do
    if [[ -z "${!v:-}" ]]; then
      echo "Error: ${v} is not set (export the stage project's ids first: runbooks/deploy.md prerequisites)" >&2
      return 1
    fi
  done
  for v in nebius jq; do
    command -v "${v}" >/dev/null || { echo "Error: '${v}' not found in PATH" >&2; return 1; }
  done

  # A stage lives in one project and region (ADR-0009). The first bootstrap of a stage records them
  # in a git-ignored file (real ids are never committed); later runs refuse any other target, before
  # any cloud call. Without this, an .env aimed at another project silently created a second state
  # bucket and identity there (2026-10-11).
  local targets_dir="${NIP_TARGETS_DIR:-${repo_root}/.nip-targets}" bound_project="" bound_region=""
  if [[ -f "${targets_dir}/${stage}" ]]; then
    read -r bound_project bound_region < "${targets_dir}/${stage}"
    if [[ "${bound_project}" != "${NEBIUS_PROJECT_ID}" || "${bound_region}" != "${NEBIUS_REGION}" ]]; then
      echo "Error: stage ${stage} is bound to ${bound_project} in ${bound_region} (${targets_dir}/${stage}, written by its first bootstrap)," >&2
      echo "  but NEBIUS_PROJECT_ID / NEBIUS_REGION are ${NEBIUS_PROJECT_ID} in ${NEBIUS_REGION}. Export the stage's project and region." >&2
      echo "  If the stage really moved, delete that file; its old state stays in the old project's bucket." >&2
      return 1
    fi
  fi
  # One project per stage, both ways: a project already bound to another stage is refused too, so a
  # new stage (lab) can never be bound to the sandbox's project, or any other stage's, by mistake.
  # foundation is not a stage: its own state bucket may sit in a stage's project.
  local other other_project
  for other in "${targets_dir}"/*; do
    [[ "${stage}" != foundation && -f "${other}" ]] || continue
    [[ "$(basename "${other}")" != "${stage}" && "$(basename "${other}")" != foundation ]] || continue
    read -r other_project _ < "${other}"
    if [[ "${other_project}" == "${NEBIUS_PROJECT_ID}" ]]; then
      echo "Error: ${NEBIUS_PROJECT_ID} is already bound to stage $(basename "${other}") (${other}); stage ${stage} needs its own project (ADR-0009)." >&2
      echo "  Create or select the stage's own project (lab: a new project named nip-lab) and export it as NEBIUS_PROJECT_ID." >&2
      return 1
    fi
  done

  # 1. IAM token for the nebius/helm/kubernetes providers.
  unset NEBIUS_IAM_TOKEN
  NEBIUS_IAM_TOKEN="$(nip_nebius iam get-access-token)" || return 1
  export NEBIUS_IAM_TOKEN
  export TF_VAR_iam_token="${NEBIUS_IAM_TOKEN}"
  export TF_VAR_parent_id="${NEBIUS_PROJECT_ID}"
  export TF_VAR_region="${NEBIUS_REGION}"
  # Clusters (and R12's managed services) need a subnet. A project's default subnet is named default-subnet-<suffix>, so it cannot be
  # looked up by a fixed name; find the one the VPC marks status.default (an explicit TF_VAR_subnet_id,
  # e.g. R7's subnet_id output, always wins).
  if [[ "${stack}" == inference || "${stack}" == training || "${stack}" == ml-services || "${stack}" == soperator ]] && [[ -z "${TF_VAR_subnet_id:-}" ]]; then
    local default_subnet
    default_subnet="$(nip_nebius vpc subnet list --parent-id "${NEBIUS_PROJECT_ID}" --format json \
      | jq -r '[.items[]?] as $s
               | ([$s[] | select(.status.default == true)][0]                    # newer CLIs report the flag
                  // [$s[] | select(.metadata.name | startswith("default-subnet"))][0]  # older ones drop it
                  // (if ($s | length) == 1 then $s[0] else null end)) | .metadata.id // empty')" || return 1
    if [[ -n "${default_subnet}" ]]; then
      export TF_VAR_subnet_id="${default_subnet}"
    else
      echo "Warning: no default subnet in ${NEBIUS_PROJECT_ID}; set TF_VAR_subnet_id (R7 output subnet_id)" >&2
    fi
  fi
  # Soperator's upstream recipe reads these from its example .envrc, which this script replaces
  # (docs/soperator-compatibility.md); all five are required variables there. profiles/lab.tfvars
  # turns public o11y off, so o11y_profile may be empty and o11y_iam_tenant_id is the stage's tenant.
  if [[ "${stack}" == soperator ]]; then
    export TF_VAR_iam_tenant_id="${NEBIUS_TENANT_ID}" TF_VAR_iam_project_id="${NEBIUS_PROJECT_ID}"
    export TF_VAR_o11y_iam_tenant_id="${TF_VAR_o11y_iam_tenant_id:-${NEBIUS_TENANT_ID}}" TF_VAR_o11y_profile="${TF_VAR_o11y_profile:-}"
    export TF_VAR_vpc_subnet_id="${TF_VAR_vpc_subnet_id:-${TF_VAR_subnet_id:-}}"
  fi

  # 2. One versioned bucket per stage (= per project); one state key per stack (ADR-0005, ADR-0009).
  #    Same naming as terraform/modules/foundation/state-bucket, so a foundation-created bucket
  #    is found and reused here.
  local hash bucket
  if command -v md5sum >/dev/null; then
    hash="$(printf '%s' "${NEBIUS_TENANT_ID}-${NEBIUS_PROJECT_ID}" | md5sum | awk '{print $1}')"
  else # macOS
    hash="$(printf '%s' "${NEBIUS_TENANT_ID}-${NEBIUS_PROJECT_ID}" | md5 -q)"
  fi
  [[ ${#hash} -eq 32 ]] || { echo "Error: could not compute bucket name hash" >&2; return 1; }
  bucket="tfstate-${prefix}-${stage}-${hash:0:12}"
  # The labels terraform/live/foundation puts on a stage's state bucket once it adopts it (docs/naming.md); the
  # foundation's own bucket is never adopted, so it is labelled here or never (#55). foundation is not a stage.
  local bucket_labels="nip-owner=platform,nip-layer=foundation"
  [[ "${stage}" != foundation ]] && bucket_labels="${bucket_labels},nip-stage=${stage}"

  # This script is sourced, so the caller's shell may not have pipefail: every CLI answer below is
  # captured first (a failed call returns), then parsed, and an empty id stops the run.
  local out existing
  out="$(nip_nebius storage bucket list --parent-id "${NEBIUS_PROJECT_ID}" --all --format json)" \
    || { echo "Error: could not list buckets in ${NEBIUS_PROJECT_ID}" >&2; return 1; }
  existing="$(jq -c --arg b "${bucket}" 'try .items[] | select(.metadata.name == $b)' <<<"${out}")" || return 1
  local bucket_id
  if [[ -z "${existing}" ]]; then
    # A stage's state bucket is created once. Creating one because the target is wrong would split
    # the stage's state across projects, so a new bucket needs an explicit opt-in.
    if [[ "${NIP_BOOTSTRAP_NEW_STAGE:-}" != 1 ]]; then
      echo "Error: no state bucket ${bucket} in ${NEBIUS_PROJECT_ID} (${NEBIUS_REGION})." >&2
      echo "  First bootstrap of stage ${stage} in this project: rerun with NIP_BOOTSTRAP_NEW_STAGE=1." >&2
      echo "  Otherwise NEBIUS_PROJECT_ID / NEBIUS_REGION point at the wrong project (one project per stage, ADR-0009)." >&2
      return 1
    fi
    # Regions without the Standard class (platform/regions.yaml object_storage_classes, e.g. uk-south1)
    # get their first offered class explicitly, the way the data stack does (object-storage/storage-classes).
    local class_args=() region_classes
    region_classes="$(awk -v r="  ${NEBIUS_REGION}:" '$0 == r {on = 1; next} on && /^  [a-z]/ {exit} on && /^    object_storage_classes:/ {print; exit}' \
      "${repo_root}/platform/regions.yaml" | sed -E 's/.*\[([A-Z_]+).*/\1/')"
    [[ -n "${region_classes}" ]] && class_args=(--default-storage-class "${region_classes}")
    out="$(nip_nebius storage bucket create --name "${bucket}" --parent-id "${NEBIUS_PROJECT_ID}" \
      --versioning-policy enabled ${class_args[@]+"${class_args[@]}"} --labels "${bucket_labels}" --format json)" || { echo "Error: could not create bucket ${bucket}" >&2; return 1; }
    bucket_id="$(jq -r '.metadata.id // empty' <<<"${out}")"
    [[ -n "${bucket_id}" ]] || { echo "Error: bucket create returned no id for ${bucket}" >&2; return 1; }
    echo "Created state bucket ${bucket} (${bucket_id}, versioning enabled)"
  else
    bucket_id="$(jq -r '.metadata.id // empty' <<<"${existing}")"
    [[ -n "${bucket_id}" ]] || { echo "Error: bucket ${bucket} has no id in the listing" >&2; return 1; }
    # ADR-0005 relies on object versions for state recovery: refuse a bucket whose
    # versioning was switched off after creation.
    local versioning
    versioning="$(jq -r '.spec.versioning_policy // .spec.versioningPolicy // "UNKNOWN"' <<<"${existing}")"
    if [[ "${versioning}" != "ENABLED" ]]; then
      echo "Error: bucket ${bucket} has versioning_policy=${versioning}; re-enable it with" >&2
      echo "  nebius storage bucket update --id $(jq -r '.metadata.id' <<<"${existing}") --versioning-policy enabled" >&2
      return 1
    fi
    local bucket_region
    bucket_region="$(jq -r '.status.region // empty' <<<"${existing}")"
    if [[ -n "${bucket_region}" && "${bucket_region}" != "${NEBIUS_REGION}" ]]; then
      echo "Error: state bucket ${bucket} is in ${bucket_region}, but NEBIUS_REGION is ${NEBIUS_REGION}: export the stage's region" >&2
      return 1
    fi
    echo "Using state bucket ${bucket} (versioning enabled)"
    # An existing bucket is not changed here; one without nip-* labels reads "unattributed" in the portal (#55).
    if [[ -z "$(jq -r '[(.metadata.labels // {}) | keys[] | select(startswith("nip-"))] | first // empty' <<<"${existing}")" ]]; then
      # --labels on an update may replace the whole label map (the documented additive --labels-add is not
      # documented for storage buckets), so the command repeats the labels the bucket already has.
      local kept all_labels
      kept="$(jq -r '(.metadata.labels // {}) | to_entries | map("\(.key)=\(.value)") | join(",")' <<<"${existing}")"
      all_labels="${kept:+${kept},}${bucket_labels}"
      echo "Note: state bucket ${bucket} has no nip-* labels (created before the bootstrap labelled it). To label it:"
      # Quoted for the shell only when a label value needs it.
      local sq="'\\''"
      [[ "${all_labels}" =~ ^[A-Za-z0-9_.,=/:-]*$ ]] || all_labels="'${all_labels//\'/${sq}}'"
      echo "  nebius storage bucket update --id ${bucket_id} --labels ${all_labels}"
      if [[ -n "${kept}" ]]; then
        echo "  (--labels replaces all of the bucket's labels, so the command repeats the ones it has: ${kept})"
      fi
    fi
  fi
  if [[ ! -f "${targets_dir}/${stage}" ]]; then
    mkdir -p "${targets_dir}" && printf '%s %s\n' "${NEBIUS_PROJECT_ID}" "${NEBIUS_REGION}" > "${targets_dir}/${stage}" \
      && echo "Stage ${stage} bound to ${NEBIUS_PROJECT_ID} in ${NEBIUS_REGION} (${targets_dir}/${stage})"
  fi

  # 3. State identity (ADR-0005). Default: a service account whose only grant is
  #    storage.object-editor on the state bucket, through a custom group created in
  #    the project (project admin is enough; no tenant-level IAM write). Overrides:
  #      NIP_STATE_SA_ID         reuse an existing service account
  #      NIP_STATE_GROUP_ID      reuse an existing group (skips group create + permit)
  #      NIP_STATE_PERMIT_SCOPE  bucket (default) | project | tenant-editors
  #    tenant-editors reproduces the upstream environment.sh behaviour for tenants
  #    that allow it; project grants storage.object-editor on every bucket in the
  #    project (explicit opt-in, never a silent fallback).
  local scope="${NIP_STATE_PERMIT_SCOPE:-bucket}"
  case "${scope}" in bucket|project|tenant-editors) ;; *) echo "Error: NIP_STATE_PERMIT_SCOPE must be bucket, project or tenant-editors" >&2; return 1;; esac

  local sa_name="${prefix}-tfstate-${stage}" sa_id="${NIP_STATE_SA_ID:-}"
  if [[ -z "${sa_id}" ]]; then
    sa_id="$(nip_nebius iam service-account get-by-name --parent-id "${NEBIUS_PROJECT_ID}" \
      --name "${sa_name}" --format json 2>/dev/null | jq -r '.metadata.id // empty')"
  fi
  if [[ -z "${sa_id}" ]]; then
    out="$(nip_nebius iam service-account create --parent-id "${NEBIUS_PROJECT_ID}" \
      --name "${sa_name}" --format json)" || { echo "Error: could not create service account ${sa_name}" >&2; return 1; }
    sa_id="$(jq -r '.metadata.id // empty' <<<"${out}")"
    [[ -n "${sa_id}" ]] || { echo "Error: service-account create returned no id for ${sa_name}" >&2; return 1; }
    echo "Created service account ${sa_name} (${sa_id})"
  fi

  local group_id="${NIP_STATE_GROUP_ID:-}"
  if [[ "${scope}" == "tenant-editors" ]]; then
    out="$(nip_nebius iam group get-by-name --parent-id "${NEBIUS_TENANT_ID}" --name editors --format json)" \
      || { echo "Error: could not read the tenant editors group" >&2; return 1; }
    group_id="$(jq -r '.metadata.id // empty' <<<"${out}")"
    [[ -n "${group_id}" ]] || { echo "Error: the tenant editors group has no id" >&2; return 1; }
  elif [[ -z "${group_id}" ]]; then
    local group_name="${prefix}-tfstate-${stage}"
    group_id="$(nip_nebius iam group get-by-name --parent-id "${NEBIUS_PROJECT_ID}" --name "${group_name}" \
      --format json 2>/dev/null | jq -r '.metadata.id // empty')"
    if [[ -z "${group_id}" ]]; then
      out="$(nip_nebius iam group create --parent-id "${NEBIUS_PROJECT_ID}" --name "${group_name}" --format json)" \
        || { echo "Error: could not create group ${group_name}" >&2; return 1; }
      group_id="$(jq -r '.metadata.id // empty' <<<"${out}")"
      [[ -n "${group_id}" ]] || { echo "Error: group create returned no id for ${group_name}" >&2; return 1; }
      echo "Created project group ${group_name} (${group_id})"
    fi
    # One permit, scoped to the bucket; the project is the fallback when the API refuses
    # a bucket-scoped permit (then narrow it with a bucket policy, ADR-0005).
    local role="storage.object-editor" resource_id="${bucket_id}"
    [[ "${scope}" == "project" ]] && resource_id="${NEBIUS_PROJECT_ID}"
    local have_permit
    have_permit="$(nip_nebius iam access-permit list --parent-id "${group_id}" --all --format json \
      | jq -r --arg r "${resource_id}" --arg role "${role}" '.items[]? | select(.spec.resource_id == $r and .spec.role == $role) | .metadata.id' | head -1)"
    if [[ -z "${have_permit}" ]]; then
      if ! nip_nebius iam access-permit create --parent-id "${group_id}" --resource-id "${resource_id}" --role "${role}" >/dev/null; then
        # Never widen silently: a refused bucket-scoped permit stops here. The caller may
        # opt into NIP_STATE_PERMIT_SCOPE=project (object-editor on every bucket in the
        # project; ADR-0005 records that blast radius) or ask an admin for the permit.
        echo "Error: could not grant ${role} on ${resource_id} to group ${group_id} (scope=${scope})." >&2
        [[ "${scope}" == "bucket" ]] && echo "  If this tenant refuses bucket-scoped permits, rerun with NIP_STATE_PERMIT_SCOPE=project after reading ADR-0005 'project scope'." >&2
        return 1
      fi
      echo "Granted ${role} on ${resource_id} to ${group_name}"
    fi
  fi

  local membership_id
  membership_id="$(nip_nebius iam group-membership list-members --parent-id "${group_id}" --page-size 1000 \
    --format json | jq -r --arg s "${sa_id}" '.memberships[]? | select(.spec.member_id == $s) | .metadata.id')"
  if [[ -z "${membership_id}" ]]; then
    out="$(nip_nebius iam group-membership create --parent-id "${group_id}" --member-id "${sa_id}" --format json)" || return 1
    membership_id="$(jq -r '.metadata.id // .resource_id // empty' <<<"${out}")"
    echo "Added ${sa_name} to group ${group_id}"
  fi

  local expires
  if [[ "$(uname)" == "Darwin" ]]; then
    expires="$(date -u -v +1d '+%Y-%m-%dT%H:%M:%SZ')"
  else
    expires="$(date -u -d '+1 day' '+%Y-%m-%dT%H:%M:%SZ')"
  fi
  # This script is sourced, so the caller's shell may not have pipefail: capture
  # each CLI response first and require every field to be non-empty.
  local created key_id key_json
  # Key names: <identity>-<consumer>-<UTC yyyymmddhhmmss> (docs/naming.md); the consumer is the stack.
  # Seconds, because two bootstraps in one minute (destroy-plan then destroy) collide on the name.
  created="$(nip_nebius iam v2 access-key create --parent-id "${NEBIUS_PROJECT_ID}" \
    --name "${sa_name}-${stack}-$(date -u +%Y%m%d%H%M%S)" --account-service-account-id "${sa_id}" \
    --description 'Temporary Object Storage access for Terraform state' \
    --expires-at "${expires}" --format json)" || return 1
  key_id="$(jq -r '.metadata.id // empty' <<<"${created}")"
  [[ -n "${key_id}" ]] || { echo "Error: access-key create returned no id" >&2; return 1; }
  key_json="$(nip_nebius iam v2 access-key get --id "${key_id}" --format json)" || return 1
  AWS_ACCESS_KEY_ID="$(jq -r '.status.aws_access_key_id // empty' <<<"${key_json}")"
  AWS_SECRET_ACCESS_KEY="$(jq -r '.status.secret // empty' <<<"${key_json}")"
  if [[ -z "${AWS_ACCESS_KEY_ID}" || -z "${AWS_SECRET_ACCESS_KEY}" ]]; then
    echo "Error: access key ${key_id} has no S3 credentials in its status" >&2
    unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
    return 1
  fi
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

  # Partial backend config consumed by `terraform init -backend-config=backend.hcl`.
  cat > "${tf_dir}/backend.hcl" <<EOF
bucket = "${bucket}"
key    = "stages/${stage}/${stack}.tfstate"
region = "${NEBIUS_REGION}"
endpoints = {
  s3 = "https://storage.${NEBIUS_REGION}.nebius.cloud:443"
}
EOF

  echo "Backend config written to ${tf_dir#"${repo_root}"/}/backend.hcl (key stages/${stage}/${stack}.tfstate)"
  echo "Exported: TF_VAR_iam_token TF_VAR_parent_id TF_VAR_region${TF_VAR_subnet_id:+ TF_VAR_subnet_id} AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY (key expires ${expires})"
  if [[ "${stack}" == "soperator" ]]; then
    echo "Next:     make soperator-plan STAGE=${stage}   (terraform/live/${stage}/soperator/README.generated.md)"
  else
    if [[ "${stage}" == "foundation" ]]; then
      echo "Next:     make init plan STAGE=foundation   (terraform/live/foundation/terraform.tfvars.example)"
    else
      echo "Next:     export TF_VAR_labels='{...nip-run, nip-ttl-expires...}' (sandbox; runbooks/deploy.md), then make init plan STAGE=${stage} STACK=${stack}"
    fi
  fi
  if [[ "${stage}" =~ ^(sandbox|staging|prod)$ && "${scope}" == "bucket" ]]; then
    # The foundation root adopts these objects instead of failing on the name clash (its stages only:
    # lab is bootstrap-only, terraform/live/foundation adopt_bootstrap accepts sandbox, staging, prod).
    echo "Foundation: add to terraform/live/foundation/terraform.tfvars when you apply it later:"
    echo "  adopt_bootstrap = { ${stage} = { bucket_id = \"${bucket_id}\", service_account_id = \"${sa_id}\", group_id = \"${group_id}\"${membership_id:+, membership_id = \"${membership_id}\"} } }"
  fi
}

_nip_bootstrap "$@"
