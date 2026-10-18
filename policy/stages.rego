# Policy over platform/stages.yaml itself: the stage policy is what the stacks enforce at plan
# time, so a careless edit here would silently weaken prod. conftest (OPA) checks these invariants
# in CI (`make policy`). Input: the YAML document.
package stages

import rego.v1

prod := input.stages.prod.policy

staging := input.stages.staging.policy

sandbox := input.stages.sandbox.policy

deny contains msg if {
	prod.etcd_cluster_size != 3
	msg := "prod.etcd_cluster_size must be 3 (HA control plane is free; ADR-0009)"
}

deny contains msg if {
	prod.public_endpoint == true
	msg := "prod.public_endpoint must be false: the API is reached from inside the VPC (docs/security.md)"
}

deny contains msg if {
	prod.require_allowed_cidrs != true
	msg := "prod.require_allowed_cidrs must stay true so a public endpoint re-enabled by a reviewed change to this file needs an allowlist"
}

deny contains msg if {
	prod.allow_preemptible_serving == true
	msg := "prod must not serve on preemptible capacity (ADR-0007)"
}

deny contains msg if {
	prod.forbid_deletion != true
	msg := "prod.forbid_deletion must be true: data-holding filesystems are deletion-protected (docs/dr.md)"
}

deny contains msg if {
	prod.audit_logs != true
	msg := "prod.audit_logs must be true (docs/security.md)"
}

deny contains msg if {
	prod.alertmanager != true
	msg := "prod.alertmanager must be true: alerts without a receiver are not observability (docs/slo.md)"
}

deny contains msg if {
	prod.k8s_version_pinned != true
	msg := "prod.k8s_version_pinned must be true (runbooks/upgrade.md)"
}

deny contains msg if {
	prod.require_strict_reservation.training != true
	msg := "prod training runs on STRICT reservations only (docs/capacity.md)"
}

deny contains msg if {
	staging.allow_preemptible_serving == true
	msg := "staging mirrors prod's capacity type (no preemptible serving)"
}

deny contains msg if {
	staging.etcd_cluster_size != 3
	msg := "staging.etcd_cluster_size must be 3: staging is production shape"
}

deny contains msg if {
	sandbox.require_ttl_label != true
	msg := "sandbox.require_ttl_label must be true: everything in the sandbox carries an expiry (docs/cost.md)"
}

# A stage that lists its stacks, and the stage named lab whatever it lists, is CPU-only and disposable:
# TTL-labelled, no GPU node anywhere, and only stacks without GPU nodes. Without this a GPU stack could
# be listed there and planned in a second project with sandbox rules but no sandbox budget (ADR-0009,
# platform/stages.yaml). lab must list its stacks: without the key every stack renders for it.
cpu_only_stacks := {"network", "data", "soperator"}

cpu_only_stages contains stage if {
	some stage, s in input.stages
	s.stacks
}

cpu_only_stages contains "lab" if input.stages.lab

deny contains msg if {
	input.stages.lab
	not input.stages.lab.stacks
	msg := "lab must list its stacks (platform/stages.yaml): it is the CPU-only stage and renders only those roots"
}

deny contains msg if {
	some stage in cpu_only_stages
	input.stages[stage].policy.require_ttl_label != true
	msg := sprintf("%s is a disposable CPU-only stage: require_ttl_label must be true (docs/cost.md)", [stage])
}

deny contains msg if {
	some stage in cpu_only_stages
	some stack, n in input.stages[stage].policy.max_gpu_nodes
	n != 0
	msg := sprintf("%s is CPU-only: max_gpu_nodes.%s must be 0", [stage, stack])
}

deny contains msg if {
	some stage, s in input.stages
	some stack in s.stacks
	not cpu_only_stacks[stack]
	msg := sprintf("%s.stacks may name only stacks without GPU nodes (%v), not %s", [stage, cpu_only_stacks, stack])
}

deny contains msg if {
	some stage, s in input.stages
	s.policy.max_gpu_nodes.training > 32
	msg := sprintf("%s.max_gpu_nodes.training above 32 needs a capacity plan first (docs/capacity.md)", [stage])
}

deny contains msg if {
	some stage, s in input.stages
	s.policy.max_gpu_nodes.nvl > 0
	s.policy.require_strict_reservation.nvl != true
	msg := sprintf("%s.max_gpu_nodes.nvl > 0 needs require_strict_reservation.nvl: true: GB300 racks run on an approved reservation only (terraform/stacks/nvl/README.md)", [stage])
}

deny contains msg if {
	some stage, s in input.stages
	s.policy.max_gpu_nodes.nvl % 18 != 0
	msg := sprintf("%s.max_gpu_nodes.nvl must be a whole number of 18-node GB300 racks (terraform/stacks/nvl/README.md)", [stage])
}

deny contains msg if {
	not input.promotion
	msg := "promotion order must be declared (ADR-0009)"
}
