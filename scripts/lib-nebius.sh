# shellcheck shell=bash
# Shared by the scripts that call the Nebius CLI (sourced; defines functions only, changes no
# shell options, so scripts/bootstrap-backend.sh can source it into an interactive shell).
#
#   nip_nebius <args...>          the CLI, with --profile "$NEBIUS_PROFILE" when that is set, so every
#                                 script acts as the same profile the operator chose, and with
#                                 --config "$NIP_NEBIUS_CONFIG" when a script made a throwaway config
#   nip_endpoint_flag <cluster>   --external when the cluster has a public API endpoint, otherwise
#                                 --internal (the caller must then run in the cluster's subnet); one rule for
#                                 get-kubeconfig.sh and wait-for-ofed.sh
#                                 (https://docs.nebius.com/kubernetes/connect)

nip_nebius() {
  local cfg=()
  [[ -n "${NIP_NEBIUS_CONFIG:-}" ]] && cfg=(--config "${NIP_NEBIUS_CONFIG}")
  if [[ -n "${NEBIUS_PROFILE:-}" ]]; then
    nebius "${cfg[@]+"${cfg[@]}"}" --profile "${NEBIUS_PROFILE}" "$@"
  else
    nebius "${cfg[@]+"${cfg[@]}"}" "$@"
  fi
}

nip_endpoint_flag() {
  local cluster_id="$1" cluster public
  cluster="$(nip_nebius mk8s cluster get --id "${cluster_id}" --format json)" || {
    echo "cannot read cluster ${cluster_id}: check the id and 'nebius iam get-access-token --no-browser' (profile ${NEBIUS_PROFILE:-default})" >&2
    return 1
  }
  public="$(jq -r '.status.control_plane.endpoints.public_endpoint // .status.controlPlane.endpoints.publicEndpoint // empty' <<<"${cluster}")"
  if [[ -n "${public}" ]]; then
    echo --external
  else
    echo "cluster ${cluster_id} has no public endpoint; using the private one (run this from a VM in the cluster's subnet)" >&2
    echo --internal
  fi
}
