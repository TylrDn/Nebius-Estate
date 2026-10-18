# Source provenance and distribution boundaries

Original contributions are Apache-2.0. Third-party material retains its own terms;
see [NOTICE](../NOTICE) and the complete texts in [third_party/licenses](../third_party/licenses/).
This inventory records observed adaptations and declared influences, not authorship
of every API field or a full history of all files. No permission is inferred from
an accessible URL, an attribution, or a product name.

## Local contribution and review scope

The project integrates these patterns through local stage policy (`platform/stages.yaml`,
`terraform/modules/stage-policy`), guarded preflight/apply/teardown and residue checks (`scripts/`),
bottom-up acceptance and load methods (`tests/validate`, `tests/load`), dated evidence, and the
custom Nebius Estate domain, frontend and backend plugins (`portal/plugins/`). These are the
project's integration contributions; they do not establish authorship of the upstream patterns,
generated Backstage scaffold, third-party packages or API contracts. The
[three flagship paths](portfolio.md) show that work with its verification limits.

For the October 17 source review, the inventory below was checked against the retained module,
NCCL and Soperator modification headers, serverless script source references, Backstage scaffold
and portal notices, all four committed Yarn patches, and the files listed in
[third_party](../third_party/README.md). This is a focused source inventory review, not a full
file-by-file history/author audit or a transitive dependency license scan. Historical refs,
release assets and build outputs still require the separate [release review](release-readiness.md).

## Adapted source and changes

NSL below means [Nebius Solutions Library at d1c15caa37d330db88cb20bfef8dfceee4852032](https://github.com/nebius/nebius-solutions-library/tree/d1c15caa37d330db88cb20bfef8dfceee4852032),
tag `soperator-v4.1.13-2`, Apache-2.0, Copyright 2024 Nebius B.V.
The complete pinned license, including its copyright appendix, is retained.

| Local material | Upstream path/ref | Local changes |
|---|---|---|
| `terraform/stacks/soperator/patches/0001-drop-iam-v1-data-sources.diff` | NSL `soperator/installations/example/main.tf` and `variables.tf` | Remove obsolete v1 IAM project/tenant lookups, use caller IDs; patch includes upstream context |
| `terraform/stacks/soperator/overrides/modules/slurm/` | NSL `soperator/modules/slurm/locals_active_checks.tf` and Helm release/template settings | Narrow essential health dependencies, avoid unavailable accounting wait, disable monitoring resources when telemetry is off; detailed reasons in override headers |
| `terraform/modules/filestore-csi/main.tf` | NSL `k8s-training/filesystem.tf` | Reusable variables/predicates, chart version, tolerations and StorageClass annotations |
| `terraform/modules/device-plugin/main.tf` | NSL `modules/device-plugin/main.tf` | Local settings map, typed settings and release content hash |
| `terraform/modules/gpu-operator/main.tf` | NSL `modules/gpu-operator/main.tf` | Conditional settings, CDI/driver controls, local map/hash; omit upstream relabel map |
| `terraform/modules/network-operator/main.tf` | NSL `modules/network-operator/main.tf` | Local settings map, typed values and release hash |
| `workloads/training/nccl/base/mpijob.yaml` | NSL `modules/nccl-test/files/helm/nccl-test/templates/nccl-test-h100.yaml` | Static name/replicas, updated pinned images, UCX interface, deadlines/backoff, worker sizing, selectors/tolerations and Kustomize overlays |
| `recipes/serverless/endpoint.sh` | [Cookbook 6c150ce951dac480177af09116ec53d9c2fa7670](https://github.com/nebius/serverless-ai-cookbook/tree/6c150ce951dac480177af09116ec53d9c2fa7670), `inference/vllm-endpoint/README.md`, Apache-2.0 | Adapt CLI entrypoint/flags; change model/image/disk and add lifecycle, safety, measurement/polling wrappers |
| `recipes/serverless/job.sh` | Same Cookbook, `quickstarts/first-job.md` | CLI workflow influence; different batch workload, lifecycle/measurement wrappers |
| `portal/packages/app/`, `portal/packages/backend/`, `portal/playwright.config.ts`, `portal/.yarnrc.yml` | [Backstage v1.55.0](https://github.com/backstage/backstage/tree/v1.55.0/packages/create-app/templates/default-app), `@backstage/create-app` 0.9.2, Apache-2.0 | Nebius Estate UI/plugin composition, selected backend plugins, build/configuration and loopback stub e2e setup |
| `portal/.yarn/releases/yarn-4.13.0.cjs` | [Yarn @yarnpkg/cli/4.13.0](https://github.com/yarnpkg/berry/tree/%40yarnpkg/cli/4.13.0), BSD-2-Clause | Bundled executable, existing embedded dependency notices retained |
| `portal/.yarn/patches/@material-table-core-npm-3.2.5-uuid-named-export.patch` | Published `@material-table/core` 3.2.5, `dist/utils/data-manager.js`, MIT | Use the named UUID v4 export; [source, hash, local changes and license](material-table-uuid-patch.md) |
| `portal/.yarn/patches/js-yaml-npm-3.15.2-argparse-version.patch` | Published `js-yaml` 3.15.2, `bin/js-yaml.js`, MIT | Register an explicit CLI version action for argparse 2; [source, local changes and license](js-yaml-argparse-patch.md) |
| `portal/.yarn/patches/backstage-*-router7.patch` | Published `@backstage/frontend-app-api` 0.16.8 and `@backstage/core-app-api` 1.20.5, `dist/routing/RouteResolver.esm.js`, Apache-2.0 | Prevent double encoding of named parameters, preserve existing wildcard behavior; [exact sources, hashes, changes and verification](security/react-router-7-compatibility.md) |

Backstage's complete upstream NOTICE is retained verbatim for traceability. Its
Tech Radar and OpenAPI template notices are not assertions that those components
were adapted in this scaffold. Serverless's pinned license does not supply an
owner/year appendix; this project does not invent one.

### NCCL source reconciliation

The pinned Apache NSL template supplies the substantive launcher/worker layout,
MPI flags, environment, privileged init-limit sequence, shared memory, token and
service-link settings, and Running cleanup policy. Its original image is
`2.19.4-ubu22.04-cu12.2`; it requests 108 worker CPUs and 1200G worker memory
(with a 1600G limit). The local manifest uses the documented newer image,
96 CPUs, 1600G requests/limits and `UCX_NET_DEVICES=eth0`. These are functional
image/interface/resource choices, recorded separately from the Apache source.
Other local deltas are enumerated in the table and file header. The B200 overlay
uses the documented image and MPI `-mca coll ^hcoll` option. No upstream explanatory
prose is included or relicensed; matching a later docs example does not make that
whole page Apache-2.0. This comparison establishes an Apache antecedent, not a
claim about the documentation's historical authorship.

## References and functional influences

| Local material | Source/ref | Classification |
|---|---|---|
| `terraform/modules/{filestore,mk8s-cluster,node-group,o11y}`, `terraform/stacks/training` | NSL `k8s-training/` and module patterns at the baseline above | Declared influence and reusable API wrappers with local policy; no blanket claim that all local code belongs to Nebius |
| `terraform/stacks/nvl` | [NSL fba7148cecd8bd38bccf60ba194ab8f5fdb02194, k8s-training/gb300.tf](https://github.com/nebius/nebius-solutions-library/blob/fba7148cecd8bd38bccf60ba194ab8f5fdb02194/k8s-training/gb300.tf) | Separate NVLink/GB300 design reference, not the Soperator tag |
| `terraform/stacks/network/edge.tf` | NSL `wireguard/main.tf`, `modules/cloud-init/wireguard-cloud-init.tftpl` | VM/bootstrap concept; local key handling/firewall, no upstream web UI or UI units |
| `recipes/team-platform/skypilot` | [nebius-physical-ai c76fe41](https://github.com/nebius/nebius-physical-ai/blob/c76fe41/docs/orchestration/skypilot-setup.md) | SkyPilot/namespace concept; no substantial code match established |
| `workloads/kueue` | [Topology-aware scheduling](https://docs.nebius.com/kubernetes/gpu/topology-aware-scheduling) | Short topology labels/annotation settings; local queue/security/cleanup choices |
| `recipes/observability/grafana/datasources.yaml` | [Grafana integration](https://docs.nebius.com/observability/metrics/grafana) and source links in file | Documented endpoints/headers, local provisioning configuration |

## Documentation permissions and storage tuning

The [documentation catalog](reference/nebius-docs.md) contains extracted titles,
headings, hashes and links, rather than full prose. `scripts/nebius-docs.py`
can fetch raw pages into ignored `.cache/nebius-docs`; the portal can display
that optional mirror. Nebius's [AI access mechanisms](https://docs.nebius.com/docs-ai)
explain access, not a blanket Apache or Creative Commons republication license.
Keep source links. Before sharing full cached prose in an archive, portal, image
or public deployment, verify applicable permission and preserve its terms and
ownership; otherwise leave the cache out and use the external source links.
This repository does not supply a documentation republication grant.

The node-group bootstrap removes the optional documentation-derived virtiofs
read-ahead script and udev rule. It keeps the filesystem attachment, `nofail`
mount, FUSE loading, mount-directory creation and `mount -a`. Nodes use their
image/kernel default read-ahead instead of forcing 8192 KiB. Sequential-read
throughput may decrease; no performance equivalence or new live measurement is
claimed. Before adopting this bootstrap for a throughput-sensitive workload,
rerun the storage acceptance benchmark and size against measured results.
Operators may implement their own tuning after reviewing source permission and
validating it on their images; the removed docs script is not reformatted here.

## Dependency security backports

The three local braces, node-forge and elliptic Yarn runtime patches, their exact upstream
commits, the additional local Forge validation and retained licenses are recorded in
[dependency backports](security/dependency-backports.md). These are modified third-party
sources; they do not imply a published fixed package version or a passing registry audit.

## Conditional artifact distribution checklist

A source publication does not establish clearance for built images, browser
bundles, downloaded tools or a generated Soperator tree. Before distributing any
such artifact, record its exact versions, license texts/notices, source locations
and required source delivery/offer in the artifact review:

- **Source checkout:** include root LICENSE/NOTICE, this inventory and retained
  third-party license files. Preserve existing bundle and source headers.
- **Fetched Soperator tree:** retain its pinned root LICENSE and any upstream
  NOTICE alongside `soperator/` and `modules/`; keep local patch/modification
  records. Cone-mode sparse checkout includes root files by default. The fetcher
  checks the actual LICENSE instead of assuming sparse mode excluded it.
- **Toolbox image:** inventory every added binary as well as the base OS.
  ShellCheck 0.11.0 is GPLv3: satisfy applicable corresponding-source delivery or
  offer requirements. TFLint 0.64.0 is MPL-2.0: include its license and source
  availability notice. Terraform 1.16.5/1.12.2 are BSL-1.1: include their exact
  license and review additional use conditions; BSL is not a categorical ban on
  redistribution. Preserve the full jq COPYING and applicable Apache/MIT notices
  for kubectl, Trivy, Conftest, Gitleaks and other installed tools. Review the
  Nebius CLI's actual redistribution terms separately; no clearance is claimed.
- **Portal image/browser bundle:** inspect the production dependency graph and
  shipped assets, preserve their applicable licenses/notices, and expose a usable
  notices location with the browser distribution. `node_modules` being present
  during a build does not prove that a frontend release carries those notices.
- **Documentation cache:** exclude full mirrored pages unless redistribution or
  public display is authorized under applicable terms.

No built image, transitive dependency license inventory, corresponding-source
package, or Nebius CLI distribution permission has been verified by this source
change. Those gates apply when distributing those artifacts; keep the release
scope explicit and record the artifact-specific evidence before publication.
