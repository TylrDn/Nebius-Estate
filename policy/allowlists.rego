# Policy over every committed sizing file (terraform/live/*/*/*.tfvars, parsed as HCL2).
# An allowlist is the operator's office/VPN egress and is passed at plan time; a committed
# documentation range (RFC 5737) would pass a review and then lock the pipeline out of the API.
# An entry wider than /8 (0.0.0.0/0, or its two /1 halves) admits most of the internet.
# Run under namespace "allowlists" (see Makefile `policy`); the stacks enforce the same rules.
package allowlists

import rego.v1

documentation_ranges := ["192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24"]

deny contains msg if {
	some cidr in input.allowed_cidrs
	some doc in documentation_ranges
	net.cidr_contains(doc, cidr)
	msg := sprintf("allowed_cidrs holds %s, a documentation range (RFC 5737); pass real egress CIDRs with TF_VAR_allowed_cidrs", [cidr])
}

deny contains msg if {
	some cidr in input.allowed_cidrs
	to_number(split(cidr, "/")[1]) < 8
	msg := sprintf("allowed_cidrs holds %s, wider than /8: that admits most of the internet; list office/VPN egress CIDRs (modules/stage-policy refuses it too)", [cidr])
}
