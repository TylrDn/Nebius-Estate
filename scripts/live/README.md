# scripts/live: owner-run live-session steps

Step scripts for the paid live runs 1-4 of
[`docs/plans/2026-10-12-live-runs.md`](../../docs/plans/2026-10-12-live-runs.md).
**How to run them, what each step proves, abort and teardown, and the 2026-10-12 lessons:
[`runbooks/live-session.md`](../../runbooks/live-session.md).**

Every script is executed (`bash scripts/live/<script>`) in a real terminal, never sourced. Session
state and logs go to the checkout's git-ignored `.cache/live/{state,logs}`; no id is written here (the
target comes from `.nip-targets/sandbox` or exported variables).

| File | Role |
|---|---|
| `lib.sh` | Shared helpers: target (`live_target`), `.env` by name (`env_get`), `load_env`, `boot`, TTL jobs (`ttl_arm`, `ttl_cancel` verbatim from the plan, `token_guard`, `ttl_status`), `preflight_go`, teardown helpers (`release_pvcs`, `registry_purge`, `wait_mlflow_released`), abort guards (`root_busy`, `state_lock`, `r6_endpoint_left`), Docker over SSH (`docker_ssh_env`) |
| `run1.sh` | Run 1: Token Factory bench (R11) |
| `run2-0-preflight.sh` … `run2-11-leftovers.sh` | Run 2 steps, in plan order |
| `run2-all.sh` | Run 2 in one command (rules in the runbook) |
| `run-r1.sh` | R1-only session in one command: R1 with its own filestore (no R8/R12), 00-05, R14, R5 (`R5=0` leaves it out), teardown, leftovers gate; `R10_TOO=1` adds run 3 after R1's teardown |
| `A4-r13-federated-apply.sh` | Z5: the R13 federated CI apply (dispatch, watch, report), its local teardown, then the sandbox CI key retirement on a typed `RETIRE` |
| `lib-lab.sh`, `run4-r7.sh`, `run4-r4.sh` | Run 4 in the `lab` stage (nip-lab, uk-south1): R7 network, then R4 Soperator, one command each |
| `run2-watch-bench.sh` | Second-terminal watch of the bench pod (read-only) |
| `run3-2-plan.sh` … `run3-5-teardown.sh` | Run 3: R10 GPU VM bench |
| `abort.sh` | Emergency stop: tears down every sandbox root with state |
| `refresh-login.sh` | Fresh CLI login so new TTL jobs inherit a long-lived token |
| `estate-check.sh` | What the live Nebius Estate portal shows for a run (read-only) |
| `A1-…`, `A2-…`, `A3-…`, `L0-…` | Zero-cost owner tasks and the portal outage test (`L0`: create the nip-lab project) |
| `bin/aws` | The AWS CLI in a pinned container, for the R8 restore drill |

Tests: `tests/scripts/test-live-lib.sh`, `test-live-batch.sh`, `test-live-r1.sh`, `test-live-r13.sh`, `test-live-lab.sh` (`make selftest`).
