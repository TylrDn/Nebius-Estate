# Three flagship paths

This experimental reference cookbook combines upstream infrastructure patterns with local policy,
lifecycle checks, measurement methods and a Backstage workspace. Choose a path below: explore the synthetic portal, inspect a measured inference run, or review
infrastructure lifecycle controls. The [cloud architecture](architecture.md) and
[portal architecture](portal/architecture.md) describe their ownership and request boundaries.
The wider R1–R16 and S1–S9 collection has uneven verification; use the dated
[recipe evidence table](../README.md#what-is-proven) rather than treating coverage as readiness.

## 1. Explore an invented estate without credentials

Follow the [synthetic demo setup](../portal/README.md#try-the-synthetic-demo): `make portal-install`,
`make doctor`, then `make portal-demo`, with Node.js 24 and Yarn installed. Package installation needs network access;
the demo needs no Nebius account or `.env`. It uses the REST stub on loopback and labels
every page **Test data — not your tenant**. Ctrl-C stops the services.

Explore Overview and Estate Explorer, inspect an unavailable connector, then open Costs and
Provisioning. A provisioning preview produces a patch and run sheet; it does not apply changes.
The local contribution is the domain model, connector/coverage reporting, policy-aware previews,
cost model and evidence UI on the Backstage scaffold. This development demo demonstrates workflow
and synthetic data, with no cloud-performance result. Served identity is still an
[integration task](portal/security.md#identity); the demo is not a production deployment.

## 2. Inspect the measured R1 inference path

Read the [inference stack](../terraform/stacks/inference/README.md),
[vLLM workload](../workloads/inference/README.md), and
[2026-10-13 evidence](evidence/2026-10-13-sandbox-r1-session.md) together. The evidence identifies
the checked commit and versions, method, failure and teardown. Its scrubbed
[benchmark result](../results/2026-10-13/bench-r1-operator-host.json) supports the serving figures.

One preemptible L40S served Qwen2.5-1.5B: 200/200 prompts answered at each of 1, 8 and 32
concurrent; E2E p99 was 0.85, 1.15 and 1.47 seconds against a 10-second bar. This was measured
from an operator host through a port-forward, with full-utilisation list-price assumptions.
The in-cluster benchmark failed to fetch its tokenizer; R14 acceptance was skipped.
It establishes no multi-GPU, larger-model or production result. Subsequent bootstrap/configuration
changes need another live run before reusing the historical storage or deployment figures.

The local contribution is the policy/lifecycle integration, bottom-up acceptance harness and explicit
measurement/evidence trail around upstream GPU and serving patterns. A new cloud run is billable:
use the [serving-only sandbox runbook](../runbooks/deploy.md#first-serving-only-sandbox), with its
approval, quota, spend and teardown requirements.

## 3. Follow R2 foundation and lifecycle boundaries

Read [Terraform foundations](../terraform/README.md), the
[stage × stack design](architecture.md), and the
[sandbox lifecycle evidence](evidence/2026-10-12-sandbox-session-lifecycle.md).
Per-stage identities and state boundaries support a reviewed bootstrap → plan → apply →
destroy-plan → destroy → leftovers sequence; stage policy and guarded scripts are local integration.

The October 12 record shows plan-scoped preflight, TTL jobs armed before three sandbox applies,
a teardown that stopped at a failed precondition and finished on rerun, and a clean stage gate.
All TTL jobs were cancelled after manual teardown: autonomous TTL execution was not proven.
Staging, production and federated pipeline apply are not established by that record.

## Source and release boundaries

The [source/change inventory](source-provenance.md) distinguishes adapted files from functional
influences; [NOTICE](../NOTICE) and [retained license texts](../third_party/README.md) preserve
third-party attribution. These links do not establish permission to redistribute cached upstream
documentation or generated images. This repository starts from a cleaned source snapshot; original development history and tags stay
private. The [verification record](release-readiness.md) distinguishes previously tested code from
publication edits that have not received another full container run.
