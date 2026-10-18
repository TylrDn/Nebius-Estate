# Policy over the prod sizing files (terraform/live/prod/*/prod.auto.tfvars, parsed as HCL2).
# The stacks enforce the same rules at plan time; this layer catches them at review time without
# credentials and reads as a checklist. Run under namespace "prod" (see Makefile `policy`).
# Cluster rules apply to the R1/R3 files only (they set cluster_name); R7 network and R8 data
# files have no cluster.
package prod

import rego.v1

cluster_stack if input.cluster_name

deny contains msg if {
	input.gpu_preemptible == true
	msg := "prod sizing must not set gpu_preemptible = true (ADR-0007)"
}

deny contains msg if {
	input.public_endpoint == true
	msg := "prod sizing must not turn the public control-plane endpoint on"
}

deny contains msg if {
	input.etcd_cluster_size
	input.etcd_cluster_size != 3
	msg := "prod sizing must keep etcd_cluster_size = 3"
}

deny contains msg if {
	cluster_stack
	not input.k8s_version
	msg := "prod sizing must pin k8s_version (runbooks/upgrade.md)"
}

deny contains msg if {
	input.k8s_version == "1.36"
	msg := "prod runs N-1: 1.36 is the newest accepted version (platform/regions.yaml)"
}

deny contains msg if {
	input.filestore_forbid_deletion == false
	msg := "prod sizing must not switch filestore deletion protection off"
}

deny contains msg if {
	input.forbid_deletion == false
	msg := "prod data sizing must not switch shared-filesystem deletion protection off (docs/dr.md)"
}

deny contains msg if {
	input.enable_nat == false
	msg := "prod network sizing keeps the NAT gateway: without it nodes in the workload subnet have no egress at all"
}

deny contains msg if {
	input.alertmanager_enabled == false
	msg := "prod sizing must not switch Alertmanager off"
}

deny contains msg if {
	input.audit_logs == false
	msg := "prod sizing must not switch audit logs off"
}

deny contains msg if {
	input.labels["nip-ttl-expires"]
	msg := "prod resources carry no TTL: nothing in prod expires by label"
}
