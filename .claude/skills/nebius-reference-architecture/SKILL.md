---
name: nebius-reference-architecture
description: This skill should be used when the user asks to "design a solution on Nebius", "propose an architecture", "write a solution S-n", "compose recipes for a customer", "compare alternatives", or needs the nine-section design the project policy requires before implementing a substantial change.
---

# Nebius reference architecture

Produce a design that composes this repository's recipes, follows the project policy in
`AGENTS.md`, and meets the Solution definition of done in
`docs/design/2026-10-11-solutions-and-recipes.md`.

## Inputs

A discovery note (see `nebius-discovery`). If none exists, run discovery first; do not design on
guesses.

## Procedure

1. Pick the recipes to compose from `docs/building-blocks.md` and the Solutions index in
   `solutions/README.md`. Reuse a stack before proposing a new one.
2. Check the relevant decisions in `docs/decisions/` (ADR-0001 Kubernetes vs serverless,
   0002 topology, 0003 driver ownership, 0004 storage, 0007 capacity types, 0008 Slurm,
   0009 environments). A design that contradicts an ADR proposes a new ADR from `0000-template.md`.
3. Confirm every platform, preset, region and service in `platform/regions.yaml` and
   `docs/solutions/regions.md`; confirm provider resources with Terraform MCP against the pinned
   provider in `platform/versions.yaml`.
4. Write the nine sections below. Diagrams use Mermaid. Every claim links a docs anchor that exists
   in `docs/reference/nebius-docs.json` (`make docs-links` enforces this).
5. Apply names and labels from `docs/naming.md` (`nip-<stage>-<stack>`, `nip-*` labels).
6. Hand off: Terraform changes go through `nebius-terraform-review`; acceptance through
   `nebius-poc-acceptance`; numbers through `nebius-commercial-assumptions`.

## The nine sections

1. Requirements and assumptions (from discovery; facts vs assumptions vs open questions)
2. Architecture diagram (Mermaid; stages, projects, networks, clusters, storage, identities)
3. Component and dependency mapping (recipe ids, stacks, modules, Marketplace releases, docs)
4. Alternatives and tradeoffs (at least one alternative; cite the ADR it touches)
5. Security and operational risks (`docs/security.md` checklist; blast radius from
   `docs/change-management.md`)
6. Terraform/Helm implementation plan (stack inputs per stage, quotas from `docs/capacity.md`,
   commands from `runbooks/deploy.md`; plan only, never apply)
7. PoC acceptance tests (`tests/validate/*`, `docs/slo.md` targets)
8. Cost assumptions and missing commercial inputs (calculator-priced, dated, "not a quote")
9. Handoff and rollback runbook (`runbooks/rollback.md`, `runbooks/teardown.md`)

## Where solutions live

`solutions/S<n>-<slug>/README.md` (index: `solutions/README.md`). Nothing ships as a draft: a solution meets the definition of done
or goes in the backlog table of the design document with its blocking reason.
