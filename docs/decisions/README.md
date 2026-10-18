# Architecture decision records

Copy [`0000-template.md`](0000-template.md) to `NNNN-short-title.md` and add a row here. When a decision
changes, add a dated note under its header (as in 0001, 0004, 0005 and 0009) or supersede it with a new
ADR; never rewrite the original reasoning.

| ADR | Title | Status | Decision in one line |
|---|---|---|---|
| [0001](0001-kubernetes-vs-serverless.md) | Kubernetes vs. managed endpoints / serverless | accepted | Kubernetes when the customer needs runtime control, a serverless endpoint when they need none of it |
| [0002](0002-inference-vs-training-topology.md) | Inference vs. training topology | accepted | Separate stacks: single-GPU serving nodes vs. 8-GPU InfiniBand training nodes |
| [0003](0003-gpu-driver-ownership.md) | Driver installation ownership | accepted (revised) | Managed driver image + device plugin by default; GPU/Network Operators opt-in |
| [0004](0004-storage-design.md) | Storage design | accepted | Shared Filesystem + CSI as the model cache; Object Storage as system of record |
| [0005](0005-terraform-state-boundaries.md) | Terraform state boundaries | accepted | One state per live root, versioned bucket per stage, bucket-scoped identity |
| [0006](0006-reconciler-ownership.md) | Reconciler ownership (Terraform vs. GitOps vs. kubectl) | accepted | Terraform owns infrastructure and platform, kubectl owns workloads, Flux only for Soperator |
| [0007](0007-capacity-on-demand-vs-preemptible.md) | On-demand vs. interruptible (spot) capacity | accepted | Preemptible only where restartable; serving on-demand outside the sandbox |
| [0008](0008-slurm-scheduler-and-soperator.md) | Scheduler choice for HPC users (Slurm via Soperator) | proposed | Soperator when users already depend on Slurm, behind three gates (pinned release, identity/partitions, scale-down drill) |
| [0009](0009-environment-and-promotion-model.md) | Environment and promotion model | accepted | Stage × stack, one project per stage, generated live roots, policy enforced in the stacks |
