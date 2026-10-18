# Soperator 4.1.13 — compatibility and limitations report

Pinned release: **Soperator `4.1.13`** (README and `docs/limitations.md` at that tag disagree on **five** points: node types, CUDA, OS, Kubernetes minimum, LDAP), Terraform recipe `nebius-solutions-library` tag
`soperator-v4.1.13-2` (`soperator/VERSION` = 4.1.13, SUBVERSION 2). Verified 2026-10-09
against the files at those tags. `main` carries `VERSION=5.0.0`, unreleased: never pin `main`.

## What the release documents support

| Area | README @ 4.1.13 | docs/limitations.md @ 4.1.13 | Resolution before a customer commitment |
|---|---|---|---|
| Node types | "GPU-only **or CPU-only**; mixed nodesets not implemented" | "**GPUs are required**; CPU-only is being worked on" | The two documents disagree, and the limitations page is stale: a CPU-only worker (`cpu-d3 8vcpu-32gb`) ran `sbatch` to completion on 4.1.13 on 2026-10-08 ([raw output](evidence/raw/2026-10-08-soperator-4.1.13/20261008T015549Z.md)). Treat CPU-only as working but ask Nebius whether it is *supported*. |
| CUDA | **12.9** | **12.4.1** | Disagree. The worker image decides; confirm the image's CUDA for 4.1.13 and that it matches the driver preset the recipe selects (`driver_presets.tf`). |
| Slurm | 25.11.3 | 25.11.3 | Consistent between the documents; the 4.1.13 images observed in the passing run report **25.11.8** (`scontrol show nodes`, [raw output](evidence/raw/2026-10-08-soperator-4.1.13/20261008T015549Z.md)). |
| OS | **Ubuntu 24.04** | **Ubuntu 22.04** | Disagree. The worker image decides; confirm which the 4.1.13 images actually ship. |
| Kubernetes | **>= 1.31** | **>= 1.29** | Both are stale: the recipe at `soperator-v4.1.13-2` accepts **1.32–1.35 only** (`driver_presets.tf`), and Managed Kubernetes supports 1.34–1.36 (default **1.36**) and lists 1.30–1.33 as end of life ([versions](https://docs.nebius.com/kubernetes/versions), verified 2026-10-10). `profiles/lab.tfvars` pins `k8s_version = "1.35"`; the next Soperator release must land before 1.35 leaves support. |
| Partitions | — | **Single-partition** clusters only | The recipe's own default (`main` + the hidden check partition) ran on 4.1.13 (`sinfo` in the evidence above), so "single partition" means one *user* partition. Several user partitions are unverified; decide whether the customer needs separate queues. |
| Scale-down | — | Deleted nodes stay in the controller's memory (`sinfo`); remove with `scontrol` | Test it (`runbooks/soperator-jobs.md` step 5); do not assume scale-down mirrors scale-up. |
| Identity | **SSSD support**: "integrate Slurm with centralized identity providers such as LDAP, Active Directory, or FreeIPA" (`docs/sssd.md`) | **"Slurm integration with LDAP isn't supported"**; Linux users/groups only | Direct conflict on the customer gate that matters most. The recipe exposes `slurm_sssd_enabled` + `slurm_sssd_conf_secret_ref_name`; treat SSSD as *available but unverified* until a test against the customer's directory passes. |
| Slurm config | — | Limited to what the operator exposes; some sysctl not configurable | Collect the customer's `slurm.conf` must-haves and map each to a recipe variable or reject. |
| Low-level software | — | CUDA/driver/toolkit/enroot versions fixed per image | Upgrades are operator releases, not in-place. |
| Clouds | — | Nebius-only Terraform recipe | Portability constraint. |

## How the recipe installs (ADR-0006)

Terraform creates the cluster and node groups, installs Flux, then the `soperator-fluxcd`
bootstrap chart from `oci://cr.nebius.cloud/soperator`; Flux reconciles the Soperator
`HelmRelease`s and Terraform waits for the `SlurmCluster` to become Available. Nothing else
in this repo may touch those releases.

## Recipe-specific notes (tag `soperator-v4.1.13-2`)

- Requires Terraform `>= 1.12` and `helm < 3.0.0`: it runs in its own root with its own
  provider set (`terraform/stacks/soperator`), never alongside `stacks/inference` or `stacks/training`.
- `public_o11y_enabled = true` by default and the example `.envrc` hard-codes a telemetry
  tenant; `profiles/lab.tfvars` disables it.
- The example `.envrc` creates `slurm-terraform-sa` and an Object Storage key; we use
  `scripts/bootstrap-backend.sh <stage> soperator` instead (same pattern, our naming, ADR-0005).
- Attaching an existing filesystem as the **jail overwrites its data**; use submounts for
  customer data (upstream README warning). The example `terraform.tfvars` attaches the jail and
  its submount by a **placeholder id** (`computefilesystem-<YOUR-FILESTORE-ID>`), which fails on
  apply; `profiles/lab.tfvars` creates both from a `spec` (prod's `stage.tfvars` sets `forbid_deletion`) and the mocked test rejects any placeholder.
- **AppArmor:** with `use_default_apparmor_profile = true` (the recipe default) the login and
  worker pods stayed in `CreateContainerError` on four consecutive live runs on 2026-10-07/08
  because the profile was never loaded on the nodes ([raw output](evidence/raw/2026-10-08-soperator-4.1.13/)).
  `profiles/lab.tfvars` sets it to `false`, which leaves the Slurm chart at `appArmorProfile: unconfined`.
  Trade-off: no AppArmor confinement of the Slurm containers. For production, fix the root cause
  (confirm the Security Profiles Operator loads the profile on every node image) and switch it
  back on; record the test in `docs/evidence/`.
- **Active checks:** `active_checks_scope = "essential"` makes `ensure-healthy-nodes` depend on
  GPU checks the scope disables, so the recipe's 240-minute wait never finishes; and with
  `accounting_enabled = false` Soperator creates no Slurm REST API, so slurmJob checks cannot
  report at all. Two `*_override.tf` files under `terraform/stacks/soperator/overrides/` narrow the
  dependency and skip the wait when accounting is off; `sbatch` is then the health gate.
- **Telemetry off still renders monitoring objects** (four ServiceMonitors and the dashboards
  release) at 4.1.13, which breaks the `soperator` HelmRelease without the Prometheus CRDs. The
  monitoring override switches them off through the recipe's own values ConfigMaps.
- Upstream CI tests the recipe end-to-end on Nebius; this repo only validates it statically.

## Evidence

- https://raw.githubusercontent.com/nebius/soperator/4.1.13/README.md (also `/docs/limitations.md`, `/VERSION` at the same tag; the github.com views of this repo time out for the link checker, checked 2026-10-10)
- `nebius-solutions-library` @ `soperator-v4.1.13-2`: `soperator/VERSION`, `SUBVERSION`,
  `installations/example/{terraform.tf,main.tf,terraform.tfvars,.envrc}`
