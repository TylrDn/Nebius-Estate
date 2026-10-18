# Policy over every committed sizing file (terraform/live/*/*/*.tfvars, parsed as HCL2): the CPU
# node group is outside the stage GPU caps (platform/stages.yaml), so it never carries GPUs and
# stays a small system pool. Run under namespace "sizing" (see Makefile `policy`); the inference
# and training stacks refuse the same values at plan time (variable validations).
package sizing

import rego.v1

deny contains msg if {
	input.cpu_platform
	not startswith(input.cpu_platform, "cpu-")
	msg := sprintf("cpu_platform %s is not a cpu-* platform: GPU nodes belong in the GPU group, where the stage policy caps them", [input.cpu_platform])
}

deny contains msg if {
	input.cpu_preset
	regex.match(`^[0-9]+gpu-`, input.cpu_preset)
	msg := sprintf("cpu_preset %s is a GPU preset: GPU nodes belong in the GPU group, where the stage policy caps them", [input.cpu_preset])
}

deny contains msg if {
	input.cpu_node_count > 16
	msg := sprintf("cpu_node_count %v is above 16: the CPU group hosts system add-ons only (raise the stack bound by a reviewed change)", [input.cpu_node_count])
}
