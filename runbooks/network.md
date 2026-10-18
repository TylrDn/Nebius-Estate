# Network runbook — R7 private perimeter

Deploy, connect to, verify and remove the private network that R1 (inference) and R3 (training)
clusters run in. The stack is [`terraform/stacks/network`](../terraform/stacks/network/): a VPC
network with its own private pool, a workload subnet that cannot hold public addresses, an edge
subnet, security groups, a custom NAT gateway VM with a route table, and an optional WireGuard
bastion. Mocked tests only so far; nothing here has run live yet (record the first run in
`docs/evidence/`).

Upstream references: [custom NAT gateway](https://docs.nebius.com/vpc/routing/custom-nat-gateway),
[routing tables](https://docs.nebius.com/vpc/routing/manage),
[security groups](https://docs.nebius.com/vpc/security-groups/overview),
[WireGuard jump server](https://docs.nebius.com/compute/virtual-machines/wireguard).

## Deploy order

The network comes first, the data plane (R8, [`data.md`](data.md)) second, the clusters last.
Each is its own live root and state key in the stage's bucket.

| # | Command | Expect |
|---|---|---|
| 1 | `source scripts/bootstrap-backend.sh <stage> network` | `terraform/live/<stage>/network/backend.hcl` and the credentials ([`deploy.md`](deploy.md) prerequisites apply) |
| 2 | sandbox: `export TF_VAR_labels='{"nip-owner":"platform","nip-run":"<ticket>","nip-ttl-expires":"<RFC 3339 UTC>"}'`; with a bastion: `export TF_VAR_allowed_cidrs='["<office egress>/32"]'` | the plan refuses a bastion without an allowlist, and documentation ranges in staging and prod |
| 3 | `make init plan STAGE=<stage> STACK=network` | pool, network, two subnets, security groups and rules, the NAT allocation + VM + route table + default route; the bastion allocation + VM only with `enable_bastion` |
| 4 | `make apply CONFIRM=yes STAGE=<stage> STACK=network` | the NAT VM configures forwarding and masquerade at first boot (cloud-init) |
| 5 | hand the outputs to the cluster root (below), then deploy R1 or R3 as in [`deploy.md`](deploy.md) | nodes land in the workload subnet with no public address |

Pass the outputs to the cluster stack in the same shell, after `source scripts/bootstrap-backend.sh
<stage> <inference|training>` (the state bucket is shared per stage, so the same key reads both):

```bash
net=terraform/live/<stage>/network
export TF_VAR_subnet_id="$(terraform -chdir=$net output -raw subnet_id)"
export TF_VAR_service_cidr="$(terraform -chdir=$net output -raw service_cidr)"
export TF_VAR_security_group_ids="$(terraform -chdir=$net output -json security_group_ids)"
make init plan STAGE=<stage> STACK=inference      # review: the cluster and node groups use that subnet
```

IDs are passed through the environment, never committed to the sizing files. Keep the
`<stage>` CIDRs distinct (`10.40/16` sandbox, `10.42/16` prod in the sizing files) so a later VPN
or peering never overlaps.

For the manual Terraform workflow, configure both `<stage>-plan` and `<stage>` Environment
variables `NIP_SUBNET_ID`, `NIP_SERVICE_CIDR` and `NIP_SECURITY_GROUP_IDS` from these same outputs
before dispatching inference/training. The service range is required with R7: Kubernetes's
default `/16` reservation does not fit its workload subnet. The workflow also forwards workload
security groups to gpu-vm, which has no Kubernetes service range.

## WireGuard bastion: add a peer

The bastion's security group admits only UDP 51820 from `allowed_cidrs`; SSH is not open from
anywhere. Traffic to the bastion's own tunnel address (`10.99.0.1`) never crosses a VPC interface,
so once one peer exists every later change is made over the tunnel. Traffic the bastion forwards
into the VPC is masqueraded to its private address and is still filtered by the destination's
security groups (the workload group admits `cidr`; the NAT group admits SSH only from the bastion
group). The bastion needs `ssh_public_key` set in the network root (the `nip-admin` user).

1. On the client: `wg genkey | tee client.key | wg pubkey > client.pub` (the private key never
   leaves the client).
2. Pick a free tunnel address in `wireguard_cidr` (default `10.99.0.0/24`; `.1` is the bastion).
3. Reach the bastion's shell:
   - **later peers:** `ssh nip-admin@10.99.0.1` through an existing tunnel;
   - **first peer:** open SSH from your address for the duration of the change, then remove it:

     ```bash
     # the id of nip-<stage>-network-bastion: `nebius vpc security-group list` (.items[].metadata.id)
     sg=$(nebius vpc security-group list --format json | jq -r --arg n "nip-${STAGE}-network-bastion" '.items[] | select(.metadata.name == $n) | .metadata.id')
     rule=$(nebius vpc security-rule create --parent-id "$sg" --name tmp-ssh-bootstrap --access allow \
       --protocol tcp --priority 150 --ingress-source-cidrs "<your egress>/32" \
       --ingress-destination-ports 22 --format jsonpath='{.metadata.id}')
     ssh nip-admin@<bastion public IP>       # output bastion.endpoint, without the port
     # ... step 4 ...
     nebius vpc security-rule delete "$rule"   # Terraform does not manage this rule: delete it
     ```
4. On the bastion: `sudo wg set wg0 peer <client.pub contents> allowed-ips 10.99.0.<n>/32 && sudo wg-quick save wg0`
   and read the server key: `sudo cat /etc/wireguard/server.pub`.
5. Client config (`wg0.conf`):

   ```ini
   [Interface]
   PrivateKey = <client.key>
   Address = 10.99.0.<n>/32
   [Peer]
   PublicKey = <server.pub>
   Endpoint = <output bastion.endpoint>
   AllowedIPs = 10.99.0.0/24, <network cidr>
   PersistentKeepalive = 25
   ```
6. `wg-quick up ./wg0.conf`, then `ping 10.99.0.1`. Node and VM addresses in the network are
   reachable through the tunnel (traffic is masqueraded to the bastion's private address). The
   cluster's **private API endpoint is not**: the docs reach it only from a VM in the cluster's
   own region and subnet ([connect](https://docs.nebius.com/kubernetes/connect)), and the bastion
   sits in the edge subnet. See [Private API endpoint](#private-api-endpoint-prod).

Remove a peer: `sudo wg set wg0 peer <pubkey> remove && sudo wg-quick save wg0`. Rebuilding the
bastion VM generates a new server key: every client then needs the new `server.pub`.

## Private API endpoint (prod)

Prod clusters run with `public_endpoint: false`. Per the docs, `nebius mk8s cluster get-credentials
--id <cluster id> --internal` works only from a VM in the same region **and subnet** as the cluster
([connect](https://docs.nebius.com/kubernetes/connect),
[create clusters](https://docs.nebius.com/kubernetes/clusters/manage#how-to-create-clusters)).
So prod operators' kubectl and the self-hosted CI runner must run on a VM in the R7 **workload**
subnet (output `subnet_id`), never the edge subnet. The bastion is the path to that VM
(`ssh <user>@<VM private IP>` with the tunnel up), not to the API endpoint itself. A VM in the workload subnet has no public address and egresses through the NAT gateway.
Not verified live yet: record the first prod connection in `docs/evidence/`.

## Verify

With the cluster deployed into the subnet and `KUBECONFIG` exported (`make kubeconfig`):

```bash
STAGE=<stage> tests/validate/network.sh      # results/network.json
```

| Check | Passes when |
|---|---|
| no public node address | no node reports an `ExternalIP` |
| egress through NAT | a short-lived `curl` pod sees, at `ECHO_URL` (default `https://ifconfig.me/ip`), the NAT VM's public address |
| route table | the workload subnet's route table is the stack's (not the network default) and holds `0.0.0.0/0` |

The script reads `nat_public_ip` and `subnet_id` from the network root's outputs; set
`NAT_PUBLIC_IP` and `SUBNET_ID` to run it without Terraform access. If egress fails: is the NAT
VM running (`nebius compute instance get-by-name --name nip-<stage>-network-nat`)? A route whose next hop is
not attached to a running VM discards traffic. Then on the VM: `sysctl net.ipv4.ip_forward` is
`1` and `sudo iptables -t nat -S POSTROUTING` shows the `MASQUERADE` rule.

Public addresses: the NAT VM and the bastion hold two of the default three public IPv4 addresses
per region ([VPC quotas](https://docs.nebius.com/vpc/resources/quotas-limits)); request more quota
before adding public load balancers in the same project.

## Variant: site-to-site VPN

A WireGuard bastion serves people. To connect a data centre or another cloud, use
[Nebius VPN Gateway](https://docs.nebius.com/vpc/nebius-vpn-gateway): an open-source, VM-based
IPsec gateway (strongSwan, IKEv2, BGP via FRRouting, active/passive HA) maintained by Nebius
Professional Services, with peer config importers for Google Cloud, AWS, Azure and Cisco IOS.
It is not built here. Deploy it into the edge subnet, keep the stage CIDRs non-overlapping with
the remote side, and add the remote prefixes to the workload security group's allowed sources
through a reviewed change to the network stack.

## Teardown

Reverse order: clusters, then data, then network. The workload subnet cannot be deleted while
node interfaces are attached.

1. `make destroy-plan STACK=inference` (or `training`) and destroy it ([`teardown.md`](teardown.md)).
2. Data stack, if it lives only as long as this network ([`data.md`](data.md#teardown)).
3. `make destroy-plan STAGE=<stage> STACK=network`; review that it removes the VMs, allocations,
   route table, groups, subnets, network and pool, and nothing else. Then
   `make destroy CONFIRM=yes STAGE=<stage> STACK=network`.
4. `make leftovers STACK=network` with `NEBIUS_PROJECT_ID` set to the stage's project (`make leftovers` reads only `STACK`, `Makefile:229-230`; the project comes from `NEBIUS_PROJECT_ID`, `scripts/leftovers.sh:10`): nothing labelled `nip-stack=network` (or, on older resources, `nip-env=network`) remains. A
   leftover `tmp-ssh-bootstrap` rule disappears with its group.

Prod is not torn down with `make`: [`teardown.md` → Prod](teardown.md#prod).
