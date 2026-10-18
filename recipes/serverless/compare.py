#!/usr/bin/env python3
"""Merge lab and serverless results into docs/evidence/<date>-serverless-comparison.md.

Reads results/04-workload.json, results/05-load.json and results/serverless-*.json. The load
results on both sides have the tests/load shape (nip-bench/1): the table has one row per
concurrency point either sweep ran (a point only one side ran prints "not measured" on the other),
and a "Like-for-like" row that says yes only when the generator ran in-region on both sides, the
endpoint and both generators are in the lab's region (recorded: 05-load `region`, endpoint
`endpoint_region` / `generator_region`), and the image, model and sweep params match (input_len,
output_len, num_prompts, warmup_prompts; the concurrency lists may differ, since each row compares
one concurrency point); otherwise it says no and why. Missing or failed steps produce "not measured",
never a made-up number (P6).

    python3 recipes/serverless/compare.py [--results DIR] [--out FILE]
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NM = "not measured"
# Where the load generator ran (tests/load/README.md, "Result"). Only these count as in-region.
IN_REGION = {"in-cluster", "in-region-cluster-job", "in-vpc"}


def load(res: Path, name: str) -> dict:
    """Details of a step, but only when it passed: a failed run's partial numbers are not evidence."""
    p = res / name
    if not p.exists():
        return {}
    doc = json.loads(p.read_text())
    return doc.get("details", {}) if doc.get("status") == "pass" else {}


def g(d: dict, *keys, default=NM):
    for k in keys:
        if not isinstance(d, dict) or k not in d:
            return default
        d = d[k]
    return d if d not in ("", None) else default


def like_for_like(lab: dict, ep: dict) -> str:
    """yes | no: <reasons> | not measured."""
    if not lab or not ep:
        return NM
    why = []
    for side, d in (("Kubernetes lab", lab), ("endpoint", ep)):
        v = d.get("vantage", "unknown")
        if v not in IN_REGION:
            where = "the operator host (WAN)" if v == "operator-host" else f"'{v}'"
            why.append(f"{side} generator ran from {where}, not in-region")
    for k in ("image", "model"):
        if lab.get(k) != ep.get(k):
            why.append(f"{k} differs ({lab.get(k)} vs {ep.get(k)})")
    lr, er, gr = lab.get("region"), ep.get("endpoint_region"), ep.get("generator_region")
    if not lr or not er:
        why.append(f"region not recorded on both sides (lab {lr or 'unknown'}, endpoint {er or 'unknown'}): "
                   "set NEBIUS_REGION for endpoint.sh create; the lab's comes from the nodes' topology.kubernetes.io/region")
    elif lr != er:
        why.append(f"endpoint in {er}, lab in {lr}")
    if ep.get("vantage") == "in-region-cluster-job" and lr and gr != lr:
        why.append(f"endpoint generator ran in {gr or 'an unrecorded region'}, not the lab's {lr}")
    lp, epp = lab.get("params", {}), ep.get("params", {})
    for k in ("input_len", "output_len", "num_prompts", "warmup_prompts"):
        if lp.get(k) != epp.get(k):
            why.append(f"sweep {k} differs ({lp.get(k)} vs {epp.get(k)})")
    return "yes" if not why else "no: " + "; ".join(why)


def points(d: dict) -> dict:
    return {p["concurrency"]: p for p in d.get("points", [])}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--results", type=Path, default=ROOT / "results")
    ap.add_argument("--out", type=Path, default=ROOT / "docs" / "evidence" / f"{date.today()}-serverless-comparison.md")
    a = ap.parse_args(argv)
    res = a.results
    lab_w, lab_l = load(res, "04-workload.json"), load(res, "05-load.json")
    ep_c, ep_m, job = load(res, "serverless-endpoint-create.json"), load(res, "serverless-endpoint-measure.json"), load(res, "serverless-job.json")
    rows = [
        ("Image", g(lab_w, "image"), g(ep_c, "image"), g(job, "image")),
        ("Model", g(lab_w, "model"), g(ep_c, "model"), g(job, "model")),
        ("Preset", "see results/summary.json", g(ep_c, "preset"), g(job, "preset")),
        ("Generator vantage", g(lab_l, "vantage"), g(ep_m, "vantage"), "n/a (offline throughput in the job)"),
        ("Region", g(lab_l, "region"),
         f'{g(ep_m, "endpoint_region")} (generator {g(ep_m, "generator_region")})' if ep_m else NM, "n/a"),
        ("Like-for-like", like_for_like(lab_l, ep_m), "", ""),
        ("Cold start / startup (s)", g(lab_w, "startup_seconds"), g(ep_c, "cold_start_seconds"), g(job, "wall_seconds_create_to_end")),
        ("First request after start-up (ms)", g(lab_w, "first_request_ms"), g(ep_m, "first_request_ms"), "n/a"),
        ("First sweep request (ms, after a probe: not cold)", g(lab_l, "first_sweep_request_ms"), g(ep_m, "first_sweep_request_ms"), "n/a"),
    ]
    lp, ep = points(lab_l), points(ep_m)
    for c in sorted(set(lp) | set(ep)):
        a_, b_ = lp.get(c, {}), ep.get(c, {})
        rows += [
            (f"Requests/s @ {c}", g(a_, "requests_per_s"), g(b_, "requests_per_s"), "n/a"),
            (f"Output tokens/s @ {c}", g(a_, "output_tokens_per_s"), g(b_, "output_tokens_per_s"), "n/a"),
            (f"TTFT p50 / p99 (ms) @ {c}", f'{g(a_,"ttft_ms","p50")} / {g(a_,"ttft_ms","p99")}' if a_ else NM,
             f'{g(b_,"ttft_ms","p50")} / {g(b_,"ttft_ms","p99")}' if b_ else NM, "n/a"),
            (f"E2E p50 / p99 (ms) @ {c}", f'{g(a_,"e2e_ms","p50")} / {g(a_,"e2e_ms","p99")}' if a_ else NM,
             f'{g(b_,"e2e_ms","p50")} / {g(b_,"e2e_ms","p99")}' if b_ else NM, "n/a"),
            (f"$ per 1M output tokens @ {c}", g(a_, "cost_per_1m_output_tokens_usd"), g(b_, "cost_per_1m_output_tokens_usd"), "n/a"),
        ]
    rows += [
        ("Max concurrency within the bars", g(lab_l, "max_passing_concurrency"), g(ep_m, "max_passing_concurrency"), "n/a"),
        ("Output tokens/s (job, offline)", "n/a", "n/a", g(job, "output_tokens_per_s")),
        ("GPU util during run", g(lab_l, "gpu_util_pct_during_run", "mean"), "not exposed", "not exposed"),
        ("Operating scope", "cluster, node group, drivers, CSI, o11y, rollouts", "image + command + auth", "image + command + timeout"),
        ("Cost inputs", "BENCH_USD_PER_HOUR (docs/cost.md worksheet)", "BENCH_USD_PER_HOUR (console rate)", "fill from console rate"),
    ]
    out = ["# Kubernetes vs. Serverless — measured comparison", "",
           f"Generated {date.today()} by `recipes/serverless/compare.py` from `results/`. Method: `tests/load/README.md`.", "",
           "| Metric | Kubernetes lab | Serverless endpoint | Serverless job |", "|---|---|---|---|"]
    out += [f"| {a_} | {b_} | {c_} | {d_} |" for a_, b_, c_, d_ in rows]
    out += ["", "Like-for-like means both generators ran in-region (the lab Job in the cluster; the endpoint measured with "
            "`MEASURE_FROM=cluster endpoint.sh measure`, a Job in the same cluster), the endpoint is in the lab's region, "
            "and the image, model and sweep params (prompt and output length, prompts, warm-up) match. "
            "A run from the operator host includes WAN latency and is not comparable point by point.",
            "", "Even like-for-like, the network paths differ: the lab is measured against its in-cluster Service over plain HTTP, "
            "the endpoint through its managed https:// URL, which leaves the cluster (egress, TLS, the endpoint's load balancer). "
            "Some of any latency gap is that path, not the serving stack.",
            "", "The endpoint is measured through its managed https:// URL, which is capped at 80 Mbps and 300 client "
            "connections per endpoint (400 Mbps / 1,500 per project; docs.nebius.com/serverless/endpoints/manage"
            "#traffic-and-connection-limits); the Kubernetes lab has no such cap, so even a like-for-like run "
            "compares capped against uncapped at high concurrency.",
            "", "No claim here applies to other models, presets or regions. Re-run both sides before quoting (P6).", ""]
    dst = a.out
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text("\n".join(out))
    print(f"wrote {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
