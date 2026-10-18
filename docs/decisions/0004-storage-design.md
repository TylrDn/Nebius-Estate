# ADR 0004: Storage for model artifacts and shared data

- **Status:** accepted
- **Date:** 2026-10-09
- **Owner:** platform
- **Note (2026-10-11):** "not protected from deletion" now holds for sandbox only: staging and prod set
  `forbid_deletion` through the stage policy ([ADR-0009](0009-environment-and-promotion-model.md)). R8
  (`terraform/stacks/data`) adds a long-lived dataset and checkpoint plane (versioned checkpoint bucket,
  a filesystem R1/R3 attach by ID), which is where data that must outlive a cluster belongs.

## Context
Model weights (3–15 GB for the lab models, hundreds of GB for larger ones) must be
available to every GPU node quickly and survive pod restarts. Upstream options: Filestore
(shared network filesystem attached to node groups, mounted via virtiofs, exposed to pods
through the `csi-mounted-fs-path` CSI driver), GlusterFS (legacy), Object Storage
(S3-compatible), or per-node boot/local disks.

## Options considered
1. Filestore + CSI (ReadWriteMany, upstream "recommended").
2. Object Storage pulled at pod start (no shared FS).
3. Local NVMe / boot disk cache only.

## Decision and rationale
Option 1 for the model cache (`PVC model-cache`, RWX): one download serves every replica
and every restart, and it is exactly the upstream recipe's path, including making the CSI
StorageClass the default. Object Storage remains the *system of record* for artifacts a
customer publishes; the Filestore is a cache, sized small (64 GiB)
and **not** protected from deletion so lab teardown is complete.

Upstream caveats: the CSI driver is hostPath-backed under
`<mount_path>/csi-mounted-fs-path-data/`, so capacity is not enforced per PVC, isolation
is by path only, and the filesystem **must** be attached to every node group that
schedules consumers (both node groups in `stacks/inference`).

## Evidence
`k8s-training/filesystem.tf`, `modules/cloud-init/k8s-cloud-init.tftpl` @ `soperator-v4.1.13-2` (`d1c15ca`); the CSI chart version and `nofail` follow the docs page, not the recipe;
chart `csi-mounted-fs-path` **0.1.10** from `oci://cr.eu-north1.nebius.cloud/mk8s/helm` (the docs' pin; the recipe still carries 0.1.5).

## Security and cost consequences
RWX hostPath CSI means any pod that can mount the class can read other PVCs' data; use
namespaces + RBAC on PVC creation for multi-tenant clusters. Filestore is billed by
provisioned size; keep it small and delete it with the lab.

## Failure modes and recovery
Mount missing on a node → pods Pending or I/O errors; fix cloud-init / attachment, recreate
the node group. Data loss on Filestore delete is expected for a cache; artifacts live in
Object Storage.

## Portability constraints
Replace with any RWX CSI (NFS, CephFS) on other clouds; manifests only reference the class name.

## Review trigger
Datasets > 1 TB, multi-tenant isolation requirements, or Nebius changing the CSI driver.
