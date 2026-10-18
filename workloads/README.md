# Layer 3 — Workloads

Kubernetes manifests per recipe, applied with `kubectl apply -k` separately from platform
changes (P5). Each pins its image by digest (`platform/versions.yaml`, checked by `make pins`),
its resource requests and limits, and its model or artifact versions; `make kustomize` builds
every overlay in CI.

- [`inference/`](inference/) — vLLM model server for R1 (Kubernetes for inference).
- [`training/`](training/) — NCCL validation and a DDP job for R3 (after NCCL validation).
- [`data/copy-job/`](data/copy-job/) — stages an Object Storage prefix onto the shared filesystem for R8.
- [`kueue/`](kueue/README.md) — team queues with topology-aware placement on R3's InfiniBand GPU nodes (R16); `install.sh` installs the pinned Kueue.
- [`components/ingress-isolation/`](components/ingress-isolation/) — namespace ingress isolation shared by the job and team namespaces.

GPU pods select `nip.nebius.io/gpu: "true"` and tolerate `nvidia.com/gpu=present:NoSchedule`, the
label and taint the inference and training stacks put on their GPU node groups. Jobs queued through Kueue get
both from the ResourceFlavor at admission instead.
