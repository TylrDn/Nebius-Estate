# Unit tests for package allowlists (`conftest verify --policy policy`, part of `make policy`).
package allowlists

import rego.v1

test_documentation_range_refused if {
	count(deny) > 0 with input as {"allowed_cidrs": ["203.0.113.0/24"]}
}

test_internet_wide_entry_refused if {
	count(deny) > 0 with input as {"allowed_cidrs": ["0.0.0.0/0"]}
}

test_slash_one_halves_refused if {
	count(deny) == 2 with input as {"allowed_cidrs": ["0.0.0.0/1", "128.0.0.0/1"]}
}

test_slash_eight_accepted if {
	count(deny) == 0 with input as {"allowed_cidrs": ["10.0.0.0/8", "198.18.0.0/15"]}
}

test_no_allowlist_accepted if {
	count(deny) == 0 with input as {"cluster_name": "nip-prod-inference"}
}
