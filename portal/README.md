# Nebius Estate

A self-hosted workspace for this repository's Nebius estate, built on [Backstage](https://backstage.io)
1.55 (release 1.55.3). It covers inventory with honest coverage, GPU capacity versus demand versus utilisation, workloads,
policy-aware provisioning previews, FOCUS cost reporting, commercial scenarios and draft quotes, and the
repository's evidence and runbooks.

It **reads and explains; it never applies.** There is no terraform, no shell and no workflow dispatch
from the browser. Every cloud call is read-only.

## Try the synthetic demo

From the repository root, use Node.js 24 (see `portal/.nvmrc`) and Yarn (`corepack enable`).
Package installation requires network access; cloud credentials are unnecessary.

```bash
make portal-install          # install dependencies first; no cloud access
make doctor                  # read-only prerequisites, ports and browser-cache checks
make portal-demo             # http://localhost:3100; Ctrl-C cleans up services
```

This independent project demonstrates an invented estate through the existing REST stub.
Every route displays **Test data — not your tenant**. It requires no `.env`, Nebius account,
private overlay or live credentials. Children receive only an allowlisted environment and fixed
placeholder tokens; the operator's cloud credentials, proxies and Node hooks are discarded.
The app, backend and stub use loopback ports 3100, 7107 and 7199. Occupied ports fail before
starting; startup readiness is bounded and failures stop the process groups. Demo budgets,
imports and scenarios are held in memory and disappear on exit. This is a development build,
so the first startup includes compilation; it is not measured cloud evidence or a production setup.

For a guided first visit, follow the [five-step demo tour](../docs/portfolio.md#five-step-demo-tour).
Docker and a Playwright browser download are optional for this native development demo.
`make doctor` reports those as optional; `node portal/scripts/doctor.mjs --full` requires them.
Browser tests install Chromium separately (`cd portal && yarn playwright install chromium`).

## Run against your projects

```bash
# Node.js 24 (.nvmrc), and `corepack enable` (or any yarn on PATH)
make portal-install           # from the repository root
set -a; source .env; set +a   # optional: NEBIUS_PROJECT_IDS and a read-only identity (.env.example)
make portal-dev               # http://localhost:3000 (app-config.yaml + app-config.local.yaml)
```

It runs against your real projects, read-only, on this machine only (the backend binds `127.0.0.1`
and you are signed in as a local guest). Without credentials it still starts: every connector shows
as not configured and every number as unavailable, never as zero. Nothing is simulated and nothing
is pre-loaded: billing comes from FOCUS imports, prices from rate books you add. Setup:
[docs/portal/nebius-setup.md](../docs/portal/nebius-setup.md). A served deployment uses
`app-config.production.yaml` and still requires authentication integration; see the
[identity limitations](../docs/portal/security.md#identity). Review the
[known dependency advisories](../docs/dependency-security.md) before any shared deployment.

Sixteen pages in four nav groups. Every page carries the "Read-only to Nebius" badge (it saves only its
own budgets, scenarios, rate books and imports) and, on a run against the test stub, a "Test data — not
your tenant" banner that a live run never shows.

| Group | Page | What it answers |
|---|---|---|
| Operate | Overview | Independently sourced numbers; missing sources show as Unavailable, never 0 |
| Operate | Estate Explorer | Graph + table of discovered resources, relationships from explicit fields only; TTL-expired, orphan-candidate and unattributed views; desired state vs. snapshot |
| Operate | GPU & Capacity | Present GPUs, quotas and capacity allowances, reservations and capacity advice (when permitted), platforms, node-group bounds, pod requests, stage caps, min/expected/max calculator |
| Operate | Fleet | Per-GPU telemetry from Nebius Monitoring over 1 h to 7 d; unobserved time drawn as such, never as 0; idle-GPU cost as an estimate |
| Operate | Alerts | `platform/alerts` rules evaluated after each sync, with state, firing-since and a guided fix from the runbooks |
| Operate | Logs | Nebius Logging buckets and labels; LogQL within the documented limits, read on demand |
| Operate | Workloads | Configured clusters only: workloads, requests and limits, scheduling messages, events; Slurm state shown as unavailable |
| Operate | AI services | Token Factory and Hugging Face access and models, Serverless AI endpoints and jobs |
| Change | Provisioning | Sandbox inference, training capacity and Soperator lab: validate against `platform/stages.yaml`, preview the tfvars diff, estimate, prepare a reviewed change, download the patch (you open the pull request) |
| Finance | Costs | FOCUS reports by project, service, region, resource, charge category or label; lag and completeness; CSV export; imports |
| Finance | Commercial Scenarios | Live Nebius list prices next to user rate books (negotiated, what-if); scenarios and draft quotes with coverage and sensitivity |
| Finance | Budgets & credits | Advisory budgets and credits counted against the FOCUS actual, with a separate projected line and alerts |
| Assurance | Evidence & Runbooks | Mocked plan tests, static checks, upstream live runs, this repo's live runs and unmeasured claims, kept apart; the R1–R16 recipe list with what each has proven, runbooks and evidence rows; runbooks and ADRs |
| Assurance | Solutions | S1–S9 with their composed recipes and status, and "Price this footprint" |
| Assurance | Nebius docs | Search the committed documentation catalog, inspect coverage, and follow links to the official source |
| Assurance | Integrations & Coverage | Every API call this identity makes, with its state, health and what to grant when refused; connectors; the capability matrix |

## Documentation

- [Architecture](../docs/portal/architecture.md)
- [Security](../docs/portal/security.md)
- [Capability matrix](../docs/portal/capability-matrix.md)
- [Live setup (Nebius, Kubernetes, telemetry)](../docs/portal/nebius-setup.md)
- [Billing and pricing](../docs/portal/billing-and-pricing.md)
- [Development](../docs/portal/development.md)
- [Acceptance checklist](../docs/portal/acceptance-checklist.md)

Licences: [NOTICE.md](NOTICE.md).
