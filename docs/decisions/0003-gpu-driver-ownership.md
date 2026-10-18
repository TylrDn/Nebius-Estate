# ADR 0003: GPU driver installation ownership

- **Status:** accepted (revised 2026-10-10; supersedes the 2026-10-09 text that put training on the operator path)
- **Date:** 2026-10-09
- **Owner:** platform

## Context
Two supported ways to get CUDA drivers on managed-Kubernetes GPU nodes
(https://docs.nebius.com/kubernetes/gpu/set-up):

1. **Managed driver image**: set `gpu_settings.drivers_preset` (`cuda12.8` → driver 570.x,
   `cuda13.0` → 580.x, Ubuntu 24.04) on the node group; install only the NVIDIA device
   plugin (Marketplace `nebius/nvidia-device-plugin`). The docs recommend this path and say
   to create a *new* node group with the image rather than switch an existing one.
2. **Operators**: no preset; install the NVIDIA Network Operator, wait for its `state-OFED`
   to become ready, then the GPU Operator from the Marketplace; the operators manage
   drivers, toolkit, device plugin, DCGM and MIG. The docs' pinned charts are Network
   Operator 25.7.0 and GPU Operator v25.10.0, with `driver.version=580.95.05` on B300.

The docs require the Network Operator **only** when a node group does *not* use the managed
image *and* uses B200 or an InfiniBand GPU cluster; "in all other cases, NVIDIA Network
Operator is optional". Their own InfiniBand example creates the node group with
`--template-gpu-settings-drivers-preset cuda13.0` and `--template-gpu-cluster-id`, i.e.
option 1 with a GPU cluster. The upstream `k8s-training` recipe defaults to option 2
(`gpu_nodes_driverfull_image = false`) because it also carries MIG/CDI options; the live
lab run of 2026-10-08 used option 1 on a B300 (`docs/evidence/2026-10-08-mk8s-b300-gpu-smoke.md`).

## Options considered
1. Managed driver image + device plugin everywhere; operators opt-in.
2. Image for inference, operators for training (the 2026-10-09 decision, on the belief that
   the Network Operator was required for InfiniBand — it is not).
3. Operators everywhere (the upstream recipe default).

## Decision and rationale
Option 1:
- `stacks/inference` and `stacks/training` both use the managed image (`platform/regions.yaml` picks
  `cuda13.0` on every platform) plus the device plugin with the DCGM exporter. Fewer
  moving parts, nodes boot with drivers, the docs' recommendation, and the path that ran live.
- `stacks/training` keeps the operator path behind `enable_gpu_operator = true` for the cases
  that need it: MIG (`mig_strategy`), CDI, or a custom device plugin. It then installs the
  Network Operator, polls `NicClusterPolicy` until `state-OFED` is ready
  (`scripts/wait-for-ofed.sh`; `depends_on` alone only orders the creates), then the GPU
  Operator with the platform's `operator_driver_version` from `platform/regions.yaml`
  (580.95.05 on B300) unless overridden. The Marketplace releases carry no chart version to
  pin; the docs' chart versions are recorded in `platform/versions.yaml`.
- Never both on one node group (`modules/node-group` sets `gpu_settings` only when a preset
  is given; the roots install either the device plugin or the operators, never both).

## Evidence
- docs page above (verified 2026-10-09; the Network Operator rule and the IB example quoted).
- upstream `k8s-training/locals.tf` (`device_preset`, `platform_to_cuda`) and `helm.tf`
  (device-plugin vs gpu-operator switch) @ `soperator-v4.1.13-2` (`d1c15ca`).
- live: `docs/evidence/2026-10-08-mk8s-b300-gpu-smoke.md` (driver 580.173.02 from the
  `cuda13.0` image, NCCL 2.27.7 initialised, bf16 matmul on B300).

## Security and cost consequences
Driver CVEs on the image path are fixed by rolling to a new node group with a newer preset
(immutable image, a rolling replace of every node); on the operator path by an operator
upgrade in place. Cost identical. Operator path caveat: nodes join without drivers, so the
cluster autoscaler can over-provision while both operators initialise (upstream notes).

## Failure modes and recovery
Mixed paths → duplicate device plugins / driver conflicts. Recovery: delete the extra
installer, or recreate the node group. Operator path: GPU Operator installed before
`state-OFED` is ready → driver pods crash-loop; wait, then restart the GPU Operator's driver
DaemonSet. See `runbooks/incident.md`.

## Notes

- 2026-10-11: B200 moved from `cuda12.8` to `cuda13.0`. The boot-disk-images page says the
  B200 `1gpu-20vcpu-224gb` preset "requires driver version 580.x or newer" and recommends the
  CUDA 13 image for both B200 platforms
  ([images for GPU VMs](https://docs.nebius.com/compute/storage/boot-disk-images#images-for-gpu-vms)).
  `cuda12.8` (570.x) stays accepted as an explicit opt-in on other platforms.
- 2026-10-11, to verify on the next live run: the set-up page ties "modify the NVIDIA device
  plug-in" to disabling the managed driver option, and the NCCL tutorial requests
  `nvidia.com/gpu` without installing a plugin, which suggests the managed image already runs a
  device plugin. Check `kubectl get ds -A | grep -i nvidia` on a group with only
  `drivers_preset` set before keeping `modules/device-plugin` on that path.
  Partly answered by the 2026-10-11 sandbox runs (`gpu-l40s-a`, `drivers_preset` `cuda13.0` from
  `platform/regions.yaml:37`, with `modules/device-plugin` installed): `nvidia.com/gpu` allocatable = 1
  once the GPU node was untainted ([populate evidence](../evidence/2026-10-11-sandbox-inference-populate.md)).
  Still open: no run recorded `kubectl get ds -A` on a group *without* `modules/device-plugin`, so
  whether the managed image runs its own plugin is unverified; keep the module until that is checked.

## Portability constraints
The image path is Nebius-specific; the operator path is the portable NVIDIA path.

## Review trigger
A workload needs MIG, CDI, or a CUDA version the presets don't offer; or the docs change the
Network Operator rule.
