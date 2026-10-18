# Policy over the R16 Kueue manifests (workloads/kueue): the rendered overlay of one stage, the
# sample job and platform/stages.yaml, passed together with `conftest test --combine` (Makefile
# `policy`), so `input` is a list of {path, contents}. It catches the wiring mistakes Kueue would
# only report on a live cluster (a queue naming a flavor that does not exist, a job asking for a
# topology level no Topology has) and keeps the team quotas inside the stage's GPU cap.
# Run under namespace "kueue".
package kueue

import rego.v1

# Every Kubernetes object in the inputs (a multi-document YAML file parses to a list).
docs contains d if {
	some f in input
	is_array(f.contents)
	some d in f.contents
	is_object(d)
	d.kind
}

docs contains d if {
	some f in input
	is_object(f.contents)
	f.contents.kind
	d := f.contents
}

stage_file := f.contents if {
	some f in input
	is_object(f.contents)
	f.contents.stages
}

kueue_objects contains d if {
	some d in docs
	startswith(d.apiVersion, "kueue.x-k8s.io/")
}

topologies[name] := levels if {
	some d in docs
	d.kind == "Topology"
	name := d.metadata.name
	levels := [l.nodeLabel | some l in d.spec.levels]
}

flavors[d.metadata.name] := d if {
	some d in docs
	d.kind == "ResourceFlavor"
}

cluster_queues[d.metadata.name] := d if {
	some d in docs
	d.kind == "ClusterQueue"
}

local_queues[key] := d if {
	some d in docs
	d.kind == "LocalQueue"
	key := sprintf("%s/%s", [d.metadata.namespace, d.metadata.name])
}

# Node labels Nebius sets for topology-aware scheduling, plus the node itself
# (https://docs.nebius.com/kubernetes/gpu/topology-aware-scheduling#how-to-view-topology-labels-in-your-cluster).
nebius_levels := {
	"topology.nebius.com/gpu-cluster-id",
	"topology.nebius.com/tier-0",
	"topology.nebius.com/tier-1",
	"topology.nebius.com/tier-2",
	"kubernetes.io/hostname",
}

all_levels contains l if {
	some levels in topologies
	some l in levels
}

tas_annotations := {"kueue.x-k8s.io/podset-required-topology", "kueue.x-k8s.io/podset-preferred-topology"}

deny contains msg if {
	some d in kueue_objects
	d.apiVersion != "kueue.x-k8s.io/v1beta2"
	msg := sprintf("%s %s uses %s: the pinned Kueue serves kueue.x-k8s.io/v1beta2 only (platform/versions.yaml workloads.kueue)", [d.kind, d.metadata.name, d.apiVersion])
}

deny contains msg if {
	some name, levels in topologies
	some l in levels
	not l in nebius_levels
	msg := sprintf("Topology %s level %s is not a Nebius topology label (workloads/kueue/README.md)", [name, l])
}

deny contains msg if {
	some name, levels in topologies
	levels[count(levels) - 1] != "kubernetes.io/hostname"
	msg := sprintf("Topology %s must end with kubernetes.io/hostname so Kueue assigns pods to nodes", [name])
}

deny contains msg if {
	some name, f in flavors
	f.spec.topologyName
	not topologies[f.spec.topologyName]
	msg := sprintf("ResourceFlavor %s names Topology %s, which is not in the build", [name, f.spec.topologyName])
}

deny contains msg if {
	some name, f in flavors
	count(object.get(f.spec, "nodeLabels", {})) == 0
	msg := sprintf("ResourceFlavor %s has no nodeLabels: it would admit onto every node of the cluster", [name])
}

deny contains msg if {
	some name, f in flavors
	not gpu_toleration(f)
	msg := sprintf("ResourceFlavor %s must tolerate the nvidia.com/gpu taint the GPU node groups carry", [name])
}

gpu_toleration(f) if {
	some t in f.spec.tolerations
	t.key == "nvidia.com/gpu"
}

deny contains msg if {
	some name, q in cluster_queues
	some g in q.spec.resourceGroups
	some fl in g.flavors
	not flavors[fl.name]
	msg := sprintf("ClusterQueue %s uses ResourceFlavor %s, which is not in the build", [name, fl.name])
}

deny contains msg if {
	some name, q in cluster_queues
	not selects_namespaces(q)
	msg := sprintf("ClusterQueue %s needs a namespaceSelector with labels: {} admits every namespace", [name])
}

selects_namespaces(q) if count(object.get(q.spec.namespaceSelector, "matchLabels", {})) > 0

selects_namespaces(q) if count(object.get(q.spec.namespaceSelector, "matchExpressions", [])) > 0

deny contains msg if {
	some name, q in cluster_queues
	not covers_gpus(q)
	msg := sprintf("ClusterQueue %s does not cover nvidia.com/gpu", [name])
}

covers_gpus(q) if {
	some g in q.spec.resourceGroups
	"nvidia.com/gpu" in g.coveredResources
}

deny contains msg if {
	some key, lq in local_queues
	not cluster_queues[lq.spec.clusterQueue]
	msg := sprintf("LocalQueue %s points at ClusterQueue %s, which is not in the build", [key, lq.spec.clusterQueue])
}

queued_jobs contains d if {
	some d in docs
	d.kind == "Job"
	d.metadata.labels["kueue.x-k8s.io/queue-name"]
}

deny contains msg if {
	some j in queued_jobs
	count(local_queues) > 0
	key := sprintf("%s/%s", [j.metadata.namespace, j.metadata.labels["kueue.x-k8s.io/queue-name"]])
	not local_queues[key]
	msg := sprintf("Job %s/%s submits to LocalQueue %s, which is not in the build", [j.metadata.namespace, j.metadata.name, key])
}

deny contains msg if {
	some j in queued_jobs
	annotations := object.get(j.spec.template.metadata, "annotations", {})
	count({k | some k in tas_annotations; annotations[k]}) == 0
	msg := sprintf("Job %s/%s asks for no topology: set kueue.x-k8s.io/podset-required-topology or -preferred-topology", [j.metadata.namespace, j.metadata.name])
}

deny contains msg if {
	some j in queued_jobs
	some k in tas_annotations
	level := j.spec.template.metadata.annotations[k]
	count(topologies) > 0
	not level in all_levels
	msg := sprintf("Job %s/%s asks for topology level %s, which no Topology in the build has", [j.metadata.namespace, j.metadata.name, level])
}

deny contains msg if {
	some j in queued_jobs
	some c in j.spec.template.spec.containers
	req := object.get(object.get(c.resources, "requests", {}), "nvidia.com/gpu", 0)
	lim := object.get(object.get(c.resources, "limits", {}), "nvidia.com/gpu", 0)
	to_number(req) != to_number(lim)
	msg := sprintf("Job %s/%s container %s: nvidia.com/gpu request and limit must be equal (extended resources are not overcommitted)", [j.metadata.namespace, j.metadata.name, c.name])
}

# The cohort's nominal GPUs fit the stage: sum over ClusterQueues <= max_gpu_nodes.training x 8.
cq_stages := {s | some q in cluster_queues; s := object.get(object.get(q.metadata, "labels", {}), "nip.nebius.io/stage", "")}

nominal_gpus := sum([to_number(r.nominalQuota) |
	some q in cluster_queues
	some g in q.spec.resourceGroups
	some fl in g.flavors
	some r in fl.resources
	r.name == "nvidia.com/gpu"
])

deny contains msg if {
	count(cluster_queues) > 0
	count(cq_stages) != 1
	msg := sprintf("every ClusterQueue needs the same nip.nebius.io/stage label (an overlays/<stage> build); found %v", [cq_stages])
}

deny contains msg if {
	count(cluster_queues) > 0
	not stage_file
	msg := "platform/stages.yaml must be passed with the manifests (conftest test --combine)"
}

deny contains msg if {
	some stage in cq_stages
	cap := object.get(stage_file.stages[stage].policy.max_gpu_nodes, "training", 0) * 8
	nominal_gpus > cap
	msg := sprintf("the ClusterQueues promise %d GPUs in %s, above max_gpu_nodes.training x 8 = %d (platform/stages.yaml)", [nominal_gpus, stage, cap])
}
