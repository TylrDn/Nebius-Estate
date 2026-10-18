mock_provider "helm" {}
mock_provider "kubernetes" {}

variables {
  mount_path = "/mnt/data"
}

run "tolerates_the_gpu_taint_by_default" {
  command = plan

  assert {
    condition     = contains([for s in helm_release.csi.set : "${s.name}=${s.value}"], "tolerations[0].key=nvidia.com/gpu") && contains([for s in helm_release.csi.set : "${s.name}=${s.value}"], "tolerations[0].effect=NoSchedule")
    error_message = "the CSI node DaemonSet must tolerate nvidia.com/gpu or RWX PVCs cannot mount on GPU nodes (R1-8)"
  }
  assert {
    condition     = contains([for s in helm_release.csi.set : "${s.name}=${s.value}"], "dataDir=/mnt/data/csi-mounted-fs-path-data/")
    error_message = "dataDir must point under the mount path"
  }
}

run "docs_chart_and_version" {
  command = plan

  assert {
    condition     = helm_release.csi.repository == "oci://cr.eu-north1.nebius.cloud/mk8s/helm" && helm_release.csi.version == "0.1.10"
    error_message = "chart and version must match https://docs.nebius.com/kubernetes/storage/filesystem-over-csi"
  }
}
