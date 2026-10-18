# Load fixtures

Synthetic `tests/load/sweep.sh` logs for the offline self-test (`tests/load/selftest.sh`). The
`=== nip-bench` markers are what `sweep.sh` prints; the result blocks have the line layout of
`vllm bench serve` (pinned image), with made-up numbers. **No figure here is a measurement.**

| File | Shape |
|---|---|
| `sweep-pass.log` | first request, warm-up, points 1, 8, 32; every point inside the default bars |
| `sweep-slow.log` | the 32 point breaks the default E2E p99 bar (10 s), so the run fails at 32 and passes up to 8 |
| `sweep-partial.log` | 10 of 200 requests lost at 8, and the 32 point crashed (no result block) |
| `sweep-truncated.log` | `sweep-pass.log` cut before the 32 point (a killed container): 32 is reported as missing |
| `sweep-no-end.log` | `sweep-pass.log` without the `=== nip-bench end` marker: every point present, still incomplete |
| `sweep-low-fails.log` | `sweep-pass.log` with one tail outlier at concurrency 1 (TTFT p99 9.7 s, E2E p99 14.1 s, the shape of the 2026-10-12 R11 run): 1 fails the E2E bar, 8 and 32 pass |
| `sweep-tokenizer.log` | `sweep-pass.log` with the header of an R11 run whose model id is not a Hugging Face repo, benched with `--tokenizer` (`tokenizer=` in the params line) |
