# InfiniBand GPU cluster: nodes placed in it share one fabric and can run
# multi-node collectives at IB speed. Node groups join via template.gpu_cluster
# and MUST use an 8-GPU preset. Mirrors k8s-training/gpu_cluster.tf @ soperator-v4.1.13-2 (d1c15ca).

resource "nebius_compute_v1_gpu_cluster" "this" {
  parent_id         = var.parent_id
  name              = var.name
  infiniband_fabric = var.infiniband_fabric
  labels            = var.labels
}
