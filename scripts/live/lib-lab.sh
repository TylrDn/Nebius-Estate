# shellcheck shell=bash
# Helpers of the run-4 scripts (run4-r7.sh, run4-r4.sh): the `lab` stage, its own project nip-lab in
# uk-south1 (platform/stages.yaml, ADR-0009 later change; docs/plans/2026-10-12-live-runs.md
# "Run 4"). Sourced AFTER lib.sh, which it points at the lab stage (LIVE_STAGE=lab): TTL jobs, pid
# files and state reads then use terraform/live/lab/<stack>.
#
# Target: the stage binding .nip-targets/lab once the first lab bootstrap wrote it; before that, the
# one project named nip-lab in the tenant (nebius iam v2 project list), which must be in uk-south1.
# The first bootstrap binds it (NIP_BOOTSTRAP_NEW_STAGE=1, only while no binding exists); the bootstrap
# refuses a project already bound to another stage. No id is written here.
# shellcheck disable=SC2034  # read by lib.sh's functions
LIVE_STAGE=lab
LAB_REGION=uk-south1
LAB_PROJECT_NAME=nip-lab
LAB_FIRST_BIND=0

# lab_target: load_env for the lab stage (sets NEBIUS_PROJECT_ID / NEBIUS_REGION / NEBIUS_PROFILE).
lab_target() {
  if [[ ! -f "${REPO}/.nip-targets/lab" ]]; then
    local tenant prof out n
    tenant="$(env_get NEBIUS_TENANT_ID)"; prof="${_LIVE_CALLER_PROFILE:-$(env_get NEBIUS_PROFILE)}"
    [[ -n "${tenant}" && -n "${prof}" ]] || die "NEBIUS_TENANT_ID and NEBIUS_PROFILE must be in .env"
    out="$(nebius --profile "${prof}" iam v2 project list --parent-id "${tenant}" --all --format json)" || die "cannot list the tenant's projects"
    n="$(jq --arg n "${LAB_PROJECT_NAME}" '[(.items // [])[] | select(.metadata.name == $n)] | length' <<<"${out}")"
    [[ "${n}" == 1 ]] || die "expected exactly one project named ${LAB_PROJECT_NAME} (found ${n}): create it first with  bash ${LIVE_DIR}/L0-create-nip-lab.sh --apply"
    _LIVE_CALLER_PROJECT="$(jq -r --arg n "${LAB_PROJECT_NAME}" '.items[] | select(.metadata.name == $n) | .metadata.id' <<<"${out}")"
    local region; region="$(jq -r --arg n "${LAB_PROJECT_NAME}" '.items[] | select(.metadata.name == $n) | .spec.region // .status.region // empty' <<<"${out}")"
    [[ "${region}" == "${LAB_REGION}" ]] || die "${LAB_PROJECT_NAME} is in '${region}', not ${LAB_REGION}: a project's region is fixed at creation; the lab stage is ${LAB_REGION}"
    _LIVE_CALLER_REGION="${LAB_REGION}"
    LAB_FIRST_BIND=1
    say "no .nip-targets/lab yet: ${LAB_PROJECT_NAME} in ${LAB_REGION} found by name; the first bootstrap binds the lab stage to it"
  fi
  load_env
  [[ "${NEBIUS_REGION}" == "${LAB_REGION}" ]] || die "the lab binding names region ${NEBIUS_REGION}, not ${LAB_REGION}"
}

# lab_boot <stack>: boot, creating the lab state bucket and identity on the first bind only.
lab_boot() {
  if (( LAB_FIRST_BIND )); then
    NIP_BOOTSTRAP_NEW_STAGE=1 boot "$1"
    unset NIP_BOOTSTRAP_NEW_STAGE
    [[ -f "${REPO}/.nip-targets/lab" ]] || die "the first lab bootstrap did not write .nip-targets/lab"
    LAB_FIRST_BIND=0
  else
    boot "$1"
  fi
}

# lab_vcpu_free <need>: the non-GPU vCPU left in the lab project's region (min(tenant, project) limit
# less usage, from the quota allowances; read-only). Stops when fewer than <need> are free; warns when
# the quota service lists nothing to compare (the apply would then be the test).
lab_vcpu_free() {
  local need="$1" t p free
  t="$(nebius --profile "${NEBIUS_PROFILE}" quotas quota-allowance list --parent-id "${NEBIUS_TENANT_ID}" --all --format json 2>/dev/null \
    | jq -r --arg r "${LAB_REGION}" '[(.items // [])[] | select(.metadata.name == "compute.instance.non-gpu.vcpu" and .spec.region == $r) | {l: ((.spec.limit // 0) | tonumber), u: ((.status.usage // 0) | tonumber)}] | first // empty | "\(.l) \(.u)"' || true)"
  p="$(nebius --profile "${NEBIUS_PROFILE}" quotas quota-allowance list --parent-id "${NEBIUS_PROJECT_ID}" --all --format json 2>/dev/null \
    | jq -r --arg r "${LAB_REGION}" '[(.items // [])[] | select(.metadata.name == "compute.instance.non-gpu.vcpu" and .spec.region == $r and (.metadata.id // "") != "") | {l: ((.spec.limit // 0) | tonumber), u: ((.status.usage // 0) | tonumber)}] | first // empty | "\(.l) \(.u)"' || true)"
  if [[ -z "${t}" ]]; then say "WARNING: no tenant non-GPU vCPU allowance listed for ${LAB_REGION}: not checked (need ${need})"; return 0; fi
  read -r tl tu <<<"${t}"
  free=$(( tl - tu ))
  if [[ -n "${p}" ]]; then read -r pl pu <<<"${p}"; (( pl - pu < free )) && free=$(( pl - pu )); fi
  say "non-GPU vCPU in ${LAB_REGION}: ${free} free (tenant ${t:-?}, project cap ${p:-none}); this run needs ${need}"
  (( free >= need )) || die "only ${free} non-GPU vCPU free in ${LAB_REGION}; this run needs ${need} (docs/capacity.md)"
}

# lab_labels <ticket> <hours>: TF_VAR_labels for a lab stack (nip-run, nip-ttl-expires = now + hours).
lab_labels() { jq -cn --arg r "$1" --arg e "$(utc_plus_min $(( $2 * 60 )))" '{"nip-owner":"platform","nip-run":$r,"nip-ttl-expires":$e}'; }

# lab_stage_gate: scripts/leftovers.sh --stage lab --expect-empty (also unlabelled objects; the
# project's default network objects excepted). Output in state/<file>; returns its exit code.
lab_stage_gate() {
  local f="${STATE_DIR}/$1" rc=0
  run scripts/leftovers.sh --stage lab --expect-empty 2>&1 | tee "${f}" || rc=$?
  return "${rc}"
}
