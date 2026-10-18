# Unit tests for package sizing (`conftest verify --policy policy`, part of `make policy`).
package sizing

import rego.v1

test_gpu_platform_in_cpu_group_refused if {
	count(deny) > 0 with input as {"cpu_platform": "gpu-h100-sxm"}
}

test_gpu_preset_in_cpu_group_refused if {
	count(deny) > 0 with input as {"cpu_preset": "8gpu-128vcpu-1600gb"}
}

test_cpu_node_count_above_bound_refused if {
	count(deny) > 0 with input as {"cpu_node_count": 17}
}

test_cpu_sizing_accepted if {
	count(deny) == 0 with input as {"cpu_platform": "cpu-d3", "cpu_preset": "8vcpu-32gb", "cpu_node_count": 3}
}

test_files_without_cpu_sizing_accepted if {
	count(deny) == 0 with input as {"gpu_node_count": 2}
}
