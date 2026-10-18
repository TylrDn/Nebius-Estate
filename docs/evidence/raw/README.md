# Raw output of the prior validation runs

Verbatim output of prior runs of the upstream Nebius recipes (2026-10-07/08, uk-south1, one
preemptible B300 and `cpu-d3` presets). The summaries that cite these files are one level up in
[`docs/evidence/`](../README.md); billed totals are in [`costs.md`](../costs.md).

| Directory | Summary | Contents |
|---|---|---|
| [`2026-10-08-mk8s-b300/`](2026-10-08-mk8s-b300/) | [MK8s + B300 GPU smoke](../2026-10-08-mk8s-b300-gpu-smoke.md) | result log, `job.yaml` (the smoke Job), `run.sh` (how it was applied), `runs.md` (harness cost estimate) |
| [`2026-10-08-soperator-4.1.13/`](2026-10-08-soperator-4.1.13/) | [Soperator 4.1.13 CPU worker](../2026-10-08-soperator-4.1.13-cpu.md) | three result logs (runs 4, 5 and 7), `run.sh` (the `sbatch` check), `runs.md` (harness cost estimates, all seven runs) |
| [`2026-10-08-serverless-bench/`](2026-10-08-serverless-bench/) | [estimate only](../costs.md#runs-with-a-cost-estimate-only) | `runs.md` only |
| [`2026-10-07-filestore-fio/`](2026-10-07-filestore-fio/) | [estimate only](../costs.md#runs-with-a-cost-estimate-only) | `runs.md` only |

- **Scrubbed:** real resource IDs (`mk8scluster-…`, `computeinstance-…`) are `<redacted>`, public and
  private IPs are `<ip-redacted>`; gitleaks reports no leaks. Measured output is otherwise unchanged.
- **Paths inside these files** (`labs/…`, `vendor/…`, `.cache/labs/…`) refer to the lab harness that
  produced them, not to this repository. `vendor/` is the upstream `nebius-solutions-library` at tag
  `soperator-v4.1.13-2` (sha `d1c15caa37d330db88cb20bfef8dfceee4852032`).
- The scripts and manifest are method records, not part of this repo's tooling: they are not run by
  `make`, shellcheck or Trivy.
