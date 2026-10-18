# Policy over terraform/live/prod/soperator/stage.tfvars (HCL2): the Soperator prod layer.
package soperator_prod

import rego.v1

deny contains msg if {
	input.production != true
	msg := "prod Soperator must set production = true (the recipe's merge-request gate)"
}

deny contains msg if {
	input.filestore_jail.spec.forbid_deletion != true
	msg := "the prod jail must be deletion-protected"
}

deny contains msg if {
	some m in input.filestore_jail_submounts
	m.spec.forbid_deletion != true
	msg := sprintf("prod jail submount %q must be deletion-protected", [m.name])
}

deny contains msg if {
	input.backups_enabled == "force_disable"
	msg := "prod Soperator keeps backups on (docs/dr.md)"
}
