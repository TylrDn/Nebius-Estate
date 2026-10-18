#!/usr/bin/env bash
# Residue check after `make destroy` (runbooks/teardown.md): list every billable resource
# left in the project that belongs to an environment, by label (clusters, node groups, VMs, disks,
# filesystems, GPU clusters, R15 NVL instance groups, R12 MLflow and PostgreSQL clusters, R9 pricing policies and
# Container Registries, buckets, transfers, IPs, VPC objects), plus the two things labels never
# reach — CSI-created disks (`pvc-*`, which outlive the cluster), GPU clusters and MLflow clusters.
#   scripts/leftovers.sh [--stack <nip-stack>] [--stage <nip-stage>] [--expect-empty]
# --stack matches the nip-stack label, or the deprecated nip-env label on resources created before
# nip-stack existed (docs/naming.md); --env is kept as an alias of --stack.
# --stage also lists UNLABELLED resources, every disk included: each stage is its own project
# (ADR-0009), so anything in it belongs to the stage, labelled or not (the vendored Soperator
# recipe labels nothing).
# Needs: NEBIUS_PROJECT_ID; nebius CLI (NEBIUS_PROFILE honoured); jq. Read-only: it never deletes anything.
# With --expect-empty the exit code is 1 when anything is listed, for use as a gate.
set -euo pipefail
stack_filter=""; stage_filter=""; expect_empty=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack|--env) stack_filter="${2:?$1 needs a value}"; shift 2 ;;
    --stage) stage_filter="${2:?--stage needs a value}"; shift 2 ;;
    --expect-empty) expect_empty=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
for c in nebius jq; do command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 2; }; done
# shellcheck source=scripts/lib-nebius.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib-nebius.sh"
: "${NEBIUS_PROJECT_ID:?set NEBIUS_PROJECT_ID to the stage project}"
p="${NEBIUS_PROJECT_ID}"
found=0

# Resources this repo labels (nip-stack / nip-stage / nip-owner / nip-region / nip-run / nip-ttl-expires;
# nip-env is the deprecated twin of nip-stack and is read only when nip-stack is absent).
# With --stage, unlabelled ones are listed too, except for kinds every project has by default (its
# default network, subnet, pools, security group and route table): those pass --labelled-only.
# State buckets (tfstate-*) are never listed.
# One listing of every page; a failed call stops the check instead of reading as "nothing left".
# Most lists answer {"items": [...]}; `msp postgresql v1alpha1 cluster list` answers {"clusters": [...]}
# (CLI, live 2026-10-11), so the answer is normalised to .items.
list_all() { # <nebius service subcommand...>
  local out
  out="$(nip_nebius "$@" list --parent-id "${p}" --all --format json 2>/dev/null)" \
    || { echo "could not list (nebius $* list): check the login and that NEBIUS_PROJECT_ID is the stage project" >&2; exit 2; }
  jq -c '{items: (.items // .clusters // [])}' <<<"${out:-{\}}"
}
labelled() { # [--labelled-only] <title> <nebius service subcommand...>
  local only=false; [[ "$1" == --labelled-only ]] && { only=true; shift; }
  local title="$1"; shift
  local items
  items="$(list_all "$@" \
    | jq -c --arg e "${stack_filter}" --arg s "${stage_filter}" --argjson only "${only}" '[.items[]?
        | (.metadata.labels["nip-stack"] // .metadata.labels["nip-env"]) as $stack
        | select((.metadata.name // "") | startswith("tfstate-") | not)
        | select(($s != "" and ($only | not)) or $stack != null)
        | select($e == "" or $stack == $e)
        | select($s == "" or .metadata.labels["nip-stage"] == $s or .metadata.labels["nip-stage"] == null)
        | {id: .metadata.id, name: .metadata.name, stack: ($stack // "-"), stage: (.metadata.labels["nip-stage"] // "-"), run: (.metadata.labels["nip-run"] // "-"), ttl: (.metadata.labels["nip-ttl-expires"] // "-")}]')" \
    || { echo "could not list ${title} (nebius $* list): check the login and that NEBIUS_PROJECT_ID is the stage project" >&2; exit 2; }
  local n; n="$(jq 'length' <<<"${items}")"
  if [[ "${n}" -gt 0 ]]; then found=1; echo "== ${title}: ${n}"; jq -r '.[] | "  \(.id)  \(.name)  stack=\(.stack) stage=\(.stage) run=\(.run) ttl=\(.ttl)"' <<<"${items}"; fi
}
labelled "Managed Kubernetes clusters"  mk8s cluster
# Node groups are children of a cluster (parent_id = cluster id), so list them per cluster.
clusters="$(list_all mk8s cluster | jq -r '.items[]?.metadata.id')"
for cluster in ${clusters}; do
  p="${cluster}" labelled "Node groups of ${cluster}" mk8s node-group
done
labelled "Compute instances"            compute instance
labelled "Compute disks"                compute disk
labelled "Shared filesystems"           compute filesystem
labelled "GPU clusters (labelled)"      compute gpu-cluster
labelled "NVL instance groups (R15)"    compute nvl-instance-group
labelled "Managed MLflow clusters (R12)"     msp mlflow v1alpha1 cluster
labelled "Managed PostgreSQL clusters (R12)" msp postgresql v1alpha1 cluster
labelled "Pricing policies (R9 spot caps)" billing v1 pricing-policy
labelled "Container Registries (R12)"   registry
labelled "VPC allocations (IPs)"        vpc allocation
labelled "Object Storage buckets"       storage bucket
labelled "Object Storage transfers"     storage transfer
labelled --labelled-only "VPC networks"         vpc network
labelled --labelled-only "VPC subnets"          vpc subnet
labelled --labelled-only "VPC pools"            vpc pool
labelled --labelled-only "VPC route tables"     vpc route-table
labelled --labelled-only "VPC security groups"  vpc security-group

# Unlabelled residue: CSI-provisioned disks are created by Kubernetes, carry no labels, and
# survive `terraform destroy` of the cluster; GPU clusters hold quota even when empty. With --stage
# every disk is already listed above (labelled or not), so the pvc-* pass only runs without it.
disks="[]"
[[ -z "${stage_filter}" ]] && disks="$(list_all compute disk \
  | jq -c '[.items[]? | select((.metadata.name // "") | startswith("pvc-")) | select((.metadata.labels["nip-stack"] // .metadata.labels["nip-env"]) == null) | {id: .metadata.id, name: .metadata.name, gib: (.spec.size_gibibytes // .spec.sizeGibibytes // "?"), attached: (if (.status.read_write_attachment // .status.readWriteAttachment) then 1 else 0 end)}]')"
if [[ "$(jq length <<<"${disks}")" -gt 0 ]]; then found=1; echo "== CSI disks (pvc-*, unlabelled): $(jq length <<<"${disks}")"; jq -r '.[] | "  \(.id)  \(.name)  \(.gib) GiB  attachments=\(.attached)"' <<<"${disks}"; fi
# MLflow clusters: the API keeps no labels (live apply 2026-10-11), so without --stage (which already
# lists unlabelled ones above) every unlabelled one is listed here.
mlfl="[]"
[[ -z "${stage_filter}" ]] && mlfl="$(list_all msp mlflow v1alpha1 cluster \
  | jq -c '[.items[]? | select((.metadata.labels["nip-stack"] // .metadata.labels["nip-env"]) == null) | {id: .metadata.id, name: .metadata.name}]')"
if [[ "$(jq length <<<"${mlfl}")" -gt 0 ]]; then found=1; echo "== MLflow clusters (unlabelled; the API keeps no labels): $(jq length <<<"${mlfl}")"; jq -r '.[] | "  \(.id)  \(.name)"' <<<"${mlfl}"; fi
# R9 pricing policies keep no labels either (live apply 2026-10-11): without --stage, list the
# unlabelled ones named <prefix>-<stage>-spot-<platform> (stacks/governance).
pp="[]"
[[ -z "${stage_filter}" ]] && pp="$(list_all billing v1 pricing-policy \
  | jq -c '[.items[]? | select((.metadata.labels["nip-stack"] // .metadata.labels["nip-env"]) == null and (.metadata.name | test("-spot-gpu-"))) | {id: .metadata.id, name: .metadata.name}]')"
if [[ "$(jq length <<<"${pp}")" -gt 0 ]]; then found=1; echo "== Pricing policies (unlabelled; the API keeps no labels): $(jq length <<<"${pp}")"; jq -r '.[] | "  \(.id)  \(.name)"' <<<"${pp}"; fi
gpucl="$(list_all compute gpu-cluster | jq -c '[.items[]? | {id: .metadata.id, name: .metadata.name}]')"
if [[ "$(jq length <<<"${gpucl}")" -gt 0 ]]; then found=1; echo "== GPU clusters (all): $(jq length <<<"${gpucl}")"; jq -r '.[] | "  \(.id)  \(.name)"' <<<"${gpucl}"; fi

if [[ "${found}" == 0 ]]; then echo "no leftovers in ${p}${stack_filter:+ for nip-stack=${stack_filter}}${stage_filter:+ for nip-stage=${stage_filter}} (state bucket excluded by design)"; exit 0; fi
echo "delete deliberately: nebius <service> <kind> delete --id <id> (never the state bucket)" >&2
[[ "${expect_empty}" == 1 ]] && exit 1 || exit 0
