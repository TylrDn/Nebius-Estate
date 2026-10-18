#!/usr/bin/env bash
# R7 — Private network perimeter, on a cluster deployed into the network stack's subnet
# (runbooks/network.md). Passes when:
#   1. no node has an ExternalIP (workload nodes hold no public address);
#   2. the source address an echo endpoint sees from a short-lived pod equals the NAT VM's public
#      address (egress leaves through the custom NAT gateway, not a per-node address);
#   3. the workload subnet has the stack's route table, and that table routes 0.0.0.0/0.
# Inputs (each overrides the terraform output of terraform/live/$STAGE/network):
#   STAGE          sandbox | staging | prod (default sandbox)
#   NAT_PUBLIC_IP  the NAT VM's public address   (output nat_public_ip)
#   SUBNET_ID      the workload subnet            (output subnet_id)
#   ECHO_URL       returns the caller's IPv4 address as plain text (default https://ifconfig.me/ip;
#                  https://checkip.amazonaws.com works the same way)
# Needs: kubectl, jq, nebius CLI (NEBIUS_PROFILE honoured); terraform unless both ids are given.
# shellcheck source=tests/validate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; need kubectl jq nebius
# shellcheck source=scripts/lib-nebius.sh
source "$(dirname "${BASH_SOURCE[0]}")/../../scripts/lib-nebius.sh"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE="${STAGE:-sandbox}"
ECHO_URL="${ECHO_URL:-https://ifconfig.me/ip}"
PROBE_IMAGE="${EGRESS_PROBE_IMAGE:-curlimages/curl:8.22.0@sha256:58adaa4e8dca9c988bae2aba4ab3434a0bb2da16bbe3f92dec39ec7785166777}"

tf_output() { # <name>: one output of the stage's network root, empty when unavailable
  command -v terraform >/dev/null || return 0
  terraform -chdir="${repo_root}/terraform/live/${STAGE}/network" output -raw "$1" 2>/dev/null || true
}
nat_ip="${NAT_PUBLIC_IP:-$(tf_output nat_public_ip)}"; nat_ip="${nat_ip%/32}"
subnet_id="${SUBNET_ID:-$(tf_output subnet_id)}"
if [[ -z "$nat_ip" || -z "$subnet_id" ]]; then
  echo "need NAT_PUBLIC_IP and SUBNET_ID (or an initialised terraform/live/${STAGE}/network with outputs nat_public_ip and subnet_id)" >&2
  exit 2
fi

# 1. No node carries a public address.
nodes="$(kubectl get nodes -o json | jq '[.items[] | {name: .metadata.name, external: [.status.addresses[]? | select(.type == "ExternalIP") | .address]}]')"
public_nodes="$(jq '[.[] | select(.external | length > 0)]' <<<"$nodes")"
no_public_ip="$(jq 'length == 0' <<<"$public_nodes")"

# 2. Egress source address, seen from outside, from a pod on a workload node.
kubectl delete pod nip-egress-probe --ignore-not-found >/dev/null 2>&1 || true
egress_ip="$(kubectl run nip-egress-probe --rm -i --restart=Never --quiet --image="${PROBE_IMAGE}" \
  -- -fsS --max-time 15 "${ECHO_URL}" 2>/dev/null | tr -d '[:space:]' || true)"
[[ "$egress_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || egress_ip=""
egress_via_nat=false; [[ -n "$egress_ip" && "$egress_ip" == "$nat_ip" ]] && egress_via_nat=true

# 3. Route table on the workload subnet, with a default route.
subnet="$(nip_nebius vpc subnet get --id "${subnet_id}" --format json 2>/dev/null || echo '{}')"
rt_id="$(jq -r '.status.route_table.id // .status.routeTable.id // empty' <<<"$subnet")"
rt_default="$(jq -r '.status.route_table.default // .status.routeTable.default // false' <<<"$subnet")"
default_route=false
if [[ -n "$rt_id" && "$rt_default" != true ]]; then
  routes="$(nip_nebius vpc route list --parent-id "${rt_id}" --format json 2>/dev/null || echo '{}')"
  default_route="$(jq '[.items[]? | select((.spec.destination.cidr // "") == "0.0.0.0/0")] | length > 0' <<<"$routes")"
fi

details="$(jq -n --argjson nodes "$nodes" --argjson pub "$public_nodes" --argjson nopub "$no_public_ip" \
  --arg echo "$ECHO_URL" --arg seen "$egress_ip" --arg nat "$nat_ip" --argjson via "$egress_via_nat" \
  --arg subnet "$subnet_id" --arg rt "$rt_id" --argjson rtdef "$rt_default" --argjson route "$default_route" \
  '{nodes:($nodes|length),nodes_with_public_ip:$pub,no_node_public_ip:$nopub,
    echo_url:$echo,egress_source_ip:$seen,nat_public_ip:$nat,egress_via_nat:$via,
    subnet_id:$subnet,route_table_id:$rt,route_table_is_network_default:$rtdef,default_route_present:$route}')"
if [[ "$no_public_ip" == true && "$egress_via_nat" == true && -n "$rt_id" && "$rt_default" != true && "$default_route" == true ]]; then
  record network pass "$details"
else
  record network fail "$details"
fi
