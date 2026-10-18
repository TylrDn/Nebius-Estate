# Compatibility matrix

Generated from [`platform/versions.yaml`](../platform/versions.yaml) by `make compat-matrix`. Do not edit by hand.

Every row is a value this repo pins and the date it was last checked against its source.
No row is a Nebius support statement; re-verify before quoting to a customer (P6).

| Component | Version / ref | Install method | Verified | Notes / source |
|---|---|---|---|---|
| `terraform / cli` | 1.16.5 |  | 2026-10-11 | Newest stable at verification. 1.11-1.15 test harnesses refuse an apply run that leaves an ephemeral variable unset, which the SecretStash apply-refusal tests need (fixed in 1.16.0); configurations still require only >= 1.11 — [source](https://releases.hashicorp.com/terraform/) |
| `terraform / providers / nebius/nebius` | 0.6.67 |  | 2026-10-09 | [source](https://registry.terraform.io/providers/nebius/nebius) |
| `terraform / providers / hashicorp/helm` | 3.3.0 |  | 2026-10-09 | [source](https://registry.terraform.io/providers/hashicorp/helm) |
| `terraform / providers / hashicorp/kubernetes` | 3.3.0 |  | 2026-10-09 | [source](https://registry.terraform.io/providers/hashicorp/kubernetes) |
| `terraform / providers / gavinbunney/kubectl` | 1.19.0 |  | 2026-10-09 | [source](https://registry.terraform.io/providers/gavinbunney/kubectl) |
| `terraform / providers / dstaroff/units` | 1.1.1 |  | 2026-10-09 | [source](https://registry.terraform.io/providers/dstaroff/units) |
| `terraform / providers / hashicorp/random` | 3.9.1 |  | 2026-10-09 | [source](https://registry.terraform.io/providers/hashicorp/random) |
| `tooling / toolbox-base` | 3.13.16-slim-trixie |  | 2026-10-12 | toolbox base: Python 3.13 for the repo scripts (stdlib only) — [source](https://hub.docker.com/_/python) |
| `tooling / portal-node` | 24.22.0-trixie-slim |  | 2026-10-18 | the portal image (portal/packages/backend/Dockerfile) and the CI portal job; portal/.nvmrc pins 24.22.0 (native SQLite cleanup fix) — [source](https://hub.docker.com/_/node) |
| `tooling / terraform` | 1.16.5 |  | 2026-10-11 | every root except the Soperator recipe; above upstream CI (1.11.4) because terraform test before 1.16.0 cannot run an apply with an ephemeral variable unset (stacks/data, stacks/ml-services, modules/o11y) — [source](https://releases.hashicorp.com/terraform/1.16.5/) |
| `tooling / terraform-soperator` | 1.12.2 |  | 2026-10-10 | the Soperator recipe requires >= 1.12; installed as terraform-soperator in the toolbox — [source](https://releases.hashicorp.com/terraform/1.12.2/) |
| `tooling / tflint` | 0.64.0 |  | 2026-10-10 | [source](https://github.com/terraform-linters/tflint/releases/tag/v0.64.0) |
| `tooling / conftest` | 0.71.1 |  | 2026-10-12 | OPA policy checks over platform/stages.yaml and the sizing files (policy/) — [source](https://github.com/open-policy-agent/conftest/releases/tag/v0.71.1) |
| `tooling / kubectl` | 1.35.9 |  | 2026-10-10 | within the supported skew of the 1.34-1.36 clusters; kustomize builds — [source](https://dl.k8s.io/release/v1.35.9/bin/linux/amd64/kubectl) |
| `tooling / shellcheck` | 0.11.0 |  | 2026-10-10 | [source](https://github.com/koalaman/shellcheck/releases/tag/v0.11.0) |
| `tooling / trivy` | 0.75.0 |  | 2026-10-12 | IaC/config scan (make scan) — [source](https://github.com/aquasecurity/trivy/releases/tag/v0.75.0) |
| `tooling / gitleaks` | 8.30.1 |  | 2026-10-10 | [source](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1) |
| `tooling / jq` | 1.8.2 |  | 2026-10-10 | [source](https://github.com/jqlang/jq/releases/tag/jq-1.8.2) |
| `tooling / lychee` | 0.24.2 |  | 2026-10-10 | Markdown link check (make links) — [source](https://github.com/lycheeverse/lychee/releases/tag/lychee-v0.24.2) |
| `tooling / nebius_cli` | 0.12.287 |  | 2026-10-10 | deploy pipeline and operator commands; the documented install.sh resolves stable at run time, so it is not used — [source](https://artifacts.nebius.cloud/cli/release/0.12.287/linux/x86_64/nebius) |
| `tooling / actions-checkout` | 4.4.0 |  | 2026-10-10 | the only third-party action; pinned by commit — [source](https://github.com/actions/checkout/releases/tag/v4.4.0) |
| `upstream / nebius-solutions-library` | d1c15caa37d330db88cb20bfef8dfceee4852032 |  | 2026-10-09 | Release tag (2026-10-07), baseline for mirrored modules and Soperator; separate GB300 reference below — [source](https://github.com/nebius/nebius-solutions-library) |
| `upstream / nebius-solutions-library-gb300` | fba7148cecd8bd38bccf60ba194ab8f5fdb02194 |  | 2026-10-17 | Separate NVL/GB300 design reference, not the Soperator release baseline — [source](https://github.com/nebius/nebius-solutions-library/blob/fba7148cecd8bd38bccf60ba194ab8f5fdb02194/k8s-training/gb300.tf) |
| `upstream / serverless-ai-cookbook` | 6c150ce951dac480177af09116ec53d9c2fa7670 |  | 2026-10-09 | nebius ai endpoint/job CLI patterns copied by recipes/serverless — [source](https://github.com/nebius/serverless-ai-cookbook) |
| `upstream / nebius-physical-ai` | c76fe41 |  | 2026-10-09 | team namespace + SkyPilot pattern (recipes/team-platform); pins skypilot[nebius,kubernetes]==0.12.2 — [source](https://github.com/nebius/nebius-physical-ai) |
| `upstream / soperator` | 4.1.13 |  | 2026-10-09 | main carries VERSION=5.0.0 (unreleased); recipe needs Terraform >= 1.12 and helm < 3 (own root); see docs/soperator-compatibility.md — [source](https://github.com/nebius/soperator/releases/tag/4.1.13) |
| `upstream / soperator-recipe-providers / nebius/nebius` | 0.6.67 |  | 2026-10-10 | Soperator root (terraform/stacks/soperator) lock file; the recipe's own constraints float — [source](https://registry.terraform.io/providers/nebius/nebius) |
| `upstream / soperator-recipe-providers / hashicorp/helm` | 2.17.0 |  | 2026-10-10 | the recipe requires helm < 3; the rest of the repo uses 3.3.0 — [source](https://registry.terraform.io/providers/hashicorp/helm) |
| `upstream / soperator-recipe-providers / hashicorp/kubernetes` | 3.3.0 |  | 2026-10-10 | [source](https://registry.terraform.io/providers/hashicorp/kubernetes) |
| `upstream / soperator-recipe-providers / fluxcd/flux` | 1.9.6 |  | 2026-10-10 | [source](https://registry.terraform.io/providers/fluxcd/flux) |
| `upstream / soperator-recipe-providers / hashicorp/local` | 2.5.3 |  | 2026-10-10 | [source](https://registry.terraform.io/providers/hashicorp/local) |
| `upstream / soperator-recipe-providers / dstaroff/units` | 1.1.1 |  | 2026-10-10 | [source](https://registry.terraform.io/providers/dstaroff/units) |
| `upstream / soperator-recipe-providers / random-things/string-functions` | 0.5.0 |  | 2026-10-10 | [source](https://registry.terraform.io/providers/random-things/string-functions) |
| `platform / gpu_driver_preset` | cuda13.0 |  | 2026-10-09 | Managed driver image (driver 580.x, Ubuntu 24.04); cuda12.8 = 570.x — [source](https://docs.nebius.com/kubernetes/gpu/set-up) |
| `platform / nvidia-gpu-operator` | managed by Nebius Marketplace | Marketplace nebius/nvidia-gpu-operator | 2026-10-09 | nebius-solutions-library/modules/gpu-operator |
| `platform / nvidia-network-operator` | managed by Nebius Marketplace | Marketplace nebius/nvidia-network-operator | 2026-10-09 | stacks/training only; installed before the GPU Operator — nebius-solutions-library/modules/network-operator |
| `platform / region-platform-table` | platform/regions.yaml |  | 2026-10-09 | Fabrics, 1-GPU/8-GPU presets and driver presets per region and platform (H100, H200, B200, B300, L40S); consumed by the Terraform roots — [source](https://docs.nebius.com/compute/clusters/gpu) |
| `platform / filesystem-csi` | 0.1.10 | oci://cr.eu-north1.nebius.cloud/mk8s/helm/csi-mounted-fs-path | 2026-10-09 | The docs' chart; the upstream recipe still pins 0.1.5. cloud-init mounts with defaults,nofail as the docs require — [source](https://docs.nebius.com/kubernetes/storage/filesystem-over-csi) |
| `platform / nvidia-device-plugin` | managed by Nebius Marketplace | Marketplace nebius/nvidia-device-plugin | 2026-10-09 | Driver-image path (ADR-0003); dcgm-exporter enabled — nebius-solutions-library/modules/device-plugin |
| `platform / grafana-and-prometheus` | managed by Nebius Marketplace | Marketplace nebius/grafana-and-prometheus | 2026-10-09 | nebius-solutions-library/modules/o11y/prometheus.tf |
| `platform / nebius-observability-agent` | managed by Nebius Marketplace | Marketplace nebius/nebius-observability-agent | 2026-10-09 | nebius-solutions-library/modules/o11y/nebius_o11y_agent.tf |
| `workloads / vllm` | v0.31.0 |  | 2026-10-09 | Latest stable tag on Docker Hub at verification (published 2026-10-04); manifest-list digest, amd64 sha256:a4a4c043... — [source](https://hub.docker.com/r/vllm/vllm-openai/tags) |
| `workloads / qwen2.5-1.5b-instruct` | 989aa7980e4cf806f80c7fef2b1adb7bc71aa306 |  | 2026-10-09 | Apache-2.0; default lab model — [source](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct) |
| `workloads / qwen2.5-7b-instruct` | a09a35458c702b33eeacc393d103063234e8bc28 |  | 2026-10-09 | Apache-2.0; representative size — [source](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct) |
| `workloads / nccl-tests-image-h100-h200` | 2.23.4-ubu22.04-cu12.4 |  | 2026-10-09 | H100/H200 tab of the NCCL-test doc; workloads/training/nccl/base — [source](https://docs.nebius.com/kubernetes/gpu/nccl-test) |
| `workloads / nccl-tests-image-b200` | 2.26.5-ubu22.04-cu12.8 |  | 2026-10-09 | B200 tab (adds -mca coll ^hcoll); workloads/training/nccl/components/b200. No B300 manifest in the doc yet — [source](https://docs.nebius.com/kubernetes/gpu/nccl-test) |
| `workloads / kubeflow-training-operator` | v1.9.3 |  | 2026-10-09 | MPIJob/PyTorchJob CRDs; installed by workloads/training/install-training-operator.sh at ref, the commit tag v1.9.3 pointed to on 2026-10-11 (git ls-remote) — [source](https://docs.nebius.com/kubernetes/gpu/nccl-test) |
| `workloads / kueue` | v0.20.1 |  | 2026-10-11 | R16 workloads/kueue: install.sh applies the release manifests.yaml (sha256 of that asset) server-side; v1beta2 API only (v0.20 no longer serves v1beta1); TopologyAwareScheduling beta and on by default since v0.14 — [source](https://github.com/kubernetes-sigs/kueue/releases/tag/v0.20.1) |
| `workloads / rclone` | 1.75.2 |  | 2026-10-11 | workloads/data/copy-job: stage a bucket prefix onto the shared filesystem, also the filesystem restore path (runbooks/data.md, runbooks/backup-restore.md) — [source](https://hub.docker.com/r/rclone/rclone/tags) |
| `workloads / pytorch` | 2.14.1-cuda13.0-cudnn9-runtime |  | 2026-10-09 | Pinned by digest in workloads/training/ddp/pytorchjob.yaml — [source](https://hub.docker.com/r/pytorch/pytorch/tags) |
| `validation_images / nvidia-cuda-base` | 13.0.1-base-ubuntu24.04 |  | 2026-10-09 | tests/validate/01-gpu.sh nvidia-smi probe for cuda13.0 presets (580.x) — [source](https://hub.docker.com/r/nvidia/cuda/tags) |
| `validation_images / nvidia-cuda-base-12-8` | 12.8.1-base-ubuntu24.04 |  | 2026-10-10 | tests/validate/01-gpu.sh fallback probe for cuda12.8 presets chosen explicitly (570.x; no platform defaults to it) — [source](https://hub.docker.com/r/nvidia/cuda/tags) |
| `validation_images / fio` | 3.13 |  | 2026-10-10 | tests/validate/03-storage.sh; the previously pinned 3.33 tag does not exist. 3.13 (2019) is the newest published tag of the most-used fio image; a seq-write probe needs nothing newer — [source](https://hub.docker.com/r/xridge/fio/tags) |
| `validation_images / curl` | 8.22.0 |  | 2026-10-11 | tests/validate/network.sh egress probe (R7): the source IP an echo endpoint sees must be the NAT VM's — [source](https://hub.docker.com/r/curlimages/curl/tags) |
| `validation_images / busybox` | 1.36.1 |  | 2026-10-10 | node debug pods (03-storage.sh) and the NCCL MPIJob init containers — [source](https://hub.docker.com/_/busybox) |
| `validation_images / crane` | v0.22.1-debug |  | 2026-10-12 | R12 check Job (workloads/ml-services/check-job): push to and pull from Container Registry; the debug variant carries a busybox shell — [source](https://github.com/google/go-containerregistry/releases/tag/v0.22.1) |
| `validation_images / mlflow-client` | v2.21.2 |  | 2026-10-12 | R12 check Job: logs and reads back one MLflow run; the version Managed MLflow reported on the 2026-10-11 run — [source](https://github.com/mlflow/mlflow/pkgs/container/mlflow) |
| `validation_images / postgres-client` | 16.10-alpine3.22 |  | 2026-10-12 | R12 check Job: psql select 1 over sslmode=verify-full; Managed PostgreSQL offers version 16 only — [source](https://hub.docker.com/_/postgres) |
| `validation_images / aws-cli` | 2.37.4 |  | 2026-10-12 | R8 restore drill from the operator host (scripts/live/bin/aws for tests/validate/checkpoint-restore.sh): the S3 client in a container, nothing installed on the host; used live 2026-10-12 — [source](https://hub.docker.com/r/amazon/aws-cli/tags) |
| `recipes / skypilot` | 0.12.2 |  | 2026-10-09 | nebius-physical-ai/docs/orchestration/skypilot-setup.md |
