# Unit tests for package stages (`conftest verify --policy policy`, part of `make policy`): the rules
# for a stage that lists its stacks (lab). Each input is a stages.yaml holding only that stage.
package stages

import rego.v1

lab_policy := {"require_ttl_label": true, "max_gpu_nodes": {"inference": 0, "training": 0, "gpu-vm": 0, "nvl": 0}, "require_strict_reservation": {"nvl": true}}

test_cpu_only_lab_accepted if {
	count(deny) == 0 with input as {"stages": {"lab": {"stacks": ["network", "soperator"], "policy": lab_policy}}, "promotion": []}
}

test_lab_without_ttl_refused if {
	count(deny) > 0 with input as {"stages": {"lab": {"stacks": ["network"], "policy": object.union(lab_policy, {"require_ttl_label": false})}}, "promotion": []}
}

test_lab_with_gpu_cap_refused if {
	count(deny) > 0 with input as {"stages": {"lab": {"stacks": ["network"], "policy": object.union(lab_policy, {"max_gpu_nodes": {"inference": 1}})}}, "promotion": []}
}

test_lab_with_gpu_stack_refused if {
	count(deny) > 0 with input as {"stages": {"lab": {"stacks": ["network", "inference"], "policy": lab_policy}}, "promotion": []}
}

# The CPU-only rules hold for the stage named lab even if its stacks: key is deleted (render-live-roots.py
# would then render every stack for it).
test_lab_without_stacks_refused if {
	"lab must list its stacks (platform/stages.yaml): it is the CPU-only stage and renders only those roots" in deny with input as {"stages": {"lab": {"policy": lab_policy}}, "promotion": []}
}

test_lab_without_stacks_keeps_ttl_and_gpu_rules if {
	msgs := deny with input as {"stages": {"lab": {"policy": object.union(lab_policy, {"require_ttl_label": false, "max_gpu_nodes": {"inference": 1}})}}, "promotion": []}
	some ttl in msgs
	contains(ttl, "require_ttl_label must be true")
	some gpu in msgs
	contains(gpu, "max_gpu_nodes.inference must be 0")
}
